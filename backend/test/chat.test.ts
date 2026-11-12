/**
 * End-to-end API test: real Express app + LangGraph graph + Postgres checkpointer, with
 * - PGlite (in-process Postgres) instead of Supabase,
 * - a scripted tool-calling chat model instead of Gemini/Mistral,
 * - a local HTTP server standing in for the Workbench webhooks.
 * Run: npm test
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";

/** Returns queued AI messages in order; records what it was sent. Guard verdicts default to "allowed" / "pass". */
class ScriptedModel extends BaseChatModel {
  queue: AIMessage[] = [];
  seen: BaseMessage[][] = [];
  verdicts: { allowed: boolean; category: string; reply: string }[] = [];
  outputVerdicts: { pass: boolean; issues: string[]; revised: string }[] = [];
  guardSeen: BaseMessage[][] = [];
  outputGuardSeen: BaseMessage[][] = [];
  _llmType() {
    return "scripted";
  }
  bindTools() {
    return this as any;
  }
  withStructuredOutput(_schema: unknown, opts?: { name?: string }): any {
    return RunnableLambda.from(async (messages: BaseMessage[]) => {
      if (opts?.name === "output_guard") {
        this.outputGuardSeen.push(messages);
        return this.outputVerdicts.shift() ?? { pass: true, issues: [], revised: "" };
      }
      this.guardSeen.push(messages);
      return this.verdicts.shift() ?? { allowed: true, category: "ok", reply: "" };
    });
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const message = this.queue.shift();
    if (!message) throw new Error("ScriptedModel: no response queued");
    return { generations: [{ message, text: message.text }] };
  }
}
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: "call_" + Math.random().toString(36).slice(2), name, args, type: "tool_call" }] });

const model = new ScriptedModel({});
const webhookCalls: { url: string; body: any }[] = [];
let hookDelayMs = 0;
let hookStatuses: number[] = []; // queued HTTP statuses for the next webhook calls (default 200)
let db: PGlite, pgServer: PGLiteSocketServer, hookServer: http.Server, apiServer: http.Server;
let base = "";
let pool: any;
let store: any;

before(async () => {
  db = await PGlite.create();
  pgServer = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 10 });
  await pgServer.start();
  const pgPort = (pgServer as any).server.address().port;

  hookServer = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      webhookCalls.push({ url: req.url!, body: JSON.parse(data) });
      setTimeout(() => res.writeHead(hookStatuses.shift() ?? 200, { "Content-Type": "application/json" }).end("{}"), hookDelayMs);
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    PG_URI: `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`,
    PG_SSL: "disable",
    PG_POOL_MAX: "1",
    CHAT_RATE_LIMIT_PER_MIN: "100",
    JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
    ADMIN_EMAIL: "admin@test.local",
    ADMIN_PASSWORD: "admin-pass-123",
    LLM_PROVIDER: "gemini",
    GOOGLE_API_KEY: "unused",
    GEMINI_MODEL: "unused",
    FRONTEND_URL: "http://localhost:3000",
    SNS_WORKBENCH_NOTIFICATION_URL: `${hook}/customer-email-notification`,
    SNS_WORKBENCH_ESCALATION_URL: `${hook}/support-escalation-email`,
    SUPPORT_TEAM_EMAIL: "support@test.local",
  });

  await seed(db);

  const { checkDatabase, createCheckpointer, createStore, setupDatabase, pool: p } = await import("../src/db");
  const { buildGraph } = await import("../src/agent/graph");
  const { createApp } = await import("../src/server");
  pool = p;
  await assert.rejects(checkDatabase(), /npm run db:setup/, "startup refuses an un-setup database");
  await setupDatabase();
  await setupDatabase(); // idempotent
  await checkDatabase();
  store = createStore();
  apiServer = createApp(buildGraph(model, model, createCheckpointer(), store)).listen(0, "127.0.0.1");
  await new Promise((r) => apiServer.once("listening", r));
  base = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});

