"""
Copy every collection of a MongoDB database into PostgreSQL (Supabase).

MongoDB is only READ; nothing is modified or deleted there.

Env vars:
  MONGO_URI   mongodb+srv://...
  MONGO_DB    default: reverse_logistics_db
  PG_URI      postgresql://postgres.<ref>:<password>@<host>:5432/postgres   (Supabase)

Usage:
  python migrate_mongo_to_postgres.py --dry-run     # write schema.sql only, no Postgres needed
  python migrate_mongo_to_postgres.py               # create tables + load data + verify

Mapping: one table per collection, one column per field.
  str -> text, int -> bigint, float/int mix -> double precision, bool -> boolean,
  datetime -> timestamptz, ObjectId -> text, dict/list -> jsonb.
  `_id` is kept as the primary key (text). Re-running is safe (ON CONFLICT DO NOTHING).
"""
import argparse, datetime as dt, json, os, re, sys
from bson import ObjectId
from bson.decimal128 import Decimal128
from pymongo import MongoClient

MONGO_URI = os.environ["MONGO_URI"]
MONGO_DB = os.environ.get("MONGO_DB", "reverse_logistics_db")
BATCH = 500


def ident(name: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z_]+", "_", name.strip()).strip("_").lower()
    if not s or s[0].isdigit():
        s = "c_" + s
    return s


def jsonable(v):
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, (ObjectId, Decimal128)):
        return str(v)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.hex()
    return v


def pg_type(types: set) -> str:
    t = types - {"NoneType"}
    if not t:
        return "text"
    if t <= {"bool"}:
        return "boolean"
    if t <= {"int"}:
        return "bigint"
    if t <= {"int", "float"}:
        return "double precision"
    if t <= {"str", "ObjectId"}:
        return "text"
    if t <= {"datetime"}:
        return "timestamptz"
    if t <= {"dict", "list"}:
        return "jsonb"
    return "jsonb"  # mixed types: keep the exact value


def convert(v, typ):
    if v is None:
        return None
    if typ == "jsonb":
        return json.dumps(jsonable(v))
    if isinstance(v, ObjectId):
        return str(v)
    if typ == "timestamptz" and isinstance(v, dt.datetime) and v.tzinfo is None:
        return v.replace(tzinfo=dt.timezone.utc)
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    db = MongoClient(MONGO_URI, serverSelectionTimeoutMS=20000)[MONGO_DB]

    plans = []  # (collection, table, {mongo_key: (col, type)}, ddl)
    used_tables = set()
    for coll in sorted(db.list_collection_names()):
        if coll.startswith("system."):
            continue
        table = ident(coll)
        while table in used_tables:
            table += "_"
        used_tables.add(table)

        # pass 1: infer types of every field across ALL documents
        seen = {}
        for d in db[coll].find():
            for k, v in d.items():
                seen.setdefault(k, set()).add(type(v).__name__)
        cols, taken = {}, set()
        for k in seen:
            if k == "_id":
                cols[k] = ("_id", "text")
                taken.add("_id")
                continue
            c = ident(k)
            if c == "id" or c == "":
                c = "f_" + c
            if c in taken:  # e.g. " product_collected_at" vs "product_collected_at"
                base = next(kk for kk, (cc, _) in cols.items() if cc == c)
                seen[base] |= seen[k]
                cols[k] = (c, None)  # merged into existing column
                continue
            taken.add(c)
            cols[k] = (c, None)
        for k in cols:
            c, _ = cols[k]
            if k != "_id":
                cols[k] = (c, pg_type(seen[next(kk for kk, (cc, _) in cols.items() if cc == c)]))
        col_defs = ['"_id" text PRIMARY KEY'] + [
            f'"{c}" {t}' for k, (c, t) in cols.items() if k != "_id" and not any(
                False for _ in [])
        ]
        # de-duplicate column definitions (merged keys)
        seen_cols, dedup = set(), []
        for d_ in col_defs:
            name = d_.split()[0]
            if name not in seen_cols:
                seen_cols.add(name)
                dedup.append(d_)
        ddl = f'CREATE TABLE IF NOT EXISTS public."{table}" (\n  ' + ",\n  ".join(dedup) + "\n);\n" \
              f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY;\n'
        plans.append((coll, table, cols, ddl))

    with open("schema.sql", "w", encoding="utf-8") as f:
        f.write("-- generated from MongoDB; RLS enabled (no policies) so the public API cannot read these tables\n")
        f.write("\n".join(p[3] for p in plans))
    print(f"schema.sql written ({len(plans)} tables)")
    if args.dry_run:
        return

    import psycopg
    pg = psycopg.connect(os.environ["PG_URI"], autocommit=False)
    cur = pg.cursor()
    report = []
    for coll, table, cols, ddl in plans:
        cur.execute(ddl)
        pg.commit()
        # unique column order
        order, seen_c = [], set()
        for k, (c, t) in cols.items():
            if c not in seen_c:
                seen_c.add(c)
                order.append(c)
        ctype = {c: t for k, (c, t) in cols.items()}
        collist = ", ".join(f'"{c}"' for c in order)
        ph = ", ".join(
            "%s::jsonb" if ctype[c] == "jsonb" else "%s" for c in order)
        sql = f'INSERT INTO public."{table}" ({collist}) VALUES ({ph}) ON CONFLICT ("_id") DO NOTHING'
        batch, n = [], 0
        for d in db[coll].find():
            row = {}
            for k, v in d.items():
                c, t = cols[k]
                if c in row and row[c] is not None:
                    continue
                row[c] = convert(v, ctype[c])
            row["_id"] = str(d["_id"])
            batch.append([row.get(c) for c in order])
            if len(batch) >= BATCH:
                cur.executemany(sql, batch); pg.commit(); n += len(batch); batch = []
        if batch:
            cur.executemany(sql, batch); pg.commit(); n += len(batch)
        cur.execute(f'SELECT count(*) FROM public."{table}"')
        pg_n = cur.fetchone()[0]
        mongo_n = db[coll].count_documents({})
        report.append((coll, table, mongo_n, pg_n))
        print(f"{'OK ' if mongo_n == pg_n else 'DIFF'} {coll!r:55} -> {table:45} mongo={mongo_n} pg={pg_n}")
    bad = [r for r in report if r[2] != r[3]]
    print("\nALL COUNTS MATCH" if not bad else f"\n{len(bad)} collections differ")
    pg.close()


if __name__ == "__main__":
    sys.exit(main())
