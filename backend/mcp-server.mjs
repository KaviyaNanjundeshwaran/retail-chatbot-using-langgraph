/* =====================================================================
   Standalone MCP server (Streamable HTTP, stateless) for the returns agent.
   Run:  node mcp-server.mjs      (the Next.js app also starts it automatically)

   Security model: every request must carry `Authorization: Bearer <jwt>` signed
   by the web app (JWT_SECRET, audience "mcp"). The token carries the logged-in
   customer id (sub), chat session (sid), the customer's latest message (msg)
   and a per-turn id (turn). Tools NEVER take a customer id from the model, so
   a prompt-injected model cannot read another customer's data.
   ===================================================================== */
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { jwtVerify } from "jose";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

try { process.loadEnvFile(path.join(import.meta.dirname, ".env")); } catch {}
try { process.loadEnvFile(path.join(import.meta.dirname, ".env.local")); } catch {}
const PORT = Number(process.env.MCP_PORT || 3333);
if (!process.env.PG_URI || !process.env.JWT_SECRET) { console.error("[mcp] PG_URI and JWT_SECRET are required"); process.exit(1); }
const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const pool = new pg.Pool({ connectionString: process.env.PG_URI, max: 4, ssl: { rejectUnauthorized: false } });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const audit = (actor, role, action, detail = {}) =>
  q("insert into app_audit(actor,role,action,detail) values($1,$2,$3,$4)", [actor, role, action, JSON.stringify(detail)]).catch(() => {});

/* ---- SNS Workbench Email Notification Webhook ---- */
const WORKBENCH_WEBHOOK_URL = process.env.SNS_WORKBENCH_NOTIFICATION_URL || "https://api.agents.snsihub.ai/webhook/customer-email-notification";
const WORKBENCH_ESCALATION_URL = process.env.SNS_WORKBENCH_ESCALATION_URL || "https://api.agents.snsihub.ai/webhook/support-escalation-email";
const DEFAULT_SUPPORT_TEAM_EMAIL = process.env.SUPPORT_TEAM_EMAIL || "support@retail.local";

