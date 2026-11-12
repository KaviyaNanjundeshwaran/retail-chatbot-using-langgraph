import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getStore, interrupt } from "@langchain/langgraph";
import { pool, q, one } from "../db";
import { CASE_ID_SQL, CASE_STATUS, CLOSED_CASE_STATUSES, LIST_LIMITS, MANUAL_REVIEW_RISK_SCORE, MEMORY_LIMIT, RESOLUTIONS, memoryNamespace, type Resolution } from "../domain";
import { deliveryStatus, notifyCustomerCaseCreated, notifySupportEscalation } from "../notify";

/**
 * Every tool is scoped to the logged-in customer. The ids come from the run config set by the
 * server (never from the model), so a prompt-injected model cannot reach another customer's data.
 */
function caller(config: RunnableConfig) {
  const { customer_id, session_id } = config.configurable ?? {};
  if (!customer_id || !session_id) throw new Error("Tool called without customer context");
  return { cid: String(customer_id), sid: String(session_id) };
}

/** Business rules for returning one order item, evaluated against the live policy table. */
async function checkEligibility(cid: string, orderId: string) {
  const o = await one(
    `select o.order_id,o.order_status,o.delivered_at,o.product_id,p.product_name,p.category,p.image_url,
            p.returnable,p.replacement_allowed prod_repl,p.exchange_allowed prod_exch
       from orders o left join products p on p.product_id=o.product_id
      where o.order_id=$1 and o.customer_id=$2`,
    [orderId, cid]
  );
  if (!o) return { found: false as const, eligible: false, reasons: ["No such order on your account."] };

  const [item, policy, customer] = await Promise.all([
    one("select order_item_id,return_status from order_items where order_id=$1 and customer_id=$2 limit 1", [orderId, cid]),
    one("select * from policy_rules where lower(category)=lower($1) and active order by effective_from desc limit 1", [o.category ?? ""]),
    one("select risk_profile from customers where customer_id=$1", [cid]),
  ]);
  const openCase =
    item &&
    (await one(
      "select case_id,return_status from return_requests where customer_id=$1 and order_item_id=$2 and coalesce(return_status,'') <> all($3) limit 1",
      [cid, item.order_item_id, CLOSED_CASE_STATUSES]
    ));

  const delivered = o.order_status === "DELIVERED" && o.delivered_at;
  const days = delivered ? Math.floor((Date.now() - new Date(o.delivered_at).getTime()) / 86_400_000) : null;
  const reasons: string[] = [];
  if (!delivered) reasons.push(`Order is not delivered yet (status ${o.order_status}).`);
  if (o.returnable === false) reasons.push("This product is marked non-returnable.");
  if (!policy) reasons.push(`No active return policy found for category ${o.category}.`);
  if (policy && days !== null && days > Number(policy.return_window_days))
    reasons.push(`Return window of ${policy.return_window_days} days has passed (${days} days since delivery).`);
  if (item?.return_status === "RETURNED") reasons.push("This item was already returned.");
  if (openCase) reasons.push(`An open case ${openCase.case_id} (${openCase.return_status}) already exists for this item.`);

  const risk = customer?.risk_profile ?? {};
  const options: Record<Resolution, boolean> = {
    REFUND: !!(policy?.refund_allowed && o.returnable !== false),
    REPLACEMENT: !!(policy?.replacement_allowed && o.prod_repl),
    EXCHANGE: !!(policy?.exchange_allowed && o.prod_exch),
  };
  return {
    found: true as const,
    eligible: reasons.length === 0,
    reasons,
    order_id: o.order_id as string,
    order_item_id: item?.order_item_id as string | undefined,
    product_id: o.product_id as string,
    product_name: o.product_name as string,
    image_url: o.image_url as string | null,
    category: o.category as string,
    delivered_at: o.delivered_at,
    days_since_delivery: days,
    allowed_reasons: (policy?.allowed_conditions ?? []) as string[],
    options,
    requires_manual_review: !!(policy?.high_risk_requires_manual_review && (risk.risk_level === "HIGH" || risk.risk_score >= MANUAL_REVIEW_RISK_SCORE)),
  };
}

