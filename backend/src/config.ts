import path from "node:path";
import { z } from "zod";

// .env.local wins: process.loadEnvFile never overrides a variable that is already set.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.resolve(__dirname, "..", file));
  } catch {}
}

const schema = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().int().default(3001),
    FRONTEND_URL: z.string().url().default("http://localhost:3000"),
    APP_NAME: z.string().min(1).default("Returns & Refunds Assistant"),

    PG_URI: z.string().min(1),
    // verify = full TLS verification, no-verify = encrypted but unverified (e.g. Supabase pooler without its CA), disable = plain TCP.
    PG_SSL: z.enum(["verify", "no-verify", "disable"]).default("verify"),
    PG_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).optional(),
    SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(10),

    LLM_PROVIDER: z.enum(["gemini", "mistral"]),
    GOOGLE_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().optional(),
    GEMINI_BASE_URL: z.string().url().optional(), // unset = Google default endpoint
    MISTRAL_API_KEY: z.string().optional(),
    MISTRAL_MODEL: z.string().optional(),
    MISTRAL_BASE_URL: z.string().url().optional(), // unset = Mistral default endpoint
    // Optional cheaper/faster model of the same provider for both guardrails; defaults to the main model.
    LLM_GUARD_MODEL: z.string().optional(),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),

    // Messages sent to the model per call. Must exceed one turn's tool loop (LangGraph's default recursionLimit is 25 steps).
    CHAT_HISTORY_MESSAGES: z.coerce.number().int().min(26).default(30),
    CHAT_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(1500),
    CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(15),

    SNS_WORKBENCH_NOTIFICATION_URL: z.string().url(),
    SNS_WORKBENCH_ESCALATION_URL: z.string().url(),
    SNS_WORKBENCH_API_KEY: z.string().optional(),
    WORKBENCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    SUPPORT_TEAM_EMAIL: z.string().email(),
  })
  .superRefine((e, ctx) => {
    const need = e.LLM_PROVIDER === "gemini" ? ["GOOGLE_API_KEY", "GEMINI_MODEL"] : ["MISTRAL_API_KEY", "MISTRAL_MODEL"];
    for (const key of need)
      if (!e[key as keyof typeof e]) ctx.addIssue({ code: "custom", path: [key], message: `required when LLM_PROVIDER=${e.LLM_PROVIDER}` });
  });

const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