async function postToUrl(url, payload) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.SNS_WORKBENCH_API_KEY) {
      headers["Authorization"] = `Bearer ${process.env.SNS_WORKBENCH_API_KEY}`;
      headers["x-api-key"] = process.env.SNS_WORKBENCH_API_KEY;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`[workbench-post] failed for ${url}:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function postWorkbenchEmailNotification(payload) {
  return postToUrl(WORKBENCH_WEBHOOK_URL, payload);
}

async function postWorkbenchSupportEscalation(payload) {
  return postToUrl(WORKBENCH_ESCALATION_URL, payload);
}

/* ---- Publish escalation email via Workbench Support Escalation Webhook ---- */
async function sendEscalationEmail({ customerId, customerName, customerEmail, phone, sessionId, reason, customerMessage, caseId, orderId }) {
  const subject = `Human Support Escalation Request - Customer ${customerId}`;
  const emailBody = [
    `Hello Customer Support Team,`,
    ``,
    `A customer has requested to speak with a human support representative through the Retail Customer Chatbot.`,
    ``,
    `Customer Details:`,
    `-------------------------`,
    `Customer ID: ${customerId}`,
    `Customer Name: ${customerName || "Valued Customer"}`,
    `Customer Email: ${customerEmail || "Not provided"}`,
    `Phone Number: ${phone || "Not provided"}`,
    orderId ? `Order ID: ${orderId}` : null,
    caseId ? `Case ID: ${caseId}` : null,
    ``,
    `Escalation Details:`,
    `-------------------------`,
    `Reason: ${reason || "Customer requested to speak with customer support."}`,
    `Customer Message: ${customerMessage || "I want to talk to customer support."}`,
    ``,
    `Please review this request and contact the customer to provide further assistance.`,
    ``,
    `Best Regards,`,
    `Retail Customer Support Chatbot`,
  ].filter(Boolean).join("\n");

  const escalationPayload = {
    support_team_email: DEFAULT_SUPPORT_TEAM_EMAIL,
    email_subject: subject,
    email_body: emailBody,
    notification_type: "HUMAN_ESCALATION",
    priority: "HIGH",
    escalation_status: "PENDING",
  };

  const wbResult = await postWorkbenchSupportEscalation(escalationPayload);
  return { workbench: wbResult, payload: escalationPayload };
}

const CLOSED = ["RESTOCKED", "REJECTED", "CLOSED", "COMPLETED", "CANCELLED", "REFUNDED"];
const AFFIRM = /^\s*(yes|yep|yeah|yup|y|confirm(ed)?|ok(ay)?|sure|proceed|go ahead|please (do|proceed|go ahead)|do it|submit( it)?|correct)\b/i;

/* ---------------- business logic (always scoped to one customer) ---------------- */
async function eligibility(cid, orderId) {
  const o = await one(
    `select o.*,p.product_name,p.category,p.returnable,p.replacement_allowed prod_repl,p.exchange_allowed prod_exch
       from orders o left join products p on p.product_id=o.product_id where o.order_id=$1 and o.customer_id=$2`, [orderId, cid]);
  if (!o) return { found: false, eligible: false, reasons: ["No such order on your account."] };
  const item = await one("select order_item_id,return_status from order_items where order_id=$1 and customer_id=$2 limit 1", [orderId, cid]);
  const pol = await one("select * from policy_rules where lower(category)=lower($1) and active order by effective_from desc limit 1", [o.category || ""]);
  const cust = await one("select risk_profile from customers where customer_id=$1", [cid]);
  const open = item && await one(
    "select case_id,return_status from return_requests where customer_id=$1 and order_item_id=$2 and coalesce(return_status,'') <> all($3) limit 1", [cid, item.order_item_id, CLOSED]);
  const reasons = [];
  const delivered = o.order_status === "DELIVERED" && o.delivered_at;
  const days = delivered ? Math.floor((Date.now() - new Date(o.delivered_at).getTime()) / 86400000) : null;
  if (!delivered) reasons.push(`Order is not delivered yet (status ${o.order_status}).`);
  if (o.returnable === false) reasons.push("This product is marked non-returnable.");
  if (!pol) reasons.push(`No active return policy found for category ${o.category}.`);
  if (pol && days !== null && days > pol.return_window_days) reasons.push(`Return window of ${pol.return_window_days} days has passed (${days} days since delivery).`);
  if (item?.return_status === "RETURNED") reasons.push("This item was already returned.");
  if (open) reasons.push(`An open case ${open.case_id} (${open.return_status}) already exists for this item.`);
  const risk = cust?.risk_profile || {};
  return {
    found: true, order_id: orderId, order_item_id: item?.order_item_id, product_id: o.product_id, product_name: o.product_name,
    category: o.category, order_status: o.order_status, delivered_at: o.delivered_at, days_since_delivery: days,
    policy: pol ? { id: pol.policy_rule_id, name: pol.policy_name, return_window_days: pol.return_window_days, allowed_reasons: pol.allowed_conditions,
      packaging_required: pol.packaging_required, accessories_required: pol.accessories_required } : null,
    eligible: reasons.length === 0,
    options: pol ? { REFUND: !!(pol.refund_allowed && o.returnable !== false), REPLACEMENT: !!(pol.replacement_allowed && o.prod_repl), EXCHANGE: !!(pol.exchange_allowed && o.prod_exch) } : {},
    requires_manual_review: !!(pol?.high_risk_requires_manual_review && (risk.risk_level === "HIGH" || risk.risk_score >= 70)),
    reasons,
  };
}

async function createCase(cid, a) {
  const e = await eligibility(cid, a.order_id);
  if (!e.found || !e.eligible) return { error: "No longer eligible", reasons: e.reasons };
  if (!e.options[a.resolution]) return { error: `${a.resolution} is not allowed for this item.`, options: e.options };
  const c = await pool.connect();
  try {
    await c.query("begin");
    const n = (await c.query("select coalesce(max(substring(case_id from 5)::int),0)+1 n from (select case_id from return_requests where case_id ~ '^CASE[0-9]+$' union select case_id from refund_requests where case_id ~ '^CASE[0-9]+$' union select case_id from replacement_requests where case_id ~ '^CASE[0-9]+$') s")).rows[0].n;
    const caseId = "CASE" + String(n).padStart(6, "0");
    const now = new Date().toISOString(), status = e.requires_manual_review ? "PENDING_MANUAL_REVIEW" : "RETURN_REQUESTED";
    await c.query(`insert into return_requests(_id,case_id,customer_id,order_id,order_item_id,product_id,product_name,return_reason,return_status,replacement_requested,refund_requested,created_at,updated_at)
                   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [randomBytes(12).toString("hex"), caseId, cid, a.order_id, e.order_item_id, e.product_id, e.product_name, a.reason, status, a.resolution !== "REFUND", a.resolution === "REFUND", now]);
    if (a.resolution === "REFUND")
      await c.query(`insert into refund_requests(_id,case_id,customer_id,order_id,order_item_id,original_product_id,original_product_name,request,status,created_at,updated_at,stock_reserved)
                     values($1,$2,$3,$4,$5,$6,$7,'Refund','REQUESTED',$8,$8,false)`,
        [randomBytes(12).toString("hex"), caseId, cid, a.order_id, e.order_item_id, e.product_id, e.product_name, now]);
    else {
      const st = await c.query("select coalesce(sum(available_quantity),0)::int n from product_variants where product_id=$1", [e.product_id]);
      await c.query(`insert into replacement_requests(_id,case_id,customer_id,order_id,order_item_id,original_product_id,original_product_name,replacement_product_id,replacement_product_name,stock_status,stock_quantity,request,status,created_at,updated_at,stock_reserved)
                     values($1,$2,$3,$4,$5,$6,$7,$6,$7,$8,$9,$10,'REQUESTED',$11,$11,false)`,
        [randomBytes(12).toString("hex"), caseId, cid, a.order_id, e.order_item_id, e.product_id, e.product_name, st.rows[0].n > 0 ? "IN_STOCK" : "OUT_OF_STOCK", st.rows[0].n, a.resolution === "EXCHANGE" ? "Exchange" : "Replacement", now]);
    }
    await c.query("delete from app_pending where customer_id=$1 and session_id=$2", [cid, a.session_id]);
    await c.query("commit");
    await audit(cid, "customer", "case_created", { caseId, order: a.order_id, resolution: a.resolution, via: "mcp" });

    // Send customer email notification via Workbench webhook
    const cust = await one("select full_name,email from customers where customer_id=$1", [cid]);
    if (cust?.email) {
      const emailSubj = `Update on Your Return Request - ${caseId}`;
      const emailBody = [
        `Dear ${cust.full_name || "Valued Customer"},`,
        ``,
        `Your return/refund request for order ${a.order_id} has been successfully received.`,
        `Case Reference ID: ${caseId}`,
        `Resolution: ${a.resolution}`,
        `Reason: ${a.reason}`,
        `Current Status: ${status}`,
        ``,
        `Our reverse logistics team is reviewing your request. We will notify you once the next step is scheduled.`,
        ``,
        `Thank you for choosing us.`,
        ``,
        `Best Regards,`,
        `Customer Support Team`,
      ].join("\n");

      postWorkbenchEmailNotification({
        customer_id: cid,
        customer_name: cust.full_name || "Customer",
        customer_email: cust.email,
        order_id: a.order_id,
        case_id: caseId,
        notification_type: "RETURN_STATUS_UPDATE",
        email_subject: emailSubj,
        email_body: emailBody,
        status: "SUCCESS",
        timestamp: new Date().toISOString(),
      }).catch((e) => console.error("[workbench-email-notify] case created:", e.message));
    }

    return { case_id: caseId, status, resolution: a.resolution, next_step: status === "PENDING_MANUAL_REVIEW" ? "A support agent will review your request." : "Pickup will be scheduled after approval." };
  } catch (err) { await c.query("rollback"); return { error: "Could not create case: " + err.message }; }
  finally { c.release(); }
}

