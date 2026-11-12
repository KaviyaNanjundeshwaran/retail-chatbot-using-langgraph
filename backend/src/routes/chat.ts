import { Router, type Response } from "express";
import { z } from "zod";
import { HumanMessage, RemoveMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Command, type StateSnapshot } from "@langchain/langgraph";
import type { ChatGraph } from "../agent/graph";
import { env } from "../config";
import { q, one } from "../db";
import { LIST_LIMITS } from "../domain";
import { rateLimited, requireRole, type User } from "../http";

const textOf = (messages: AIMessage[]) => messages.map((m) => m.text).join("");

const sessionId = z.string().uuid();
const body = z.union([
  z.object({ sessionId, message: z.string() }),
  z.object({ sessionId, edit: z.string() }), // replace the last customer message and answer again
  z.object({ sessionId, resume: z.object({ approved: z.boolean() }) }),
]);
const rename = z.object({ title: z.string().trim().min(1).max(80) });

const threadConfig = (user: User, sid: string, customer_profile: Record<string, unknown> = {}) => ({
  configurable: { thread_id: `${user.id}:${sid}`, customer_id: user.id, customer_name: user.name, session_id: sid, customer_profile },
});

/** The customer's own profile fields the assistant may use and mention (no secrets, no risk data). */
const loadProfile = async (customerId: string) =>
  (await one("select full_name,first_name,email,preferred_language,customer_type,loyalty from customers where customer_id=$1", [customerId])) ?? {};

/** The visible conversation: user turns and assistant text (tool traffic stays in the checkpoint). */
export const transcript = (messages: BaseMessage[] = []) =>
  messages.flatMap((m) =>
    m.type === "human" ? [{ role: "user", content: m.text }] : m.type === "ai" && m.text.trim() ? [{ role: "assistant", content: m.text }] : []
  );

export const pendingConfirmation = (state: StateSnapshot) => state.tasks.flatMap((t) => t.interrupts)[0]?.value ?? null;

/** Customer text as it may reach the model: trimmed, length-checked, card numbers masked. Returns an error message or the text. */
function cleanText(raw: string): { text: string } | { error: string } {
  const text = raw.trim().replace(/\b(?:\d[ -]?){13,19}\b/g, "[card number removed]");
  if (!text) return { error: "Please type a message." };
  if (text.length > env.CHAT_MAX_INPUT_CHARS) return { error: `Message is too long (max ${env.CHAT_MAX_INPUT_CHARS} characters).` };
  return { text };
}

