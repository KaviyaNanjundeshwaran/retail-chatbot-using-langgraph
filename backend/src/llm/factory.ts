import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { ChatMistralAI, MistralAIEmbeddings } from "@langchain/mistralai";
import { getSetting } from "../db/client";

const G = globalThis as any;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function getProvider(): "gemini" | "mistral" {
  const p = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (p === "mistral" && process.env.MISTRAL_API_KEY) return "mistral";
  if (p === "gemini" && process.env.GOOGLE_API_KEY) return "gemini";
  if (process.env.GOOGLE_API_KEY) return "gemini";
  if (process.env.MISTRAL_API_KEY) return "mistral";
  throw new Error("No LLM key configured. Set GOOGLE_API_KEY or MISTRAL_API_KEY in .env.local.");
}

export function createBaseLlm(): any {
  return getProvider() === "mistral"
    ? new ChatMistralAI({
        apiKey: process.env.MISTRAL_API_KEY,
        model: process.env.MISTRAL_MODEL || "mistral-small-latest",
        temperature: 0.2,
      })
    : new ChatGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY,
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        temperature: 0.2,
      });
}

export function createEmbedder(): any {
  return getProvider() === "mistral"
    ? new MistralAIEmbeddings({
        apiKey: process.env.MISTRAL_API_KEY,
        model: "mistral-embed",
      })
    : new GoogleGenerativeAIEmbeddings({
        apiKey: process.env.GOOGLE_API_KEY,
        model: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
      });
}

export async function paceLlm() {
  const rpm = (await getSetting("chat")).llm_rpm ?? 14;
  if (!rpm) return;
  const w: number[] = (G.__llmTs ??= []);
  for (;;) {
    const now = Date.now();
    while (w.length && now - w[0] > 60000) w.shift();
    if (w.length < rpm) {
      w.push(now);
      return;
    }
    await sleep(Math.max(250, 60000 - (now - w[0]) + 100));
  }
}

export const isRetryableError = (e: any) =>
  /429|quota|rate.?limit|too many requests|overloaded|503/i.test(String(e?.message || e));

export const extractRetryDelay = (e: any) => {
  const m = /retry in ([\d.]+)s/i.exec(String(e?.message || ""));
  return ((m ? +m[1] : 4) + 1) * 1000;
};

export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  for (let a = 0; ; a++) {
    await paceLlm();
    try {
      return await fn();
    } catch (e: any) {
      if (isRetryableError(e) && a < 4) {
        await sleep(extractRetryDelay(e));
        continue;
      }
      throw e;
    }
  }
}

export function wrapLlmWithPacing(target: any): any {
  return new Proxy(target, {
    get(t, prop) {
      const v = t[prop];
      if (prop === "invoke") return (...a: any[]) => withRateLimit(() => t.invoke(...a));
      if (prop === "withStructuredOutput" || prop === "bindTools") return (...a: any[]) => wrapLlmWithPacing(t[prop](...a));
      if (prop === "stream")
        return async function* (...a: any[]) {
          for (let att = 0; ; att++) {
            await paceLlm();
            let yielded = false;
            try {
              for await (const c of await t.stream(...a)) {
                yielded = true;
                yield c;
              }
              return;
            } catch (e: any) {
              if (!yielded && isRetryableError(e) && att < 4) {
                await sleep(extractRetryDelay(e));
                continue;
              }
              throw e;
            }
          }
        };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

export const getLlm = (): any => wrapLlmWithPacing(createBaseLlm());

export const textOfMessage = (m: any): string =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
    ? m.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join("")
    : "";

