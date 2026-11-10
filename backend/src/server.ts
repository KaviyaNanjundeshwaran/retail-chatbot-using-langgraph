import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "crypto";
import { pool, q, one, audit, bootDatabase, getSetting, DEFAULT_SETTINGS } from "@/backend/src/db/client";
import { getProvider } from "@/backend/src/llm/factory";
import {
  getCompiledGraph,
  loadLongTermMemory,
  updateLongTermMemory,
  emitters,
} from "@/backend/src/graph/workflow";
import { saveSemanticCache, clearSemanticCache } from "@/backend/src/cache/semantic";
import { reindexKnowledgeBase, policyToText, upsertKnowledgeBase } from "@/backend/src/rag/knowledge";
import {
  sendSupportEscalationEmail,
  sendCustomerEmailNotification,
  DEFAULT_SUPPORT_TEAM_EMAIL,
  postWorkbenchJson,
  WorkbenchNotificationPayload,
  WorkbenchEscalationPayload,
} from "@/backend/src/webhook/workbench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COOKIE = "rl_session";
const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || "");
type Sess = { sub: string; role: "customer" | "admin"; name: string };

async function getSession(req: NextRequest): Promise<Sess | null> {
  const t = req.cookies.get(COOKIE)?.value;
  if (!t || !process.env.JWT_SECRET) return null;
  try {
    return (await jwtVerify(t, secret())).payload as any;
  } catch {
    return null;
  }
}

const json = (data: any, status = 200) => NextResponse.json(data, { status });

const loginHits = new Map<string, number[]>();
function isLoginRateLimited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (loginHits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  loginHits.set(key, arr);
  return arr.length > max;
}

/* -------------------------------- Chat Execution -------------------------------- */
async function chat(req: NextRequest, sess: Sess) {
  const body = await req.json().catch(() => ({}));
  const message = String(body.message || "");
  const sessionId = String(body.sessionId || "").slice(0, 64) || randomUUID();
  const cid = sess.sub;
  const profile = await one(
    "select customer_id,first_name,full_name,email,phone,preferred_language from customers where customer_id=$1",
    [cid]
  );
  const turn = randomUUID();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (type: string, data: any) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
        } catch {}
      };
      emitters.set(turn, send);
      try {
        const g = await getCompiledGraph();
        const memory = await loadLongTermMemory(cid);

        const out: any = await g.invoke(
          {
            message,
            customerId: cid,
            sessionId,
            turn,
            profile,
            memory,
            cleaned: "",
            blocked: "",
            cached: false,
            intent: "",
            query: "",
            draft: "",
            final: "",
            steps: [],
            grounding: [],
            notes: [],
            cacheable: false,
            humanAppended: false,
          },
          { configurable: { turn, thread_id: `${cid}:${sessionId}` } }
        );

        const final = out.final || "";
        await q("insert into app_chat_messages(customer_id,session_id,role,content) values($1,$2,'user',$3)", [
          cid,
          sessionId,
          out.cleaned || message,
        ]);
        await q(
          "insert into app_chat_messages(customer_id,session_id,role,content,intent,meta) values($1,$2,'assistant',$3,$4,$5)",
          [
            cid,
            sessionId,
            final,
            out.intent || (out.blocked ? "blocked" : null),
            JSON.stringify({ steps: out.steps, notes: out.notes, cached: out.cached }),
          ]
        );

        send("done", { sessionId, intent: out.intent, cached: !!out.cached, notes: out.notes });

        if (out.cacheable && !out.blocked && !out.cached) {
          await saveSemanticCache(out.cleaned, final, [profile?.full_name, profile?.first_name]);
        }

        if (
          !out.blocked &&
          /prefer|always|never|remember|contact me|call me|whatsapp|email me|text me|language|usually|from now on|going forward|my name is/i.test(
            out.cleaned
          )
        ) {
          await updateLongTermMemory(cid, out.cleaned, final);
        }
      } catch (e: any) {
        console.error("chat error", e);
        send("error", {
          message: /No LLM key/.test(e.message)
            ? e.message
            : String((await getSetting("messages").catch(() => ({} as any))).error || "Error"),
        });
      } finally {
        emitters.delete(turn);
        try {
          ctrl.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/* -------------------------------- Policy Admin Helpers -------------------------------- */
const POLICY_FIELDS: Record<string, "text" | "int" | "bool" | "arr"> = {
  policy_name: "text",
  category: "text",
  return_window_days: "int",
  allowed_conditions: "arr",
  packaging_required: "bool",
  seal_requirement: "text",
  accessories_required: "bool",
  refund_allowed: "bool",
  replacement_allowed: "bool",
  exchange_allowed: "bool",
  high_risk_requires_manual_review: "bool",
  active: "bool",
};

function cleanPolicy(b: any) {
  const o: Record<string, any> = {};
  for (const [k, t] of Object.entries(POLICY_FIELDS)) {
    if (!(k in b)) continue;
    const v = b[k];
    if (t === "text") o[k] = String(v).slice(0, 200);
    else if (t === "int") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 3650) throw new Error(`${k} must be 0-3650`);
      o[k] = n;
    } else if (t === "bool") o[k] = !!v;
    else
      o[k] = JSON.stringify(
        (Array.isArray(v) ? v : String(v).split(","))
          .map((x: any) => String(x).trim().toUpperCase())
          .filter(Boolean)
      );
  }
  return o;
}