export function chatRouter(graph: ChatGraph) {
  const router = Router();
  router.use(requireRole("customer"));
  const running = new Set<string>();
  const checkpointer = graph.checkpointer as Exclude<ChatGraph["checkpointer"], boolean | undefined>;

  router.get("/sessions", async (_req, res) => {
    res.json(
      await q("select session_id,title,updated_at from app_chat_sessions where customer_id=$1 order by updated_at desc limit $2", [
        res.locals.user.id,
        LIST_LIMITS.sessions,
      ])
    );
  });

  router.get("/sessions/:sessionId", async (req, res) => {
    const state = await graph.getState(threadConfig(res.locals.user, req.params.sessionId));
    res.json({ messages: transcript(state.values.messages), pending: pendingConfirmation(state) });
  });

  router.patch("/sessions/:sessionId", async (req, res) => {
    const p = rename.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: "Title must be 1-80 characters." });
    const row = await one("update app_chat_sessions set title=$1 where customer_id=$2 and session_id=$3 returning session_id", [
      p.data.title,
      res.locals.user.id,
      req.params.sessionId,
    ]);
    if (!row) return res.status(404).json({ error: "Conversation not found." });
    res.json({ ok: true });
  });

  /** Deletes the conversation and its LangGraph checkpoints. Cases and escalations it created are kept. */
  router.delete("/sessions/:sessionId", async (req, res) => {
    const config = threadConfig(res.locals.user, req.params.sessionId);
    if (running.has(config.configurable.thread_id)) return res.status(409).json({ error: "Wait for the answer to finish, then delete." });
    const row = await one("delete from app_chat_sessions where customer_id=$1 and session_id=$2 returning session_id", [
      res.locals.user.id,
      req.params.sessionId,
    ]);
    if (!row) return res.status(404).json({ error: "Conversation not found." });
    await checkpointer.deleteThread(config.configurable.thread_id);
    res.json({ ok: true });
  });

  /** A new message, an edit of the last message, or a confirm/cancel answer. Streams Server-Sent Events. */
  router.post("/", async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request." });
    const user: User = res.locals.user;
    const data = parsed.data;
    const config = threadConfig(user, data.sessionId, await loadProfile(user.id));
    const threadId = config.configurable.thread_id;

    if (running.has(threadId)) return res.status(409).json({ error: "Still answering your previous message." });
    if (rateLimited("chat:" + user.id, env.CHAT_RATE_LIMIT_PER_MIN, 60_000))
      return res.status(429).json({ error: "You're sending messages too quickly. Please wait a moment." });

    const state = await graph.getState(config);
    const pending = pendingConfirmation(state);
    let input: { messages: BaseMessage[] } | Command;

    if ("resume" in data) {
      if (!pending) return res.status(409).json({ error: "There is nothing to confirm." });
      input = new Command({ resume: data.resume });
    } else {
      const clean = cleanText("message" in data ? data.message : data.edit);
      if ("error" in clean) return res.status(400).json({ error: clean.error });
      if (pending) return res.status(409).json({ error: "Please confirm or cancel the pending request first." });

      let removed: BaseMessage[] = [];
      if ("edit" in data) {
        // Edit = remove the last customer message and everything after it (RemoveMessage, per the LangGraph memory docs), then re-ask.
        const messages: BaseMessage[] = state.values.messages ?? [];
        const lastHuman = messages.findLastIndex((m) => m.type === "human");
        if (lastHuman < 0) return res.status(400).json({ error: "There is no message to edit." });
        removed = messages.slice(lastHuman).map((m) => new RemoveMessage({ id: m.id! }));
        if (messages.findIndex((m) => m.type === "human") === lastHuman)
          await q("update app_chat_sessions set title=$1 where customer_id=$2 and session_id=$3", [clean.text.slice(0, 80), user.id, data.sessionId]);
      }
      input = { messages: [...removed, new HumanMessage(clean.text)] };
      await q(
        `insert into app_chat_sessions(customer_id,session_id,title) values($1,$2,$3)
         on conflict(customer_id,session_id) do update set updated_at=now()`,
        [user.id, data.sessionId, clean.text.slice(0, 80)]
      );
    }

    running.add(threadId);
    await streamRun(graph, input, config, res).finally(() => running.delete(threadId));
  });

  return router;
}

async function streamRun(graph: ChatGraph, input: any, config: ReturnType<typeof threadConfig>, res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop the run (and its LLM/tool calls) when the browser goes away or the customer presses Stop.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const stream = await graph.stream(input, { ...config, streamMode: ["messages", "updates", "custom"], signal: abort.signal });
    for await (const [mode, chunk] of stream as AsyncIterable<[string, any]>) {
      if (mode === "messages") {
        // Only the assistant's own tokens; the guardrails' classifier output is internal.
        const [message, meta] = chunk;
        if (meta.langgraph_node === "agent" && message.text) send("token", message.text);
      } else if (mode === "custom") {
        if (chunk?.status) send("status", chunk.status); // progress label written by a node
      } else if (chunk.input_guard?.messages) {
        send("token", textOf(chunk.input_guard.messages)); // input guardrail refusal
      } else if (chunk.output_guard?.messages) {
        send("replace", textOf(chunk.output_guard.messages)); // output guardrail correction of the streamed draft
      } else if (chunk.__interrupt__) {
        send("interrupt", chunk.__interrupt__[0].value);
      } else if (chunk.agent) {
        const names = (chunk.agent.messages ?? []).flatMap((m: any) => m.tool_calls ?? []).map((c: any) => c.name);
        if (names.length) send("tools", names);
      }
    }
    send("done", {});
  } catch (e: any) {
    if (abort.signal.aborted) return;
    console.error("[chat] run failed:", e);
    // Provider quota / rate limit (HTTP 429): tell the customer to wait instead of showing a generic failure.
    const rateLimited = e?.status === 429 || /\b429\b|rate.?limit|quota/i.test(String(e?.message));
    send("error", {
      message: rateLimited
        ? "The assistant is busy right now. Please wait about a minute and try again."
        : "Something went wrong while answering. Please try again.",
    });
  } finally {
    res.end();
  }
}
