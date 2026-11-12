import { env } from "./config";

export type NotifyResult = { ok: boolean; status?: number; error?: string };

/** Short delivery status stored next to the record that triggered the email. */
export const deliveryStatus = (r: NotifyResult) => (r.ok ? "sent" : `failed: ${r.status ? `HTTP ${r.status}` : r.error}`);

/**
 * POSTs JSON to an SNS Agent Workbench webhook. Retries once on a network error or 5xx (4xx means the request
 * itself is wrong, so retrying would not help). Never throws: a failed email must not fail the chat turn.
 */
async function post(url: string, payload: unknown, attempt = 1): Promise<NotifyResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.SNS_WORKBENCH_API_KEY) {
    headers.Authorization = `Bearer ${env.SNS_WORKBENCH_API_KEY}`;
    headers["x-api-key"] = env.SNS_WORKBENCH_API_KEY;
  }
  let result: NotifyResult;
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(env.WORKBENCH_TIMEOUT_MS) });
    result = { ok: res.ok, status: res.status };
  } catch (e: any) {
    result = { ok: false, error: e.message };
  }
  if (!result.ok && attempt === 1 && (!result.status || result.status >= 500)) return post(url, payload, 2);
  if (!result.ok) console.error(`[notify] ${url} ${deliveryStatus(result)} after ${attempt} attempt(s)`);
  return result;
}

type Customer = { customer_id: string; full_name?: string | null; email?: string | null; phone?: string | null };

export function notifyCustomerCaseCreated(c: Customer, kase: { case_id: string; order_id: string; resolution: string; reason: string; status: string }) {
  if (!c.email) return Promise.resolve<NotifyResult>({ ok: false, error: "customer has no email" });
  const body = [
    `Dear ${c.full_name || "Valued Customer"},`,
    "",
    `Your return/refund request for order ${kase.order_id} has been successfully received.`,
    `Case Reference ID: ${kase.case_id}`,
    `Resolution: ${kase.resolution}`,
    `Reason: ${kase.reason}`,
    `Current Status: ${kase.status}`,
    "",
    "Our reverse logistics team is reviewing your request. We will notify you once the next step is scheduled.",
    "",
    "Best Regards,",
    "Customer Support Team",
  ].join("\n");
  return post(env.SNS_WORKBENCH_NOTIFICATION_URL, {
    customer_id: c.customer_id,
    customer_name: c.full_name || "Customer",
    customer_email: c.email,
    order_id: kase.order_id,
    case_id: kase.case_id,
    notification_type: "RETURN_STATUS_UPDATE",
    email_subject: `Update on Your Return Request - ${kase.case_id}`,
    email_body: body,
    status: "SUCCESS",
    timestamp: new Date().toISOString(),
  });
}

export function notifySupportEscalation(c: Customer, e: { escalation_id: string; reason: string; summary: string; order_id?: string; case_id?: string }) {
  const body = [
    "Hello Customer Support Team,",
    "",
    `A customer has requested to speak with a human support representative through the ${env.APP_NAME}.`,
    "",
    `Escalation ID: ${e.escalation_id}`,
    `Customer ID: ${c.customer_id}`,
    `Customer Name: ${c.full_name || "Customer"}`,
    `Customer Email: ${c.email || "Not provided"}`,
    `Phone Number: ${c.phone || "Not provided"}`,
    ...(e.order_id ? [`Order ID: ${e.order_id}`] : []),
    ...(e.case_id ? [`Case ID: ${e.case_id}`] : []),
    "",
    `Reason: ${e.reason}`,
    `Summary: ${e.summary}`,
    "",
    "Please review this request and contact the customer.",
  ].join("\n");
  return post(env.SNS_WORKBENCH_ESCALATION_URL, {
    support_team_email: env.SUPPORT_TEAM_EMAIL,
    email_subject: `Human Support Escalation Request - Customer ${c.customer_id}`,
    email_body: body,
    notification_type: "HUMAN_ESCALATION",
    priority: "HIGH",
    escalation_status: "PENDING",
  });
}
