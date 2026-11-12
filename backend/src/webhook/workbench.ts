const WORKBENCH_NOTIFICATION_URL =
  process.env.SNS_WORKBENCH_NOTIFICATION_URL ||
  "https://api.agents.snsihub.ai/webhook/customer-email-notification";

const WORKBENCH_ESCALATION_URL =
  process.env.SNS_WORKBENCH_ESCALATION_URL ||
  "https://api.agents.snsihub.ai/webhook/support-escalation-email";

export const DEFAULT_SUPPORT_TEAM_EMAIL =
  process.env.SUPPORT_TEAM_EMAIL || "support@retail.local";

export interface WorkbenchNotificationPayload {
  customer_id: string;
  customer_name: string;
  customer_email: string;
  order_id?: string | null;
  case_id?: string | null;
  notification_type: string;
  email_subject: string;
  email_body: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  timestamp: string;
}

export interface WorkbenchEscalationPayload {
  support_team_email: string;
  email_subject: string;
  email_body: string;
  notification_type: "HUMAN_ESCALATION";
  priority: "HIGH" | "NORMAL" | "LOW";
  escalation_status: "PENDING" | "RESOLVED";
}

export async function postWorkbenchJson(url: string, payload: any) {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
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
    const txt = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(txt);
    } catch {
      parsed = { raw: txt };
    }
    return { ok: res.ok, status: res.status, data: parsed };
  } catch (err: any) {
    console.error(`[workbench-post] error for ${url}:`, err.message);
    return { ok: false, error: err.message };
  }
}

export async function sendCustomerEmailNotification(payload: WorkbenchNotificationPayload) {
  return postWorkbenchJson(WORKBENCH_NOTIFICATION_URL, payload);
}

export async function sendSupportEscalationEmail(opts: {
  customerId: string;
  customerName: string;
  customerEmail: string;
  phone?: string;
  orderId?: string;
  caseId?: string;
  reason: string;
  customerMessage: string;
}) {
  const subject = `Human Support Escalation Request - Customer ${opts.customerId}`;
  const body = [
    `Hello Customer Support Team,`,
    ``,
    `A customer has requested to speak with a human support representative through the Retail Customer Chatbot.`,
    ``,
    `Customer Details:`,
    `-------------------------`,
    `Customer ID: ${opts.customerId}`,
    `Customer Name: ${opts.customerName || "Customer"}`,
    `Customer Email: ${opts.customerEmail || "Not provided"}`,
    `Phone Number: ${opts.phone || "Not provided"}`,
    opts.orderId ? `Order ID: ${opts.orderId}` : null,
    opts.caseId ? `Case ID: ${opts.caseId}` : null,
    ``,
    `Escalation Details:`,
    `-------------------------`,
    `Reason: ${opts.reason || "Customer requested to speak with customer support."}`,
    `Customer Message: ${opts.customerMessage || "I want to talk to customer support."}`,
    ``,
    `Please review this request and contact the customer to provide further assistance.`,
    ``,
    `Best Regards,`,
    `Retail Customer Support Chatbot`,
  ]
    .filter(Boolean)
    .join("\n");

  const payload: WorkbenchEscalationPayload = {
    support_team_email: DEFAULT_SUPPORT_TEAM_EMAIL,
    email_subject: subject,
    email_body: body,
    notification_type: "HUMAN_ESCALATION",
    priority: "HIGH",
    escalation_status: "PENDING",
  };

  const wbResult = await postWorkbenchJson(WORKBENCH_ESCALATION_URL, payload);
  return { result: wbResult, payload };
}