after(async () => {
  apiServer?.close();
  hookServer?.close();
  await pool?.end();
  await store?.stop();
  await pgServer?.stop();
  await db?.close();
});

async function seed(db: PGlite) {
  const pw = await bcrypt.hash("pass-123", 4);
  const delivered = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await db.exec(`
    create table customers(_id text, customer_id text, first_name text, full_name text, email text, phone text, account_status text, risk_profile jsonb, password text, preferred_language text, customer_type text, loyalty jsonb);
    create table products(_id text, product_id text, product_name text, category text, image_url text, returnable boolean, replacement_allowed boolean, exchange_allowed boolean);
    create table product_variants(_id text, product_id text, available_quantity bigint);
    create table orders(_id text, order_id text, customer_id text, product_id text, order_date text, order_status text, total_amount double precision, currency text, delivered_at text);
    create table order_items(_id text, order_item_id text, order_id text, customer_id text, product_id text, return_status text);
    create table policy_rules(_id text, policy_rule_id text, policy_name text, category text, return_window_days bigint, allowed_conditions jsonb,
      packaging_required boolean, seal_requirement text, accessories_required boolean, refund_allowed boolean, replacement_allowed boolean,
      exchange_allowed boolean, high_risk_requires_manual_review boolean, active boolean, effective_from text);
    create table return_requests(_id text, case_id text, customer_id text, order_id text, order_item_id text, product_id text, product_name text,
      return_reason text, return_status text, replacement_requested boolean, refund_requested boolean, pickup_status text, created_at text, updated_at text);
    create table refund_requests(_id text, case_id text, customer_id text, order_id text, order_item_id text, original_product_id text,
      original_product_name text, request text, status text, created_at text, updated_at text, stock_reserved boolean);
    create table replacement_requests(_id text, case_id text, customer_id text, order_id text, order_item_id text, original_product_id text,
      original_product_name text, replacement_product_id text, replacement_product_name text, stock_status text, stock_quantity bigint,
      request text, status text, created_at text, updated_at text, stock_reserved boolean);
    insert into return_requests(_id, case_id, customer_id, order_id, return_status) values ('x', 'CASE000007', 'CUS000002', 'ORD000009', 'CLOSED');
  `);
  await db.query(
    `insert into customers values ('1','CUS000001','Asha','Asha Rao','asha@test.local','999','ACTIVE','{}',$1),
                                  ('2','CUS000002','Ben','Ben Li','ben@test.local','888','ACTIVE','{}',$1)`,
    [pw]
  );
  await db.exec(`
    insert into products values ('p','PROD000001','Trail Shoes','Footwear','https://img/x.png',true,true,true);
    insert into product_variants values ('v','PROD000001',4);
    insert into policy_rules values ('r','POL000001','Footwear policy','Footwear',10,'["DAMAGED","SIZE_ISSUE"]',true,'ORIGINAL_PACKAGING',false,true,true,true,false,true,'2024-01-01');
  `);
  await db.query(
    `insert into orders values ('o1','ORD000001','CUS000001','PROD000001','2025-01-01','DELIVERED',50,'INR',$1),
                               ('o2','ORD000002','CUS000002','PROD000001','2025-01-01','DELIVERED',50,'INR',$1),
                               ('o3','ORD000003','CUS000001','PROD000001','2025-01-02','DELIVERED',50,'INR',$1)`,
    [delivered]
  );
  await db.exec(`insert into order_items values ('i1','ITEM000001','ORD000001','CUS000001','PROD000001',null),
                                               ('i2','ITEM000002','ORD000002','CUS000002','PROD000001',null),
                                               ('i3','ITEM000003','ORD000003','CUS000001','PROD000001',null);`);
}

