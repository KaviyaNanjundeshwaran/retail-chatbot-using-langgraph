import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatMistralAI } from "@langchain/mistralai";
import { env } from "./config";

/**
 * A chat model for the configured provider. Model names, endpoints and tuning come only from the environment;
 * an unset *_BASE_URL leaves the provider SDK on its official endpoint.
 */
export function createChatModel(model?: string): BaseChatModel {
  const common = { temperature: env.LLM_TEMPERATURE, maxRetries: env.LLM_MAX_RETRIES };
  return env.LLM_PROVIDER === "mistral"
    ? new ChatMistralAI({ ...common, model: model ?? env.MISTRAL_MODEL!, apiKey: env.MISTRAL_API_KEY, serverURL: env.MISTRAL_BASE_URL })
    : new ChatGoogleGenerativeAI({ ...common, model: model ?? env.GEMINI_MODEL!, apiKey: env.GOOGLE_API_KEY, baseUrl: env.GEMINI_BASE_URL });
}
