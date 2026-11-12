import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { ChatMistralAI, MistralAIEmbeddings } from "@langchain/mistralai";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
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

class RateLimitPacingHandler extends BaseCallbackHandler {
  name = "RateLimitPacingHandler";
  awaitHandlers = true;

  async handleChatModelStart() {
    await paceLlm();
  }
}

const pacingHandler = new RateLimitPacingHandler();

export function getLlm(): BaseChatModel {
  return getProvider() === "mistral"
    ? new ChatMistralAI({
        apiKey: process.env.MISTRAL_API_KEY,
        model: process.env.MISTRAL_MODEL || "mistral-small-latest",
        temperature: 0.2,
        maxRetries: 4,
        callbacks: [pacingHandler],
      })
    : new ChatGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY,
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        temperature: 0.2,
        maxRetries: 4,
        callbacks: [pacingHandler],
      });
}

export function createEmbedder(): Embeddings {
  return getProvider() === "mistral"
    ? new MistralAIEmbeddings({
        apiKey: process.env.MISTRAL_API_KEY,
        model: "mistral-embed",
        maxRetries: 4,
      })
    : new GoogleGenerativeAIEmbeddings({
        apiKey: process.env.GOOGLE_API_KEY,
        model: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
        maxRetries: 4,
      });
}

export const textOfMessage = (m: any): string =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
    ? m.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join("")
    : "";
