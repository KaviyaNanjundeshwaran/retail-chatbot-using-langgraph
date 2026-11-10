import { q, one, getSetting } from "../db/client";
import { getProvider } from "../llm/factory";
import { embedQueryWithRetry, vec } from "../rag/knowledge";

export async function lookupSemanticCache(cleanedText: string, profileFirstName: string) {
  const c = await getSetting("cache");
  const personal = /\b(my|mine|ord\d|case\d|prod\d)/i.test(cleanedText);
  if (!c.enabled || personal) return { hit: false };

  const v = vec(await embedQueryWithRetry(cleanedText));
  const r = await one(
    `select id,answer,1-(embedding <=> $1::vector) sim from app_cache where provider=$2 and created_at > now() - ($3 || ' hours')::interval
     order by embedding <=> $1::vector limit 1`,
    [v, getProvider(), String(c.ttl_hours)]
  );

  if (r && r.sim >= c.threshold) {
    await q("update app_cache set hits=hits+1 where id=$1", [r.id]);
    const answer = String(r.answer).split("{{name}}").join(profileFirstName || "there");
    return { hit: true, answer };
  }
  return { hit: false };
}

export async function saveSemanticCache(question: string, answer: string, namesToNeutralize: (string | undefined)[]) {
  const c = await getSetting("cache");
  if (!c.enabled) return;
  const v = vec(await embedQueryWithRetry(question));
  let neutral = answer;
  for (const n of namesToNeutralize.filter(Boolean)) {
    neutral = neutral.split(n!).join("{{name}}");
  }
  await q(
    "insert into app_cache(question,answer,embedding,provider) values($1,$2,$3::vector,$4)",
    [question, neutral, v, getProvider()]
  );
}

export async function clearSemanticCache() {
  await q("delete from app_cache");
}

