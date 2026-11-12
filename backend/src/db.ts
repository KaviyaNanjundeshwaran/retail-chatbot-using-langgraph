import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { env } from "./config";
import { CASE_ID_PATTERN } from "./domain";

const ssl = { verify: true, "no-verify": { rejectUnauthorized: false }, disable: false }[env.PG_SSL];

export const pool = new Pool({ connectionString: env.PG_URI, ssl, max: env.PG_POOL_MAX });

export const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
export const one = async <T = any>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

/** LangGraph's Postgres checkpointer on the shared pool: short-term memory (one thread per chat session). */
export const createCheckpointer = () => new PostgresSaver(pool);

/** LangGraph's Postgres Store: long-term memory shared across a customer's conversations. It manages its own small pool. */
export const createStore = () => new PostgresStore({ connectionOptions: { connectionString: env.PG_URI, ssl, max: 2 }, ensureTables: false });

const CASE_TABLES = ["return_requests", "refund_requests", "replacement_requests"];
const APP_TABLES = ["app_admins", "app_chat_sessions", "app_escalations"];

/**
 * One-time schema setup, run at deploy time with `npm run db:setup` (not on every start, per the LangGraph
 * persistence docs). Idempotent. Business tables (customers, orders, policy_rules, ...) come from the migration script.
 */
export async function setupDatabase() {
  await q(`create table if not exists app_admins(
    id serial primary key, email text unique not null, name text, password_hash text not null, created_at timestamptz default now())`);
  await q(`create table if not exists app_chat_sessions(
    customer_id text not null, session_id text not null, title text not null,
    created_at timestamptz default now(), updated_at timestamptz default now(), primary key(customer_id, session_id))`);
  await q(`create table if not exists app_escalations(
    id bigserial primary key, escalation_id text unique not null, customer_id text not null, session_id text not null,
    reason text, summary text, case_id text, notified_at timestamptz default now(), status text default 'OPEN',
    resolved_at timestamptz, resolved_by text, notes text)`);
  await q("alter table app_escalations add column if not exists notify_status text");
  // Supabase exposes public tables over PostgREST; RLS with no policies keeps these server-only.
  for (const t of APP_TABLES) await q(`alter table ${t} enable row level security`);

  // Case ids come from a sequence so concurrent requests can never get the same id.
  await q("create sequence if not exists app_case_seq");
  const maxExisting = CASE_TABLES.map(
    (t) => `select coalesce(max(substring(case_id from 5)::int), 0) n from ${t} where case_id ~ '${CASE_ID_PATTERN}'`
  ).join(" union all ");
  await q(`select setval('app_case_seq', greatest(m, 1), m > 0) from (select max(n) m from (${maxExisting}) s) x`);

  // One-time carry-over of the session list from the old app_chat_messages table (messages themselves live in the checkpointer).
  if ((await one("select to_regclass('app_chat_messages') t")).t)
    await q(`insert into app_chat_sessions(customer_id,session_id,title,created_at,updated_at)
      select customer_id, session_id, left(coalesce((array_agg(content order by id) filter (where role='user'))[1], 'Chat'), 80), min(created_at), max(created_at)
      from app_chat_messages group by customer_id, session_id
      on conflict do nothing`);

  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD)
    await q("insert into app_admins(email,name,password_hash) values($1,'Administrator',$2) on conflict(email) do nothing", [
      env.ADMIN_EMAIL.toLowerCase(),
      await bcrypt.hash(env.ADMIN_PASSWORD, 10),
    ]);

  await createCheckpointer().setup();
  const store = createStore();
  await store.setup();
  await store.stop();
}

/** Startup check: the database is reachable and has been set up. */
export async function checkDatabase() {
  const row = await one(
    `select ${[...APP_TABLES, "checkpoints", "store"].map((t, i) => `to_regclass('${t}') is not null t${i}`).join(", ")},
            to_regclass('app_case_seq') is not null seq,
            exists(select 1 from information_schema.columns where table_name='app_escalations' and column_name='notify_status') col`
  );
  if (Object.values(row).some((v) => !v)) throw new Error("Database is not set up (or is out of date). Run: npm run db:setup");
}
