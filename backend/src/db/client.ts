import { Pool } from "pg";
import bcrypt from "bcryptjs";

const G = globalThis as any;

export const pool: Pool = (G.__pool ??= new Pool({
  connectionString: process.env.PG_URI,
  max: 5,
  ssl: { rejectUnauthorized: false },
}));

export const q = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows;
export const one = async (sql: string, params: any[] = []) => (await q(sql, params))[0];

export const audit = (actor: string, role: string, action: string, detail: any = {}) =>
  q("insert into app_audit(actor,role,action,detail) values($1,$2,$3,$4)", [actor, role, action, JSON.stringify(detail)]).catch(() => {});

export const DEFAULT_SETTINGS: Record<string, any> = {
  guardrails: {
    max_input_chars: 1500,
    rate_limit_per_min: 15,
    redact_pii: true,
    llm_input: true,
    llm_output: true,
    scope: "Product returns, refunds, replacements and exchanges only: eligibility, the return/refund/replacement/exchange policies, raising a return, refund or replacement request, and the status of the customer's own return/refund/replacement cases. Looking up the customer's own orders is allowed only to support those.",
    blocked_patterns: [
      "ignore (all |any |the )?(previous|prior|above) (instructions|rules)",
      "(reveal|show|print|repeat).{0,30}(system prompt|hidden prompt|your instructions)",
      "(api[ _-]?key|jwt|secret|password hash)",
      "you are now (dan|developer mode)",
      "jailbreak",
    ],
  },
  cache: { enabled: true, threshold: 0.92, ttl_hours: 24 },
  messages: {
    empty: "Please type a message so I can help.",
    too_long: "Your message is too long (max {max} characters). Please shorten it.",
    rate_limited: "You're sending messages too quickly. Please wait a moment and try again.",
    error: "Something went wrong while processing your request. Please try again.",
    fallback_off_topic: "I can only help with returns, refunds and replacements.",
    fallback_blocked_request: "Sorry, I can't help with that request.",
    fallback_unverified_answer: "I couldn't verify that against your records. Could you share the order number?",
    fallback_empty_answer: "I couldn't put an answer together. Could you rephrase that?",
    fallback_incomplete: "I couldn't finish that. Would you like me to pass this to a support agent?",
  },
  chat: { history_window: 10, max_tool_steps: 6, llm_rpm: 14, bot_name: "Returns & Refunds Assistant" },
};

export const DEFAULT_SKILLS = [
  [
    "order-lookup",
    "orders",
    "Find the customer's order that a return, refund or replacement is about.",
    "1. If the customer did not name an order, call list_my_orders and ask which one (or use the only/latest one if obvious).\n2. Call get_order_details for the delivery date and item details needed for the return decision.\n3. Report only what is relevant to a return, refund or replacement. Do not act as a shipment-tracking service.",
  ],
  [
    "return-eligibility-check",
    "returns",
    "Decide whether an order item can be returned, refunded, replaced or exchanged.",
    "1. Identify the order (list_my_orders if unknown).\n2. Call check_return_eligibility.\n3. Explain eligibility using the returned window, days since delivery, allowed reasons and options.\n4. If not eligible, say why and offer human handoff. Never promise approval.",
  ],
  [
    "raise-return-request",
    "returns",
    "Create a return/refund/replacement/exchange case after the customer confirms.",
    "1. Run the return-eligibility-check steps first.\n2. Collect: order, reason (one of the allowed reasons) and desired resolution (REFUND, REPLACEMENT or EXCHANGE offered in options).\n3. Call prepare_return_request, show the summary and ask the customer to reply yes to confirm.\n4. In a later turn, only after an explicit yes, call create_return_request and share the case id and next step.",
  ],
  [
    "case-status",
    "orders",
    "Report progress of an existing return, refund or replacement case.",
    "1. If no case id is given call list_my_cases.\n2. Call get_case_status for the chosen case.\n3. Report status, pickup/warehouse details and what happens next using only returned data.",
  ],
  [
    "policy-explainer",
    "policy",
    "Answer questions about return, refund, replacement and exchange policies.",
    "1. Use only the retrieved policy context.\n2. Quote the policy name, return window, allowed reasons and packaging/accessory conditions.\n3. If the context does not cover the question, say you are not sure and offer human handoff.",
  ],
  [
    "human-handoff",
    "all",
    "Escalate to a human agent when the bot cannot or should not decide.",
    "1. Apologise politely and acknowledge the issue.\n2. Call the tool escalate_to_human with a clear reason and 2-3 sentence conversation summary.\n3. Inform the customer that their request has been escalated and a support representative has been notified by email and will follow up shortly.",
  ],
  [
    "customer-email-notification",
    "all",
    "Send an official return or refund notification email to the customer.",
    "1. Verify the order id and case id if available.\n2. Draft a professional, empathetic email subject and body.\n3. Call send_customer_email_notification with the details to trigger the email dispatch through the notification service.",
  ],
];

