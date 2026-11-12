import { buildGraph } from "./agent/graph";
import { env } from "./config";
import { checkDatabase, createCheckpointer, createStore, pool } from "./db";
import { createChatModel } from "./llm";
import { createApp } from "./server";

// The Gemini SDK rejects an internal promise that nobody awaits when a stream ends early (client disconnect, network
// drop). Node would exit on it; the failing request already gets its own error, so log it and keep serving.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

async function main() {
  await checkDatabase();
  const model = createChatModel();
  const guardModel = env.LLM_GUARD_MODEL ? createChatModel(env.LLM_GUARD_MODEL) : model;
  const store = createStore();
  const server = createApp(buildGraph(model, guardModel, createCheckpointer(), store)).listen(env.PORT, () =>
    console.log(`${env.APP_NAME} API on port ${env.PORT} (${env.LLM_PROVIDER})`)
  );

  // Graceful shutdown: stop accepting requests, let open ones finish, then close the pool.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => server.close(() => Promise.all([pool.end(), store.stop()]).finally(() => process.exit(0))));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