/** Inserts the case rows in one transaction; the id comes from a sequence so concurrent requests never collide. */
async function createCase(cid: string, e: Awaited<ReturnType<typeof checkEligibility>> & { found: true }, reason: string, resolution: Resolution) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(CASE_ID_SQL);
    const caseId: string = rows[0].id;
    const now = new Date().toISOString();
    const status = e.requires_manual_review ? CASE_STATUS.manualReview : CASE_STATUS.requested;
    const id = () => randomBytes(12).toString("hex");

    await client.query(
      `insert into return_requests(_id,case_id,customer_id,order_id,order_item_id,product_id,product_name,return_reason,return_status,replacement_requested,refund_requested,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [id(), caseId, cid, e.order_id, e.order_item_id, e.product_id, e.product_name, reason, status, resolution !== "REFUND", resolution === "REFUND", now]
    );
    if (resolution === "REFUND") {
      await client.query(
        `insert into refund_requests(_id,case_id,customer_id,order_id,order_item_id,original_product_id,original_product_name,request,status,created_at,updated_at,stock_reserved)
         values($1,$2,$3,$4,$5,$6,$7,'Refund','REQUESTED',$8,$8,false)`,
        [id(), caseId, cid, e.order_id, e.order_item_id, e.product_id, e.product_name, now]
      );
    } else {
      const stock = Number((await client.query("select coalesce(sum(available_quantity),0) n from product_variants where product_id=$1", [e.product_id])).rows[0].n);
      await client.query(
        `insert into replacement_requests(_id,case_id,customer_id,order_id,order_item_id,original_product_id,original_product_name,replacement_product_id,replacement_product_name,stock_status,stock_quantity,request,status,created_at,updated_at,stock_reserved)
         values($1,$2,$3,$4,$5,$6,$7,$6,$7,$8,$9,$10,'REQUESTED',$11,$11,false)`,
        [id(), caseId, cid, e.order_id, e.order_item_id, e.product_id, e.product_name, stock > 0 ? "IN_STOCK" : "OUT_OF_STOCK", stock, resolution === "EXCHANGE" ? "Exchange" : "Replacement", now]
      );
    }
    await client.query("commit");
    return { case_id: caseId, status };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

const listMyOrders = tool(
  async ({ status, limit }, config) =>
    q(
      `select o.order_id,o.order_date,o.order_status,o.total_amount,o.currency,o.delivered_at,p.product_name,p.category
         from orders o left join products p on p.product_id=o.product_id
        where o.customer_id=$1 and ($2::text is null or o.order_status=$2)
        order by o.order_date desc limit $3`,
      [caller(config).cid, status ?? null, limit]
    ),
  {
    name: "list_my_orders",
    description: "List the customer's recent orders, newest first. Use it to find which order a return is about.",
    schema: z.object({
      status: z.string().optional().describe("Optional order status filter, e.g. DELIVERED"),
      limit: z.number().int().min(1).max(LIST_LIMITS.orders.max).default(LIST_LIMITS.orders.default),
    }),
  }
);

const checkReturnEligibility = tool(async ({ order_id }, config) => checkEligibility(caller(config).cid, order_id), {
  name: "check_return_eligibility",
  description:
    "Check whether one of the customer's orders can be returned, and which resolutions (REFUND/REPLACEMENT/EXCHANGE) and reasons are allowed.",
  schema: z.object({ order_id: z.string() }),
});

const getReturnPolicy = tool(
  async ({ category }) => {
    const rows = await q(
      `select policy_name,category,return_window_days,allowed_conditions,packaging_required,seal_requirement,accessories_required,
              refund_allowed,replacement_allowed,exchange_allowed,high_risk_requires_manual_review
         from policy_rules where active and lower(category)=lower($1)`,
      [category]
    );
    if (rows.length) return rows;
    const categories = await q("select distinct category from policy_rules where active order by 1");
    return { error: `No active policy for "${category}".`, available_categories: categories.map((r) => r.category) };
  },
  {
    name: "get_return_policy",
    description: "Get the active return/refund/replacement/exchange policy for a product category.",
    schema: z.object({ category: z.string().describe("Product category, e.g. Footwear") }),
  }
);

const getMyCases = tool(
  async ({ case_id }, config) => {
    const { cid } = caller(config);
    const filter = case_id ? "and r.case_id=$3" : "";
    const params = case_id ? [cid, LIST_LIMITS.cases, case_id] : [cid, LIST_LIMITS.cases];
    const [returns, refunds, replacements] = await Promise.all([
      q(`select r.case_id,r.order_id,r.product_name,r.return_reason,r.return_status,r.pickup_status,r.created_at from return_requests r where r.customer_id=$1 ${filter} order by r.created_at desc limit $2`, params),
      q(`select r.case_id,r.order_id,r.original_product_name product_name,r.status,r.created_at from refund_requests r where r.customer_id=$1 ${filter} order by r.created_at desc limit $2`, params),
      q(`select r.case_id,r.order_id,r.original_product_name product_name,r.replacement_product_name,r.stock_status,r.status,r.created_at from replacement_requests r where r.customer_id=$1 ${filter} order by r.created_at desc limit $2`, params),
    ]);
    if (case_id && !returns.length && !refunds.length && !replacements.length) return { error: `No case ${case_id} on your account.` };
    return { returns, refunds, replacements };
  },
  {
    name: "get_my_cases",
    description: "List the customer's return, refund and replacement cases, or the details of one case id (e.g. CASE000012).",
    schema: z.object({ case_id: z.string().optional() }),
  }
);

const createReturnRequest = tool(
  async ({ order_id, reason, resolution }, config) => {
    const { cid } = caller(config);
    // On resume this tool runs again from the top, so eligibility is re-checked against fresh data before anything is written.
    const e = await checkEligibility(cid, order_id);
    if (!e.found || !e.eligible) return { error: "Not eligible", reasons: e.reasons };
    if (!e.options[resolution]) return { error: `${resolution} is not allowed for this item.`, options: e.options };
    const allowedReason = e.allowed_reasons.find((r) => r.toLowerCase() === reason.toLowerCase());
    if (!allowedReason) return { error: "Reason not allowed by policy.", allowed_reasons: e.allowed_reasons };

    // Human-in-the-loop: pause the graph until the customer confirms or cancels in the UI.
    const decision = interrupt({
      type: "confirm_return",
      order_id,
      product_name: e.product_name,
      image_url: e.image_url,
      reason: allowedReason,
      resolution,
      requires_manual_review: e.requires_manual_review,
    }) as { approved?: boolean };
    if (!decision?.approved) return { cancelled: true, message: "The customer cancelled. No case was created." };

    const created = await createCase(cid, e, allowedReason, resolution);
    const customer = await one("select customer_id,full_name,email from customers where customer_id=$1", [cid]);
    if (customer) void notifyCustomerCaseCreated(customer, { ...created, order_id, resolution, reason: allowedReason });
    return {
      ...created,
      resolution,
      next_step: created.status === CASE_STATUS.manualReview ? "A support agent will review the request." : "Pickup will be scheduled after approval.",
    };
  },
  {
    name: "create_return_request",
    description:
      "Raise a return/refund/replacement/exchange case. The customer is asked to confirm in the app before anything is created, so call it once you know the order, an allowed reason and an allowed resolution.",
    schema: z.object({
      order_id: z.string(),
      reason: z.string().describe("One of allowed_reasons from check_return_eligibility"),
      resolution: z.enum(RESOLUTIONS),
    }),
  }
);

const escalateToHuman = tool(
  async ({ reason, summary, order_id, case_id }, config) => {
    const { cid, sid } = caller(config);
    const customer = await one("select customer_id,full_name,email,phone from customers where customer_id=$1", [cid]);
    if (!customer) return { error: "Customer not found." };
    // Derived from the tool call id: if a confirm/cancel resume re-runs this step, the escalation (and its email) is not repeated.
    const callId = config.toolCall?.id ?? randomBytes(8).toString("hex");
    const escalation_id = "ESC" + createHash("sha256").update(`${cid}:${callId}`).digest("hex").slice(0, 10).toUpperCase();
    const created = await one(
      `insert into app_escalations(escalation_id,customer_id,session_id,reason,summary,case_id) values($1,$2,$3,$4,$5,$6)
       on conflict(escalation_id) do nothing returning escalation_id`,
      [escalation_id, cid, sid, reason.slice(0, 500), summary.slice(0, 2000), case_id ?? null]
    );
    if (!created) {
      const existing = await one("select notify_status from app_escalations where escalation_id=$1", [escalation_id]);
      return { escalation_id, support_notified: existing?.notify_status === "sent" };
    }
    const sent = await notifySupportEscalation(customer, { escalation_id, reason, summary, order_id, case_id });
    await q("update app_escalations set notify_status=$1 where escalation_id=$2", [deliveryStatus(sent), escalation_id]);
    return { escalation_id, support_notified: sent.ok };
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human support agent: records an escalation and emails the support team. Use when the customer asks for a human or you cannot resolve the issue.",
    schema: z.object({
      reason: z.string().describe("One sentence: why this is escalated"),
      summary: z.string().describe("2-3 sentence summary of the conversation for the support team"),
      order_id: z.string().optional(),
      case_id: z.string().optional(),
    }),
  }
);

/* ---- Long-term memory, written "in the hot path" (LangGraph memory docs): facts the customer wants kept across conversations ---- */

const saveMemory = tool(
  async ({ fact }, config) => {
    const { cid } = caller(config);
    const store = getStore()!;
    const ns = memoryNamespace(cid);
    const text = fact.trim().slice(0, 300);
    // Same fact -> same key, so repeating it does not create duplicates.
    const memory_id = createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 10);
    const existing = await store.search(ns, { limit: MEMORY_LIMIT });
    if (existing.length >= MEMORY_LIMIT && !existing.some((m) => m.key === memory_id))
      return { error: `Memory is full (${MEMORY_LIMIT} items). Ask the customer which saved item to forget first.` };
    await store.put(ns, memory_id, { text, saved_at: new Date().toISOString() });
    return { saved: true, memory_id };
  },
  {
    name: "save_memory",
    description:
      "Remember one lasting fact or preference about the customer for future conversations (e.g. preferred contact channel or language, a recurring issue). Never store payment details, passwords or other sensitive data.",
    schema: z.object({ fact: z.string().min(3).describe("One short sentence, written about the customer, e.g. 'Prefers to be contacted by email.'") }),
  }
);

const deleteMemory = tool(
  async ({ memory_id }, config) => {
    const { cid } = caller(config);
    const store = getStore()!;
    if (!(await store.get(memoryNamespace(cid), memory_id))) return { error: "No saved memory with that id." };
    await store.delete(memoryNamespace(cid), memory_id);
    return { deleted: true, memory_id };
  },
  {
    name: "delete_memory",
    description: "Forget one saved memory about the customer, by the id shown in square brackets in the remembered list.",
    schema: z.object({ memory_id: z.string() }),
  }
);

export const tools = [listMyOrders, checkReturnEligibility, getReturnPolicy, getMyCases, createReturnRequest, escalateToHuman, saveMemory, deleteMemory];