export async function bootDatabase() {
  if (G.__boot) return G.__boot;
  G.__boot = (async () => {
    await q("create extension if not exists vector");
    const ddl = [
      "create table if not exists app_admins(id serial primary key,email text unique not null,name text,password_hash text not null,role text not null default 'admin',created_at timestamptz default now())",
      "create table if not exists app_chat_messages(id bigserial primary key,customer_id text not null,session_id text not null,role text not null,content text not null,intent text,meta jsonb default '{}',created_at timestamptz default now())",
      "create index if not exists app_chat_idx on app_chat_messages(customer_id,session_id,id)",
      "create table if not exists app_kb(source text,source_id text,content text,embedding vector,provider text,updated_at timestamptz default now(),primary key(source,source_id))",
      "create table if not exists app_cache(id bigserial primary key,question text,answer text,embedding vector,provider text,hits int default 0,created_at timestamptz default now())",
      "create table if not exists app_skills(name text primary key,agent text default 'all',description text,instructions text,enabled boolean default true,updated_at timestamptz default now())",
      "create table if not exists app_settings(key text primary key,value jsonb not null,updated_at timestamptz default now())",
      "create table if not exists app_pending(customer_id text,session_id text,payload jsonb,created_at timestamptz default now(),primary key(customer_id,session_id))",
      "create table if not exists app_audit(id bigserial primary key,actor text,role text,action text,detail jsonb,at timestamptz default now())",
      "create table if not exists app_escalations(id bigserial primary key,escalation_id text unique not null,customer_id text not null,session_id text not null,reason text,summary text,case_id text,notified_at timestamptz default now(),status text default 'OPEN',resolved_at timestamptz,resolved_by text,notes text)",
      "create index if not exists app_esc_cid on app_escalations(customer_id,notified_at desc)",
    ];
    for (const s of ddl) await q(s);
    for (const t of ["admins", "chat_messages", "kb", "cache", "skills", "settings", "audit", "pending", "escalations"])
      await q(`alter table app_${t} enable row level security`);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
      await q("insert into app_settings(key,value) values($1,$2) on conflict do nothing", [k, JSON.stringify(v)]);
    if (!(await one("select 1 x from app_skills limit 1")))
      for (const [name, agent, description, instructions] of DEFAULT_SKILLS)
        await q("insert into app_skills(name,agent,description,instructions) values($1,$2,$3,$4)", [name, agent, description, instructions]);
    const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (ADMIN_EMAIL && ADMIN_PASSWORD && !(await one("select 1 x from app_admins where lower(email)=lower($1)", [ADMIN_EMAIL])))
      await q("insert into app_admins(email,name,password_hash) values($1,$2,$3)", [ADMIN_EMAIL, "Administrator", await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  })().catch((e) => {
    G.__boot = undefined;
    throw e;
  });
  return G.__boot;
}

const settingsCache = (G.__settingsCache ??= new Map<string, { at: number; v: any }>());

export async function getSetting(key: string) {
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.v;
  const r = await one("select value from app_settings where key=$1", [key]);
  const v = { ...DEFAULT_SETTINGS[key], ...(r?.value || {}) };
  settingsCache.set(key, { at: Date.now(), v });
  return v;
}

