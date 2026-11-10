import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { q, one } from "../db/client";
import { createEmbedder, getProvider, sleep } from "../llm/factory";

const G = globalThis as any;
export const vec = (v: number[]) => "[" + v.join(",") + "]";

export const policyToText = (p: any) =>
  `Policy "${p.policy_name}" (${p.policy_rule_id}) for category ${p.category}. Return window: ${p.return_window_days} days. ` +
  `Allowed return reasons: ${(p.allowed_conditions || []).join(", ")}. Original packaging required: ${p.packaging_required ? "yes" : "no"} (${p.seal_requirement}). ` +
  `Accessories required: ${p.accessories_required ? "yes" : "no"}. Refund allowed: ${p.refund_allowed ? "yes" : "no"}. ` +
  `Replacement allowed: ${p.replacement_allowed ? "yes" : "no"}. Exchange allowed: ${p.exchange_allowed ? "yes" : "no"}. ` +
  `High-risk requests need manual review: ${p.high_risk_requires_manual_review ? "yes" : "no"}. Active: ${p.active ? "yes" : "no"}. Effective from ${p.effective_from}.`;

export const productToText = (p: any) =>
  `Product ${p.product_name} (${p.product_id}), brand ${p.brand}, category ${p.category} / ${p.subcategory}. ${p.description || ""} ` +
  `Returnable: ${p.returnable ? "yes" : "no"}. Replacement allowed: ${p.replacement_allowed ? "yes" : "no"}. Exchange allowed: ${p.exchange_allowed ? "yes" : "no"}. Warranty: ${p.warranty_days} days.`;

export async function embedDocumentsWithRetry(texts: string[]): Promise<number[][]> {
  const e = createEmbedder();
  const out: number[][] = [];
  const size = getProvider() === "gemini" ? 25 : 50;
  for (let i = 0; i < texts.length; i += size) {
    const part = texts.slice(i, i + size);
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await e.embedDocuments(part)));
        break;
      } catch (err: any) {
        const m = /retry in ([\d.]+)s/i.exec(err.message || "");
        if (/429|quota|rate/i.test(err.message || "") && attempt < 5)
          await sleep(((m ? +m[1] : 30) + 2) * 1000);
        else throw err;
      }
    }
    if (getProvider() === "gemini" && i + size < texts.length) await sleep(30000);
  }
  return out;
}

export async function embedQueryWithRetry(text: string): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createEmbedder().embedQuery(text);
    } catch (err: any) {
      const m = /retry in ([\d.]+)s/i.exec(err.message || "");
      if (/429|quota|rate/i.test(err.message || "") && attempt < 3)
        await sleep(Math.min((m ? +m[1] : 10) + 1, 20) * 1000);
      else throw err;
    }
  }
}

export async function upsertKnowledgeBase(rows: { source: string; id: string; content: string }[]) {
  if (!rows.length) return;
  const prov = getProvider();
  const vs = await embedDocumentsWithRetry(rows.map((r) => r.content));
  for (let j = 0; j < rows.length; j++) {
    if (!vs[j]?.length) continue;
    await q(
      `insert into app_kb(source,source_id,content,embedding,provider) values($1,$2,$3,$4::vector,$5)
       on conflict(source,source_id) do update set content=excluded.content,embedding=excluded.embedding,provider=excluded.provider,updated_at=now()`,
      [rows[j].source, rows[j].id, rows[j].content, vec(vs[j]), prov]
    );
  }
}

export async function indexProductsBackground() {
  if (G.__kbBg) return;
  G.__kbBg = true;
  try {
    const have = new Set(
      (await q("select source_id from app_kb where source='product' and provider=$1", [getProvider()])).map(
        (r: any) => r.source_id
      )
    );
    const todo = (await q("select * from products where active is not false")).filter(
      (p: any) => !have.has(p.product_id)
    );
    await upsertKnowledgeBase(todo.map((p: any) => ({ source: "product", id: p.product_id, content: productToText(p) })));
  } catch (e: any) {
    console.error("product indexing failed:", e.message);
  } finally {
    G.__kbBg = false;
  }
}

export async function reindexKnowledgeBase() {
  const pol = await q("select * from policy_rules");
  await q("delete from app_kb");
  await upsertKnowledgeBase(pol.map((p: any) => ({ source: "policy", id: p.policy_rule_id, content: policyToText(p) })));
  indexProductsBackground();
  return { policies: pol.length, products: "indexing in background" };
}

export async function ensureKnowledgeBase() {
  const r = await one("select count(*)::int n from app_kb where source='policy' and provider=$1", [getProvider()]);
  if (r.n === 0) await reindexKnowledgeBase();
  else indexProductsBackground();
}

export async function searchKnowledgeBase(query: string, k = 5) {
  await ensureKnowledgeBase();
  const v = await embedQueryWithRetry(query);
  return q(
    `select source,source_id,content,1-(embedding <=> $1::vector) sim from app_kb where provider=$2 order by embedding <=> $1::vector limit $3`,
    [vec(v), getProvider(), k]
  );
}

export const createRagTool = (steps: string[], grounding: string[]) =>
  tool(
    async ({ query }: any) => {
      const r = await searchKnowledgeBase(query, 5);
      steps.push("tool:search_knowledge");
      const txt = r
        .map((x: any) => `[${x.source}:${x.source_id} sim=${Number(x.sim).toFixed(2)}] ${x.content}`)
        .join("\n");
      grounding.push(txt);
      return txt;
    },
    {
      name: "search_knowledge",
      description: "Semantic search over return policies and the product catalogue (RAG).",
      schema: z.object({ query: z.string() }),
    }
  );