async function login(email: string, password: string, role: string) {
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, role }) });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** POST /api/chat and collect the SSE events. */
async function chat(cookie: string, body: object) {
  const res = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });
  if (res.headers.get("content-type")?.startsWith("application/json")) return { status: res.status, json: await res.json(), events: [] as any[] };
  const events = (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [, event] = /^event: (.*)$/m.exec(block)!;
      const [, data] = /^data: (.*)$/m.exec(block)!;
      return { event, data: JSON.parse(data) };
    });
  return { status: res.status, json: null, events };
}
const tokens = (events: any[]) => events.filter((e) => e.event === "token").map((e) => e.data).join("");

const sessionId = crypto.randomUUID();
let asha = "";

test("rejects anonymous chat and foreign-origin writes", async () => {
  assert.equal((await fetch(base + "/api/chat/sessions")).status, 401);
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(res.status, 403);
});

test("customer gets a plain streamed answer", async () => {
  asha = await login("asha@test.local", "pass-123", "customer");
  model.queue.push(new AIMessage("Hi Asha! I can help with returns, refunds and replacements."));
  const r = await chat(asha, { sessionId, message: "hello" });
  assert.equal(r.status, 200);
  assert.match(tokens(r.events), /Hi Asha/);
  assert.equal(r.events.at(-1).event, "done");
  // The system prompt carries the customer identity from the session, not from the model.
  assert.ok(model.seen.at(-1)![0].text.includes("Logged-in customer: Asha Rao (customer id CUS000001)"));
});

test("LLM guardrail blocks a message without reaching the agent", async () => {
  const agentCalls = model.seen.length;
  model.verdicts.push({ allowed: false, category: "off_topic", reply: "I can only help with returns and refunds." });
  const r = await chat(asha, { sessionId, message: "write me a poem about the sea" });
  assert.equal(tokens(r.events), "I can only help with returns and refunds.");
  assert.equal(r.events.at(-1).event, "done");
  assert.equal(model.seen.length, agentCalls, "agent model was not called");
  // The guard judged the message in context of the previous assistant reply.
  assert.match(model.guardSeen.at(-1)!.at(-1)!.text, /Previous assistant message:\nHi Asha!.*\n\nCustomer message:\nwrite me a poem/s);
  // The refusal is part of the conversation history.
  const hist = await (await fetch(`${base}/api/chat/sessions/${sessionId}`, { headers: { cookie: asha } })).json();
  assert.deepEqual(hist.messages.slice(-2), [
    { role: "user", content: "write me a poem about the sea" },
    { role: "assistant", content: "I can only help with returns and refunds." },
  ]);
});

test("tools are scoped to the logged-in customer", async () => {
  model.queue.push(call("check_return_eligibility", { order_id: "ORD000002" }), new AIMessage("I could not find that order on your account."));
  const r = await chat(asha, { sessionId, message: "can I return ORD000002?" });
  assert.deepEqual(r.events.find((e) => e.event === "tools")?.data, ["check_return_eligibility"]);
  const toolResult = model.seen.at(-1)!.at(-1)!.text;
  assert.match(toolResult, /No such order on your account/);
});

test("creating a case pauses for confirmation, then creates it on approve", async () => {
  model.queue.push(call("create_return_request", { order_id: "ORD000001", reason: "size_issue", resolution: "REFUND" }));
  const r = await chat(asha, { sessionId, message: "I want a refund for ORD000001, wrong size" });
  const interrupt = r.events.find((e) => e.event === "interrupt");
  assert.ok(interrupt, "expected an interrupt event");
  assert.equal(interrupt.data.type, "confirm_return");
  assert.equal(interrupt.data.reason, "SIZE_ISSUE");
  assert.equal((await q("select count(*)::int n from refund_requests"))[0].n, 0, "nothing written before confirmation");

  // A new message is refused while the confirmation is open, and the pending card survives a reload.
  assert.equal((await chat(asha, { sessionId, message: "hello?" })).status, 409);
  const hist = await (await fetch(`${base}/api/chat/sessions/${sessionId}`, { headers: { cookie: asha } })).json();
  assert.equal(hist.pending.order_id, "ORD000001");

  model.queue.push(new AIMessage("Done! Your refund case CASE000008 is raised."));
  const done = await chat(asha, { sessionId, resume: { approved: true } });
  assert.match(tokens(done.events), /CASE000008/);
  const [row] = await q("select case_id, return_reason, refund_requested from return_requests where customer_id='CUS000001'");
  assert.deepEqual(row, { case_id: "CASE000008", return_reason: "SIZE_ISSUE", refund_requested: true }, "case id continues after existing CASE000007");
  assert.equal((await q("select count(*)::int n from refund_requests"))[0].n, 1);

  await waitFor(() => webhookCalls.some((c) => c.url === "/customer-email-notification"));
  const mail = webhookCalls.find((c) => c.url === "/customer-email-notification")!.body;
  assert.equal(mail.customer_email, "asha@test.local");
  assert.equal(mail.case_id, "CASE000008");
});