/* ---------------- tool definitions (bound to the verified caller) ---------------- */
function registerTools(server, cid, ctx) {
  const own = (oid) => one("select * from orders where order_id=$1 and customer_id=$2", [oid, cid]);
  const T = (name, description, shape, run) =>
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      let out; try { out = await run(args); } catch (e) { out = { error: e.message }; }
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    });

  T("get_my_profile", "Profile, loyalty tier and return statistics of the logged-in customer.", {},
    () => one("select customer_id,full_name,email,phone,customer_type,account_status,loyalty,return_statistics,preferred_language from customers where customer_id=$1", [cid]));

  T("list_my_orders", "List the logged-in customer's recent orders (newest first).",
    { limit: z.number().int().min(1).max(20).default(8), status: z.string().optional().describe("Optional order status filter, e.g. DELIVERED") },
    (a) => q(`select o.order_id,o.order_date,o.order_status,o.total_amount,o.currency,o.delivered_at,o.payment_status,p.product_name,p.category
        from orders o left join products p on p.product_id=o.product_id where o.customer_id=$1 and ($2::text is null or o.order_status=$2)
        order by o.order_date desc limit $3`, [cid, a.status || null, a.limit || 8]));

  T("get_order_details", "Full details of one order (items, payment, delivery).", { order_id: z.string() }, async (a) => {
    const o = await own(a.order_id); if (!o) return { error: "Order not found on your account." };
    return { order: o,
      items: await q("select order_item_id,product_id,product_name,quantity,unit_price,total_amount,item_status,return_status from order_items where order_id=$1", [a.order_id]),
      payment: await one("select payment_id,payment_method,payment_status,amount,paid_at,refund_allowed from payments where order_id=$1", [a.order_id]) };
  });

  T("track_shipment", "Courier, tracking number and delivery milestones for an order.", { order_id: z.string() },
    async (a) => (await one("select delivery_id,tracking_number,logistics_provider,delivery_status,shipped_at,out_for_delivery_at,delivered_at from deliveries where order_id=$1 and customer_id=$2", [a.order_id, cid])) || { error: "No delivery found for this order." });

  T("check_return_eligibility", "Check if an order can be returned/refunded/replaced/exchanged under the current policy.", { order_id: z.string() },
    (a) => eligibility(cid, a.order_id));

  T("list_my_cases", "List the customer's return, refund and replacement cases.", {}, async () => ({
    returns: await q("select case_id,order_id,product_name,return_reason,return_status,pickup_status,created_at from return_requests where customer_id=$1 order by created_at desc limit 10", [cid]),
    refunds: await q("select case_id,order_id,original_product_name product_name,status,created_at from refund_requests where customer_id=$1 order by created_at desc limit 10", [cid]),
    replacements: await q("select case_id,order_id,original_product_name product_name,replacement_product_name,status,created_at from replacement_requests where customer_id=$1 order by created_at desc limit 10", [cid]) }));

  T("get_case_status", "Detailed status of one case id (e.g. CASE000012).", { case_id: z.string() }, async (a) => ({
    return_request: await one("select * from return_requests where case_id=$1 and customer_id=$2 order by created_at desc limit 1", [a.case_id, cid]),
    refund_request: await one("select * from refund_requests where case_id=$1 and customer_id=$2 order by created_at desc limit 1", [a.case_id, cid]),
    replacement_request: await one("select * from replacement_requests where case_id=$1 and customer_id=$2 order by created_at desc limit 1", [a.case_id, cid]) }));

  T("search_products", "Search the product catalogue by name/brand/category.", { query: z.string() },
    (a) => q("select product_id,product_name,brand,category,base_price,returnable,replacement_allowed,exchange_allowed,warranty_days from products where active is not false and (product_name ilike $1 or brand ilike $1 or category ilike $1 or subcategory ilike $1) limit 8", ["%" + a.query + "%"]));

  T("prepare_return_request",
    "Step 1 of raising a case: validates eligibility and stores the request as PENDING. Does NOT create a case. Afterwards show the summary and ask the customer to confirm.",
    { order_id: z.string(), reason: z.string().describe("One of policy.allowed_reasons from check_return_eligibility"), resolution: z.enum(["REFUND", "REPLACEMENT", "EXCHANGE"]) },
    async (a) => {
      const e = await eligibility(cid, a.order_id);
      if (!e.found || !e.eligible) return { error: "Not eligible", reasons: e.reasons };
      if (!e.options[a.resolution]) return { error: `${a.resolution} is not allowed for this item.`, options: e.options };
      const reason = (e.policy.allowed_reasons || []).find((r) => r.toLowerCase() === String(a.reason).toLowerCase());
      if (!reason) return { error: "Reason not allowed by policy.", allowed_reasons: e.policy.allowed_reasons };
      const payload = { order_id: a.order_id, reason, resolution: a.resolution, product_name: e.product_name, turn: ctx.turn };
      await q("insert into app_pending(customer_id,session_id,payload) values($1,$2,$3) on conflict(customer_id,session_id) do update set payload=excluded.payload,created_at=now()", [cid, ctx.sid, JSON.stringify(payload)]);
      return { status: "AWAITING_CUSTOMER_CONFIRMATION", summary: { order_id: a.order_id, reason, resolution: a.resolution, product_name: e.product_name }, requires_manual_review: e.requires_manual_review,
        instruction: "Show this summary and ask the customer to reply 'yes' to confirm. Do NOT call create_return_request in this turn." };
    });

  T("create_return_request",
    "Step 2: creates the case from the pending request. Only works if the customer's latest message is an explicit confirmation of a request prepared in an EARLIER turn.", {},
    async () => {
      const pend = await one("select payload from app_pending where customer_id=$1 and session_id=$2", [cid, ctx.sid]);
      if (!pend) return { error: "Nothing is pending. Call prepare_return_request first." };
      if (pend.payload.turn === ctx.turn) return { error: "The customer has not confirmed yet. Ask them to confirm first." };
      if (!AFFIRM.test(ctx.msg)) return { error: "The customer's latest message is not an explicit confirmation. Ask them to reply 'yes' to confirm." };
      return createCase(cid, { ...pend.payload, session_id: ctx.sid });
    });

  /* ---- Human escalation via SNS email ---- */
  T("escalate_to_human",
    "Escalate this conversation to a human support agent by sending an email notification. Use this when: the customer explicitly asks for a human, the bot cannot resolve the issue after trying, or the case requires manual review. Collect a brief reason and conversation summary before calling.",
    {
      reason: z.string().describe("One sentence: why is this being escalated? (e.g. 'Customer requested to speak with customer support.')"),
      summary: z.string().optional().describe("Summary of the customer conversation"),
      customer_message: z.string().optional().describe("The exact message from the customer requesting escalation (e.g. 'I want to talk to customer support.')"),
      case_id: z.string().optional().describe("Related case ID if one exists (e.g. CASE000012)"),
      order_id: z.string().optional().describe("Related order ID if one exists (e.g. ORD000456)"),
    },
    async (a) => {
      /* look up the customer's profile */
      const customer = await one("select full_name,email,phone from customers where customer_id=$1", [cid]);
      if (!customer) return { error: "Customer not found." };

      const reason = a.reason || "Customer requested to speak with customer support.";
      const custMsg = a.customer_message || ctx.msg || "I want to talk to customer support.";
      const summaryText = a.summary || custMsg;

      /* persist to app_escalations table */
      const escalationId = "ESC" + randomBytes(5).toString("hex").toUpperCase();
      await q(
        `insert into app_escalations(escalation_id,customer_id,session_id,reason,summary,case_id,notified_at,status)
         values($1,$2,$3,$4,$5,$6,now(),'OPEN')
         on conflict do nothing`,
        [escalationId, cid, ctx.sid, reason.slice(0, 500), summaryText.slice(0, 2000), a.case_id || null]
      );

      /* send escalation email via Workbench Support Escalation Webhook */
      let snsResult = { ok: false };
      try {
        snsResult = await sendEscalationEmail({
          customerId: cid,
          customerName: customer.full_name,
          customerEmail: customer.email,
          phone: customer.phone,
          sessionId: ctx.sid,
          reason,
          customerMessage: custMsg,
          summary: summaryText,
          caseId: a.case_id,
          orderId: a.order_id,
        });
      } catch (err) {
        console.error("[mcp] Support escalation failed:", err.message);
        snsResult = { error: err.message };
      }

      await audit(cid, "customer", "escalated_to_human", { escalationId, reason, case_id: a.case_id, result: snsResult });
      return {
        escalation_id: escalationId,
        status: "OPEN",
        message: "Your request has been escalated to our human support team. A representative will contact you via email shortly.",
        workbench_escalation: snsResult,
      };
    });

  /* ---- Send custom customer email notification directly ---- */
  T("send_customer_email_notification",
    "Send an official email notification to the customer regarding returns, refund approvals, pickup schedules, or policy updates via the Workbench webhook.",
    {
      order_id: z.string().optional().describe("Order ID, e.g. ORD000456"),
      case_id: z.string().optional().describe("Case ID, e.g. CASE000789"),
      notification_type: z.enum(["RETURN_STATUS_UPDATE", "REFUND_PROCESSED", "PICKUP_SCHEDULED", "REPLACEMENT_DISPATCHED", "HUMAN_ESCALATION", "POLICY_ALERT"]).default("RETURN_STATUS_UPDATE"),
      email_subject: z.string().describe("Clear subject line for the email"),
      email_body: z.string().describe("Complete polite email body for the customer"),
    },
    async (a) => {
      const customer = await one("select full_name,email from customers where customer_id=$1", [cid]);
      if (!customer) return { error: "Customer not found." };
      const timestamp = new Date().toISOString();
      const payload = {
        customer_id: cid,
        customer_name: customer.full_name || "Customer",
        customer_email: customer.email,
        order_id: a.order_id || null,
        case_id: a.case_id || null,
        notification_type: a.notification_type,
        email_subject: a.email_subject,
        email_body: a.email_body,
        status: "SUCCESS",
        timestamp,
      };
      const result = await postWorkbenchEmailNotification(payload);
      await audit(cid, "customer", "email_notification_sent", { payload, result });
      return {
        ok: result.ok,
        notification_type: a.notification_type,
        recipient: customer.email,
        workbench_response: result,
      };
    });
}

/* ------------------------------ HTTP / MCP transport ------------------------------ */
const readBody = (req) => new Promise((res, rej) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(d ? JSON.parse(d) : undefined); } catch (e) { rej(e); } }); req.on("error", rej); });
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") return send(res, 200, { ok: true, name: "returns-mcp" });
    if (req.url !== "/mcp") return send(res, 404, { error: "not found" });
    const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    let claims;
    try { claims = (await jwtVerify(tok, secret, { audience: "mcp" })).payload; } catch { return send(res, 401, { error: "invalid or missing token" }); }
    if (!claims.sub) return send(res, 401, { error: "token has no customer" });
    if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
    const body = await readBody(req);
    const server = new McpServer({ name: "returns-tools", version: "1.0.0" });
    registerTools(server, String(claims.sub), { sid: String(claims.sid || ""), msg: String(claims.msg || ""), turn: String(claims.turn || "") });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("[mcp] error", e);
    if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[mcp] returns-mcp listening on http://127.0.0.1:${PORT}/mcp`));
