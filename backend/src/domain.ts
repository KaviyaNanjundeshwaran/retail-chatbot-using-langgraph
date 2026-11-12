/** Business rules of the returns domain, in one place. These are product decisions, not deployment settings. */

export const RESOLUTIONS = ["REFUND", "REPLACEMENT", "EXCHANGE"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Case statuses that no longer block a new request for the same item. */
export const CLOSED_CASE_STATUSES = ["RESTOCKED", "REJECTED", "CLOSED", "COMPLETED", "CANCELLED", "REFUNDED"];

/** A customer at or above this risk score (or with risk_level HIGH) needs manual review when the policy says so. */
export const MANUAL_REVIEW_RISK_SCORE = 70;

export const CASE_STATUS = { manualReview: "PENDING_MANUAL_REVIEW", requested: "RETURN_REQUESTED" } as const;
export const ESCALATION_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"] as const;

/** Ids: CASE000123 (from a DB sequence) and ESC + 10 hex characters. */
export const CASE_ID_SQL = "select 'CASE' || lpad(nextval('app_case_seq')::text, 6, '0') id";
export const CASE_ID_PATTERN = "^CASE[0-9]+$";

/** Long-term memory (LangGraph Store): one namespace per customer, at most MEMORY_LIMIT short facts. */
export const memoryNamespace = (customerId: string) => ["customers", customerId, "memories"];
export const MEMORY_LIMIT = 20;

/** Result sizes the agent sees. */
export const LIST_LIMITS = { orders: { default: 8, max: 20 }, cases: 10, adminRows: 100, sessions: 50 } as const;