test("cancel creates nothing", async () => {
  const sid = crypto.randomUUID();
  model.queue.push(call("create_return_request", { order_id: "ORD000003", reason: "DAMAGED", resolution: "EXCHANGE" }));
  assert.ok((await chat(asha, { sessionId: sid, message: "exchange ORD000003" })).events.some((e) => e.event === "interrupt"));
  model.queue.push(new AIMessage("No problem, nothing was submitted."));
  const r = await chat(asha, { sessionId: sid, resume: { approved: false } });
  assert.match(tokens(r.events), /nothing was submitted/);
  assert.match(model.seen.at(-1)!.at(-1)!.text, /cancelled/);
  assert.equal((await q("select count(*)::int n from return_requests where order_id='ORD000003'"))[0].n, 0);
});

test("an existing open case blocks a duplicate request", async () => {
  const sid = crypto.randomUUID();
  model.queue.push(call("create_return_request", { order_id: "ORD000001", reason: "DAMAGED", resolution: "REPLACEMENT" }), new AIMessage("ok"));
  const r = await chat(asha, { sessionId: sid, message: "replace it" });
  // Eligibility is re-checked: the refund case from the previous test is still open.
  assert.equal(r.events.find((e) => e.event === "interrupt"), undefined);
  assert.match(model.seen.at(-1)!.at(-1)!.text, /open case CASE000008/);
  assert.equal((await chat(asha, { sessionId: sid, resume: { approved: false } })).status, 409, "nothing to confirm");
});

test("escalation stores a record and emails the support team", async () => {
  model.queue.push(call("escalate_to_human", { reason: "Customer asked for a human", summary: "Wants to talk to someone." }), new AIMessage("I've passed this to our support team."));
  const r = await chat(asha, { sessionId, message: "let me talk to a human" });
  assert.match(tokens(r.events), /support team/);
  const [esc] = await q("select customer_id, session_id, status from app_escalations");
  assert.deepEqual(esc, { customer_id: "CUS000001", session_id: sessionId, status: "OPEN" });
  const mail = webhookCalls.find((c) => c.url === "/support-escalation-email")!.body;
  assert.equal(mail.support_team_email, "support@test.local");
  assert.match(mail.email_body, /CUS000001/);
});

test("a disconnect during a tool call does not break the thread", async () => {
  const sid = crypto.randomUUID();
  hookDelayMs = 1500;
  model.queue.push(call("escalate_to_human", { reason: "r", summary: "s" }));
  const abort = new AbortController();
  const res = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: asha },
    body: JSON.stringify({ sessionId: sid, message: "human please" }),
    signal: abort.signal,
  });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("event: tools")) text += new TextDecoder().decode((await reader.read()).value);
  abort.abort(); // browser closes while the escalation webhook is still in flight
  await new Promise((r) => setTimeout(r, 300));
  hookDelayMs = 0;

  model.queue.push(new AIMessage("Still here. How can I help?"));
  const r = await chat(asha, { sessionId: sid, message: "are you there?" });
  assert.match(tokens(r.events), /Still here/);
  const sent = model.seen.at(-1)!;
  assert.ok(!sent.some((m) => AIMessage.isInstance(m) && m.tool_calls?.length), "dangling tool call is not sent to the model");
});

