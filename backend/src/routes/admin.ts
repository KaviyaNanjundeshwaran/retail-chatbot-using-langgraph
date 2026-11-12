import { Router } from "express";
import { z } from "zod";
import type { ChatGraph } from "../agent/graph";
import { q, one } from "../db";
import { ESCALATION_STATUSES, LIST_LIMITS } from "../domain";
import { requireRole } from "../http";
import { pendingConfirmation, transcript } from "./chat";

const policy = z.object({
  policy_name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(200),
  return_window_days: z.coerce.number().int().min(0).max(3650),
  allowed_conditions: z.array(z.string().trim().toUpperCase().min(1)),
  seal_requirement: z.string().max(200).default(""),
  packaging_required: z.boolean(),
  accessories_required: z.boolean(),
  refund_allowed: z.boolean(),
  replacement_allowed: z.boolean(),
  exchange_allowed: z.boolean(),
  high_risk_requires_manual_review: z.boolean(),
  active: z.boolean(),
});
const COLUMNS = Object.keys(policy.shape);
const escalationUpdate = z.object({ status: z.enum(ESCALATION_STATUSES), notes: z.string().max(2000).optional() });

export function adminRouter(graph: ChatGraph) {
  const router = Router();
  router.use(requireRole("admin"));

  router.get("/policies", async (_req, res) => res.json(await q("select * from policy_rules order by policy_rule_id")));

  router.post("/policies", async (req, res) => {
    const p = policy.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const values = COLUMNS.map((c) => (c === "allowed_conditions" ? JSON.stringify(p.data.allowed_conditions) : p.data[c as keyof typeof p.data]));
    // shortcut: max()+1 ids can collide if two admins create a policy in the same instant; use a sequence if that becomes real.
    const row = await one(
      `insert into policy_rules(_id,policy_rule_id,effective_from,${COLUMNS.join(",")})
       select id, id, now()::text, ${COLUMNS.map((_, i) => `$${i + 1}`).join(",")}
         from (select 'POL' || lpad((coalesce(max(substring(policy_rule_id from 4)::int),0)+1)::text, 6, '0') id
                 from policy_rules where policy_rule_id ~ '^POL[0-9]+$') n
       returning policy_rule_id`,
      values
    );
    res.json({ ok: true, id: row.policy_rule_id });
  });

  router.put("/policies/:id", async (req, res) => {
    const p = policy.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const values = COLUMNS.map((c) => (c === "allowed_conditions" ? JSON.stringify(p.data.allowed_conditions) : p.data[c as keyof typeof p.data]));
    const row = await one(
      `update policy_rules set ${COLUMNS.map((c, i) => `${c}=$${i + 2}`).join(",")} where policy_rule_id=$1 returning policy_rule_id`,
      [req.params.id, ...values]
    );
    if (!row) return res.status(404).json({ error: "Policy not found." });
    res.json({ ok: true });
  });

  router.get("/escalations", async (_req, res) =>
    res.json(
      await q(
        `select e.*,c.full_name,c.email from app_escalations e left join customers c on c.customer_id=e.customer_id order by e.notified_at desc limit ${LIST_LIMITS.adminRows}`
      )
    )
  );

  router.put("/escalations/:id", async (req, res) => {
    const u = escalationUpdate.safeParse(req.body);
    if (!u.success) return res.status(400).json({ error: "Invalid status." });
    const row = await one(
      `update app_escalations set status=$1, notes=coalesce($2,notes), resolved_by=$3,
              resolved_at=case when $1='RESOLVED' then now() else null end
        where escalation_id=$4 returning escalation_id`,
      [u.data.status, u.data.notes ?? null, res.locals.user.id, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Escalation not found." });
    res.json({ ok: true });
  });

  router.get("/conversations", async (_req, res) =>
    res.json(
      await q(
        `select s.customer_id,c.full_name,s.session_id,s.title,s.updated_at
           from app_chat_sessions s left join customers c on c.customer_id=s.customer_id
          order by s.updated_at desc limit ${LIST_LIMITS.adminRows}`
      )
    )
  );

  router.get("/conversations/:customerId/:sessionId", async (req, res) => {
    const state = await graph.getState({ configurable: { thread_id: `${req.params.customerId}:${req.params.sessionId}` } });
    res.json({ messages: transcript(state.values.messages), pending: pendingConfirmation(state) });
  });

  return router;
}