async function afterPolicyChange(id: string) {
  await clearSemanticCache();
  const p = await one("select * from policy_rules where policy_rule_id=$1", [id]);
  try {
    if (p) await upsertKnowledgeBase([{ source: "policy", id, content: policyToText(p) }]);
  } catch (e: any) {
    return "saved, but RAG index not refreshed: " + e.message;
  }
  return "ok";
}

/* -------------------------------- Admin Endpoints -------------------------------- */
async function admin(req: NextRequest, sess: Sess, path: string[], method: string) {
  const [, sub, id] = path;
  const body = method === "GET" ? {} : await req.json().catch(() => ({}));
  const who = sess.sub;

  if (sub === "stats") {
    const c = async (sql: string) => (await one(sql)).n;
    return json({
      customers: await c("select count(*)::int n from customers"),
      orders: await c("select count(*)::int n from orders"),
      cases: await c("select count(*)::int n from return_requests"),
      refunds: await c("select count(*)::int n from refund_requests"),
      replacements: await c("select count(*)::int n from replacement_requests"),
      policies: await c("select count(*)::int n from policy_rules where active"),
      messages24h: await c("select count(*)::int n from app_chat_messages where created_at > now()-interval '24 hours'"),
      cacheHits: await c("select coalesce(sum(hits),0)::int n from app_cache"),
      cacheEntries: await c("select count(*)::int n from app_cache"),
      kbDocs: await c("select count(*)::int n from app_kb"),
      intents: await q(
        "select coalesce(intent,'-') intent,count(*)::int n from app_chat_messages where role='assistant' group by 1 order by 2 desc"
      ),
      casesByStatus: await q(
        "select coalesce(return_status,'-') status,count(*)::int n from return_requests group by 1 order by 2 desc"
      ),
    });
  }

  if (sub === "policies") {
    if (method === "GET") return json(await q("select * from policy_rules order by policy_rule_id"));
    if (method === "PUT" && id) {
      let f: any;
      try {
        f = cleanPolicy(body);
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
      const keys = Object.keys(f);
      if (!keys.length) return json({ error: "Nothing to update" }, 400);
      const sets = keys.map((k, i) => `"${k}"=$${i + 2}${POLICY_FIELDS[k] === "arr" ? "::jsonb" : ""}`).join(",");
      const old = await one("select * from policy_rules where policy_rule_id=$1", [id]);
      if (!old) return json({ error: "Policy not found" }, 404);
      await q(`update policy_rules set ${sets} where policy_rule_id=$1`, [id, ...keys.map((k) => f[k])]);
      await audit(who, "admin", "policy_updated", { id, changes: f, before: old });
      return json({ ok: true, index: await afterPolicyChange(id) });
    }
    if (method === "POST") {
      let f: any;
      try {
        f = cleanPolicy(body);
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
      if (!f.policy_name || !f.category) return json({ error: "policy_name and category are required" }, 400);
      const n = (
        await one(
          "select coalesce(max(substring(policy_rule_id from 4)::int),0)+1 n from policy_rules where policy_rule_id ~ '^POL[0-9]+$'"
        )
      ).n;
      const pid = "POL" + String(n).padStart(6, "0");
      const all = {
        _id: pid,
        policy_rule_id: pid,
        effective_from: new Date().toISOString(),
        return_window_days: 7,
        allowed_conditions: "[]",
        packaging_required: true,
        seal_requirement: "ORIGINAL_PACKAGING",
        accessories_required: true,
        refund_allowed: true,
        replacement_allowed: true,
        exchange_allowed: true,
        high_risk_requires_manual_review: true,
        active: true,
        ...f,
      };
      const ks = Object.keys(all);
      await q(
        `insert into policy_rules(${ks.map((k) => `"${k}"`).join(",")}) values(${ks
          .map((k, i) => `$${i + 1}${k === "allowed_conditions" ? "::jsonb" : ""}`)
          .join(",")})`,
        ks.map((k) => (all as any)[k])
      );
      await audit(who, "admin", "policy_created", { pid, f });
      return json({ ok: true, id: pid, index: await afterPolicyChange(pid) });
    }
  }

  if (sub === "skills") {
    if (method === "GET") return json(await q("select * from app_skills order by name"));
    if (method === "PUT") {
      const b = body as any;
      if (!b.name) return json({ error: "name required" }, 400);
      await q(
        `insert into app_skills(name,agent,description,instructions,enabled) values($1,$2,$3,$4,$5)
         on conflict(name) do update set agent=excluded.agent,description=excluded.description,instructions=excluded.instructions,enabled=excluded.enabled,updated_at=now()`,
        [
          String(b.name).slice(0, 80),
          ["policy", "orders", "returns", "general", "all"].includes(b.agent) ? b.agent : "all",
          String(b.description || ""),
          String(b.instructions || ""),
          b.enabled !== false,
        ]
      );
      await audit(who, "admin", "skill_saved", { name: b.name });
      return json({ ok: true });
    }
  }

  if (sub === "settings") {
    if (method === "GET") {
      const out: any = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = await getSetting(k);
      return json(out);
    }
    if (method === "PUT") {
      const b = body as any;
      if (!DEFAULT_SETTINGS[b.key] || typeof b.value !== "object") return json({ error: "invalid setting" }, 400);
      await q(
        "insert into app_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value,updated_at=now()",
        [b.key, JSON.stringify(b.value)]
      );
      await audit(who, "admin", "settings_updated", b);
      return json({ ok: true });
    }
  }

  if (sub === "reindex" && method === "POST") {
    const r = await reindexKnowledgeBase();
    await clearSemanticCache();
    await audit(who, "admin", "kb_reindexed", r);
    return json({ ok: true, ...r });
  }

  if (sub === "clear-cache" && method === "POST") {
    await clearSemanticCache();
    await audit(who, "admin", "cache_cleared");
    return json({ ok: true });
  }

  if (sub === "conversations") {
    return json(
      await q(
        "select m.id,m.customer_id,c.full_name,m.session_id,m.role,m.content,m.intent,m.meta,m.created_at from app_chat_messages m left join customers c on c.customer_id=m.customer_id order by m.id desc limit 100"
      )
    );
  }

  if (sub === "audit") {
    return json(await q("select * from app_audit order by id desc limit 100"));
  }

  if (sub === "escalations") {
    if (method === "GET")
      return json(
        await q(
          "select e.*,c.full_name,c.email from app_escalations e left join customers c on c.customer_id=e.customer_id order by e.notified_at desc limit 100"
        )
      );
    if (method === "PUT" && id) {
      const b2 = body as any;
      await q(
        "update app_escalations set status=$1,resolved_at=case when $1='RESOLVED' then now() else resolved_at end,resolved_by=$2,notes=$3 where escalation_id=$4",
        [b2.status || "OPEN", who, b2.notes || null, id]
      );
      await audit(who, "admin", "escalation_updated", { id, status: b2.status });
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
}

/* -------------------------------- Main Request Dispatcher -------------------------------- */
async function handle(req: NextRequest, method: string) {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  try {
    if (!process.env.PG_URI || !process.env.JWT_SECRET)
      return json({ error: "Server not configured (PG_URI / JWT_SECRET)." }, 500);

    await bootDatabase();

    if (method !== "GET") {
      const o = req.headers.get("origin");
      if (o && new URL(o).host !== req.headers.get("host")) return json({ error: "Bad origin" }, 403);
    }

    const [a, b] = path;

    // Authentication routes
    if (a === "auth") {
      if (b === "login" && method === "POST") {
        const { role, email, password } = await req.json().catch(() => ({} as any));
        if (!email || !password || !["customer", "admin"].includes(role))
          return json({ error: "Email, password and role are required." }, 400);

        if (isLoginRateLimited("login:" + String(email).toLowerCase(), 8, 600000))
          return json({ error: "Too many attempts. Try again in a few minutes." }, 429);

        let user: any;
        let sess: Sess | null = null;
        if (role === "customer") {
          user = await one(
            "select customer_id,full_name,password,account_status from customers where lower(email)=lower($1)",
            [email]
          );
          if (
            user &&
            (await bcrypt.compare(String(password), user.password || "")) &&
            String(user.account_status).toUpperCase() === "ACTIVE"
          ) {
            sess = { sub: user.customer_id, role: "customer", name: user.full_name };
          }
        } else {
          user = await one("select id,name,password_hash from app_admins where lower(email)=lower($1)", [email]);
          if (user && (await bcrypt.compare(String(password), user.password_hash))) {
            sess = { sub: "admin:" + user.id, role: "admin", name: user.name || "Admin" };
          }
        }

        if (!sess) {
          await audit(String(email), role, "login_failed");
          return json({ error: "Invalid credentials." }, 401);
        }

        const token = await new SignJWT({ role: sess.role, name: sess.name })
          .setSubject(sess.sub)
          .setProtectedHeader({ alg: "HS256" })
          .setExpirationTime("8h")
          .sign(secret());

        const res = json({ ok: true, role: sess.role, name: sess.name });
        res.cookies.set(COOKIE, token, {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 8 * 3600,
        });
        await audit(sess.sub, sess.role, "login");
        return res;
      }

      if (b === "logout") {
        const res = json({ ok: true });
        res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
        return res;
      }

      if (b === "me") {
        const s = await getSession(req);
        if (!s) return json({ user: null });
        const profile =
          s.role === "customer"
            ? await one(
                "select customer_id,full_name,first_name,email,customer_type,loyalty from customers where customer_id=$1",
                [s.sub]
              )
            : null;
        return json({
          user: {
            id: s.sub,
            role: s.role,
            name: s.name,
            profile,
            llm: (() => {
              try {
                return getProvider();
              } catch {
                return null;
              }
            })(),
          },
        });
      }
    }

    // Webhook Endpoints
    if (a === "webhook") {
      if (b === "escalate" && method === "POST") {
        const whSecret = process.env.WEBHOOK_SECRET || process.env.JWT_SECRET;
        const authHdr = req.headers.get("authorization") || "";
        if (whSecret && !authHdr.includes(whSecret)) return json({ error: "Unauthorized" }, 401);

        const body3 = await req.json().catch(() => ({} as any));
        const { customer_id, session_id, reason, summary, customer_message, case_id, order_id } = body3;
        if (!customer_id || !session_id) return json({ error: "customer_id and session_id are required" }, 400);

        const customer = await one("select full_name,email,phone from customers where customer_id=$1", [customer_id]);
        if (!customer) return json({ error: "Customer not found" }, 404);

        const escalationId = "ESC" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
        await q(
          "insert into app_escalations(escalation_id,customer_id,session_id,reason,summary,case_id,notified_at,status) values($1,$2,$3,$4,$5,$6,now(),'OPEN')",
          [escalationId, customer_id, session_id, reason || "Customer requested customer support.", summary || "", case_id || null]
        );

        let snsResult: any = { ok: false };
        try {
          snsResult = await sendSupportEscalationEmail({
            customerId: customer_id,
            customerName: customer.full_name,
            customerEmail: customer.email,
            phone: customer.phone,
            orderId: order_id,
            caseId: case_id,
            reason: reason || "Customer requested to speak with customer support.",
            customerMessage: customer_message || "I want to talk to customer support.",
          });
        } catch (e: any) {
          snsResult = { error: e.message };
        }

        await audit(customer_id, "webhook", "escalated_to_human", { escalationId, reason, result: snsResult });
        return json({ ok: true, escalationId, result: snsResult });
      }

      if (b === "support-escalation-email" && method === "POST") {
        const bodyEsc = await req.json().catch(() => ({} as any));
        const { support_team_email, email_subject, email_body, notification_type, priority, escalation_status } =
          bodyEsc;
        if (!email_subject || !email_body) return json({ error: "email_subject and email_body are required" }, 400);

        const payload: WorkbenchEscalationPayload = {
          support_team_email: support_team_email || DEFAULT_SUPPORT_TEAM_EMAIL,
          email_subject,
          email_body,
          notification_type: notification_type || "HUMAN_ESCALATION",
          priority: priority || "HIGH",
          escalation_status: escalation_status || "PENDING",
        };
        const result = await postWorkbenchJson(
          process.env.SNS_WORKBENCH_ESCALATION_URL ||
            "https://api.agents.snsihub.ai/webhook/support-escalation-email",
          payload
        );
        return json({ ok: result.ok, workbench: result, payload });
      }

      if (b === "customer-email-notification" && method === "POST") {
        const body4 = await req.json().catch(() => ({} as any));
        const { customer_id, customer_name, customer_email, order_id, case_id, notification_type, email_subject, email_body, status, timestamp } = body4;
        if (!customer_email || !email_subject || !email_body) {
          return json({ error: "customer_email, email_subject and email_body are required" }, 400);
        }
        const payload: WorkbenchNotificationPayload = {
          customer_id: customer_id || "UNKNOWN",
          customer_name: customer_name || "Valued Customer",
          customer_email,
          order_id: order_id || null,
          case_id: case_id || null,
          notification_type: notification_type || "RETURN_STATUS_UPDATE",
          email_subject,
          email_body,
          status: status || "SUCCESS",
          timestamp: timestamp || new Date().toISOString(),
        };
        const result = await sendCustomerEmailNotification(payload);
        return json({ ok: result.ok, workbench: result, payload });
      }
    }

    // Protected customer and admin routes
    const sess = await getSession(req);
    if (!sess) return json({ error: "Not authenticated" }, 401);

    if (a === "admin") {
      if (sess.role !== "admin") return json({ error: "Forbidden" }, 403);
      return admin(req, sess, path, method);
    }

    if (a === "chat") {
      if (sess.role !== "customer") return json({ error: "Forbidden" }, 403);
      if (!b && method === "POST") return chat(req, sess);

      if (b === "sessions") {
        return json(
          await q(
            `select session_id,min(created_at) started,max(created_at) updated,
             (array_agg(content order by id) filter (where role='user'))[1] title
             from app_chat_messages where customer_id=$1 group by session_id order by max(created_at) desc limit 30`,
            [sess.sub]
          )
        );
      }

      if (b === "history") {
        const sid = new URL(req.url).searchParams.get("sessionId") || "";
        return json(
          await q(
            "select role,content,intent,created_at from app_chat_messages where customer_id=$1 and session_id=$2 order by id",
            [sess.sub, sid]
          )
        );
      }

      if (b === "suggestions") {
        const out: string[] = [];
        const o = await one(
          "select o.order_id,o.order_status,p.product_name from orders o left join products p on p.product_id=o.product_id where o.customer_id=$1 and o.order_status='DELIVERED' order by o.delivered_at desc nulls last limit 1",
          [sess.sub]
        );
        if (o) {
          out.push(`Can I return ${o.product_name}?`);
          out.push(`I want a refund for order ${o.order_id}`);
        }
        const c = await one(
          "select case_id from return_requests where customer_id=$1 order by created_at desc limit 1",
          [sess.sub]
        );
        if (c) out.push(`What's the status of ${c.case_id}?`);
        const pol = await one("select category from policy_rules where active order by random() limit 1");
        if (pol) out.push(`What is the replacement policy for ${pol.category}?`);
        return json(out);
      }

      if (b === "escalate" && method === "POST") {
        const body2 = await req.json().catch(() => ({} as any));
        const sessionId = String(body2.sessionId || "").slice(0, 64);
        const reason = String(body2.reason || "Customer requested to speak with customer support.").slice(0, 500);
        const custMsg = String(body2.customerMessage || "I want to talk to customer support.").slice(0, 500);
        const hist = await q(
          "select role,content from app_chat_messages where customer_id=$1 and session_id=$2 order by id desc limit 8",
          [sess.sub, sessionId]
        );
        const summary =
          hist
            .reverse()
            .map((m: any) => `${m.role === "user" ? "Customer" : "Bot"}: ${String(m.content).slice(0, 300)}`)
            .join("\n") || custMsg;

        const profile2 = await one("select full_name,email,phone from customers where customer_id=$1", [sess.sub]);
        const lastOrder = await one(
          "select order_id from orders where customer_id=$1 order by order_date desc limit 1",
          [sess.sub]
        );
        const lastCase = await one(
          "select case_id from return_requests where customer_id=$1 order by created_at desc limit 1",
          [sess.sub]
        );
        const escalationId = "ESC" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

        await q(
          "insert into app_escalations(escalation_id,customer_id,session_id,reason,summary,case_id,notified_at,status) values($1,$2,$3,$4,$5,$6,now(),'OPEN')",
          [escalationId, sess.sub, sessionId, reason, summary, lastCase?.case_id || null]
        );

        let snsResult: any = { ok: false };
        try {
          snsResult = await sendSupportEscalationEmail({
            customerId: sess.sub,
            customerName: profile2?.full_name || sess.name,
            customerEmail: profile2?.email || "",
            phone: profile2?.phone || "",
            orderId: lastOrder?.order_id,
            caseId: lastCase?.case_id,
            reason,
            customerMessage: custMsg,
          });
        } catch (e: any) {
          snsResult = { error: e.message };
        }

        await audit(sess.sub, "customer", "escalated_to_human", { escalationId, reason, result: snsResult });
        return json({
          ok: true,
          escalationId,
          message: "A support agent has been notified by email and will follow up with you shortly.",
          workbench: snsResult,
        });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e: any) {
    console.error("api error", path.join("/"), e);
    return json({ error: "Server error: " + e.message }, 500);
  }
}

export const GET = (r: NextRequest) => handle(r, "GET");
export const POST = (r: NextRequest) => handle(r, "POST");
export const PUT = (r: NextRequest) => handle(r, "PUT");