test("output guardrail replaces an unverified answer in the stream and in history", async () => {
  const sid = crypto.randomUUID();
  model.queue.push(new AIMessage("Your refund of $999 was approved yesterday under case CASE123456."));
  model.outputVerdicts.push({ pass: false, issues: ["invented case id and amount"], revised: "I couldn't find a refund on your account yet." });
  const r = await chat(asha, { sessionId: sid, message: "where is my refund?" });
  assert.match(tokens(r.events), /CASE123456/, "the draft streamed first");
  assert.equal(r.events.find((e) => e.event === "replace")?.data, "I couldn't find a refund on your account yet.");
  // The guard saw the draft and the conversation it must be grounded in.
  const guardInput = model.outputGuardSeen.at(-1)!.at(-1)!.text;
  assert.ok(guardInput.includes("Customer: where is my refund?") && guardInput.includes("Draft reply:\nYour refund of $999"));
  const hist = await (await fetch(`${base}/api/chat/sessions/${sid}`, { headers: { cookie: asha } })).json();
  assert.deepEqual(hist.messages.at(-1), { role: "assistant", content: "I couldn't find a refund on your account yet." });
  assert.equal(hist.messages.length, 2, "the draft was replaced, not appended");
});

test("an escalation in the same step as a confirmation is not repeated on resume", async () => {
  const sid = crypto.randomUUID();
  const before = webhookCalls.filter((c) => c.url === "/support-escalation-email").length;
  const both = new AIMessage({
    content: "",
    tool_calls: [
      { id: "call_esc_same_step", name: "escalate_to_human", args: { reason: "Wants a human too", summary: "Asked for a human and a replacement." }, type: "tool_call" },
      { id: "call_case_same_step", name: "create_return_request", args: { order_id: "ORD000003", reason: "DAMAGED", resolution: "EXCHANGE" }, type: "tool_call" },
    ],
  });
  model.queue.push(both);
  assert.ok((await chat(asha, { sessionId: sid, message: "exchange ORD000003 and get me a human" })).events.some((e) => e.event === "interrupt"));
  model.queue.push(new AIMessage("No problem, nothing was submitted. Our support team will contact you."));
  await chat(asha, { sessionId: sid, resume: { approved: false } });
  const after = webhookCalls.filter((c) => c.url === "/support-escalation-email").length;
  assert.equal(after - before, 1, "support was emailed once");
  assert.equal((await q(`select count(*)::int n from app_escalations where session_id='${sid}'`))[0].n, 1);
});

test("workbench delivery retries a 5xx once, never a 4xx, and records the status", async () => {
  const escalate = async (summary: string) => {
    model.queue.push(call("escalate_to_human", { reason: "r", summary }), new AIMessage("Done."));
    await chat(asha, { sessionId: crypto.randomUUID(), message: "human please" });
    return (await q(`select notify_status from app_escalations where summary='${summary}'`))[0].notify_status;
  };
  let calls = webhookCalls.length;
  hookStatuses = [503, 200];
  assert.equal(await escalate("retry-then-ok"), "sent");
  assert.equal(webhookCalls.length - calls, 2);

  calls = webhookCalls.length;
  hookStatuses = [400];
  assert.equal(await escalate("bad-request"), "failed: HTTP 400");
  assert.equal(webhookCalls.length - calls, 1, "4xx is not retried");
  hookStatuses = [];
});

test("edit replaces the last message and its answer, and streams status labels", async () => {
  const sid = crypto.randomUUID();
  model.queue.push(new AIMessage("First answer."));
  await chat(asha, { sessionId: sid, message: "first question" });
  model.queue.push(new AIMessage("Answer to the typo."));
  await chat(asha, { sessionId: sid, message: "secnd questoin" });

  model.queue.push(new AIMessage("Answer to the fixed question."));
  const r = await chat(asha, { sessionId: sid, edit: "second question" });
  assert.equal(tokens(r.events), "Answer to the fixed question.");
  const labels = r.events.filter((e) => e.event === "status").map((e) => e.data);
  assert.deepEqual(labels, ["Checking your message", "Double-checking the answer"]);

  const hist = await (await fetch(`${base}/api/chat/sessions/${sid}`, { headers: { cookie: asha } })).json();
  assert.deepEqual(hist.messages.map((m: any) => m.content), ["first question", "First answer.", "second question", "Answer to the fixed question."]);
  // The model saw the corrected thread, not the typo.
  assert.ok(!model.seen.at(-1)!.some((m) => m.text.includes("secnd")));
});

test("conversations can be renamed and deleted (with their checkpoints)", async () => {
  const sid = crypto.randomUUID();
  model.queue.push(new AIMessage("Hello!"));
  await chat(asha, { sessionId: sid, message: "hi there" });
  const url = `${base}/api/chat/sessions/${sid}`;
  const h = { "Content-Type": "application/json", cookie: asha };

  assert.equal((await fetch(url, { method: "PATCH", headers: h, body: JSON.stringify({ title: "  " }) })).status, 400);
  assert.equal((await fetch(url, { method: "PATCH", headers: h, body: JSON.stringify({ title: "Shoe refund" }) })).status, 200);
  const list = await (await fetch(`${base}/api/chat/sessions`, { headers: { cookie: asha } })).json();
  assert.equal(list.find((s: any) => s.session_id === sid)?.title, "Shoe refund");

  assert.equal((await fetch(url, { method: "DELETE", headers: { cookie: asha } })).status, 200);
  assert.equal((await fetch(url, { method: "DELETE", headers: { cookie: asha } })).status, 404);
  assert.deepEqual((await (await fetch(url, { headers: { cookie: asha } })).json()).messages, []);
  assert.equal((await q(`select count(*)::int n from checkpoints where thread_id='CUS000001:${sid}'`))[0].n, 0);
  // Another customer cannot touch Asha's conversations.
  const ben = await login("ben@test.local", "pass-123", "customer");
  assert.equal((await fetch(`${base}/api/chat/sessions/${sessionId}`, { method: "DELETE", headers: { cookie: ben } })).status, 404);
});

test("long-term memory: saved in one conversation, known in the next, and can be forgotten", async () => {
  // Conversation 1: the customer states a lasting preference; the agent saves it.
  model.queue.push(call("save_memory", { fact: "Prefers to be contacted by email." }), new AIMessage("Noted, I'll remember that."));
  await chat(asha, { sessionId: crypto.randomUUID(), message: "please always contact me by email" });
  const saved = JSON.parse(model.seen.at(-1)!.at(-1)!.text);
  assert.equal(saved.saved, true);

  // Conversation 2 (a different thread): the agent prompt and both guardrails know it, plus the customer's identity.
  model.queue.push(new AIMessage("Your name is Asha Rao."));
  await chat(asha, { sessionId: crypto.randomUUID(), message: "what is my name?" });
  const agentSystem = model.seen.at(-1)![0].text;
  assert.match(agentSystem, /Prefers to be contacted by email/);
  assert.match(agentSystem, /"email":"asha@test.local"/, "profile from the customer table");
  assert.ok(model.guardSeen.at(-1)![0].text.includes("Logged-in customer: Asha Rao (customer id CUS000001)"));
  assert.match(model.outputGuardSeen.at(-1)![0].text, /Prefers to be contacted by email/);

  // Saving the same fact again does not duplicate it; forgetting removes it.
  model.queue.push(call("save_memory", { fact: "Prefers to be contacted by email." }), new AIMessage("Already noted."));
  await chat(asha, { sessionId: crypto.randomUUID(), message: "remember: email me" });
  assert.equal((await store.search(["customers", "CUS000001", "memories"])).length, 1);
  model.queue.push(call("delete_memory", { memory_id: saved.memory_id }), new AIMessage("Forgotten."));
  await chat(asha, { sessionId: crypto.randomUUID(), message: "forget my contact preference" });
  assert.equal((await store.search(["customers", "CUS000001", "memories"])).length, 0);
  // Memories are per customer: Ben's namespace is untouched and separate.
  assert.equal((await store.search(["customers", "CUS000002", "memories"])).length, 0);
});

test("history and session list come from the checkpointer", async () => {

  const sessions = await (await fetch(base + "/api/chat/sessions", { headers: { cookie: asha } })).json();
  assert.equal(sessions.find((s: any) => s.session_id === sessionId)?.title, "hello");
  const hist = await (await fetch(`${base}/api/chat/sessions/${sessionId}`, { headers: { cookie: asha } })).json();
  assert.equal(hist.pending, null);
  assert.deepEqual(hist.messages[0], { role: "user", content: "hello" });
  assert.ok(hist.messages.every((m: any) => m.content), "tool traffic is not shown");
});

test("input validation and model failure are reported cleanly", async () => {
  assert.equal((await chat(asha, { sessionId, message: "   " })).status, 400);
  assert.equal((await chat(asha, { sessionId, message: "x".repeat(1501) })).status, 400);
  assert.equal((await chat(asha, { sessionId: "not-a-uuid", message: "hi" })).status, 400);
  const r = await chat(asha, { sessionId, message: "card 4111 1111 1111 1111 please" }); // queue empty -> model throws
  assert.equal(r.events.at(-1).event, "error");
  assert.doesNotMatch(JSON.stringify(r.events), /ScriptedModel/, "internal error text is not leaked");
  const hist = await (await fetch(`${base}/api/chat/sessions/${sessionId}`, { headers: { cookie: asha } })).json();
  assert.match(hist.messages.at(-1).content, /\[card number removed\]/);
});

test("admin manages policies and escalations and reads conversations", async () => {
  const admin = await login("admin@test.local", "admin-pass-123", "admin");
  const h = { "Content-Type": "application/json", cookie: admin };
  assert.equal((await fetch(base + "/api/chat/sessions", { headers: { cookie: admin } })).status, 403);
  assert.equal((await fetch(base + "/api/admin/policies", { headers: { cookie: asha } })).status, 403);

  const policies = await (await fetch(base + "/api/admin/policies", { headers: h })).json();
  const p = { ...policies[0], return_window_days: 15 };
  assert.equal((await fetch(base + "/api/admin/policies/POL000001", { method: "PUT", headers: h, body: JSON.stringify(p) })).status, 200);
  assert.equal((await fetch(base + "/api/admin/policies/POL000001", { method: "PUT", headers: h, body: JSON.stringify({ ...p, return_window_days: -1 }) })).status, 400);
  const created = await (await fetch(base + "/api/admin/policies", { method: "POST", headers: h, body: JSON.stringify({ ...p, category: "Toys" }) })).json();
  assert.equal(created.id, "POL000002");

  const [esc] = await (await fetch(base + "/api/admin/escalations", { headers: h })).json();
  assert.equal((await fetch(`${base}/api/admin/escalations/${esc.escalation_id}`, { method: "PUT", headers: h, body: JSON.stringify({ status: "RESOLVED" }) })).status, 200);
  assert.equal((await q(`select status from app_escalations where escalation_id='${esc.escalation_id}'`))[0].status, "RESOLVED");

  const convo = await (await fetch(`${base}/api/admin/conversations/CUS000001/${sessionId}`, { headers: h })).json();
  assert.equal(convo.messages[0].content, "hello");
});

async function q(sql: string) {
  return (await pool.query(sql)).rows;
}
async function waitFor(ok: () => boolean) {
  for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), "condition not met in time");
}
