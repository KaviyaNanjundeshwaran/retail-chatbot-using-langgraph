import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "../config";
import { one } from "../db";
import { SESSION_COOKIE, rateLimited, readSession, signSession, type User } from "../http";

const loginBody = z.object({ role: z.enum(["customer", "admin"]), email: z.string().email(), password: z.string().min(1) });

export function authRouter() {
  const router = Router();

  router.post("/login", async (req, res) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Email, password and role are required." });
    const { role, email, password } = parsed.data;
    if (rateLimited("login:" + email.toLowerCase(), env.LOGIN_MAX_ATTEMPTS, env.LOGIN_WINDOW_MINUTES * 60_000))
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });

    let user: User | null = null;
    if (role === "customer") {
      const c = await one("select customer_id,full_name,password,account_status from customers where lower(email)=lower($1)", [email]);
      if (c?.password && String(c.account_status).toUpperCase() === "ACTIVE" && (await bcrypt.compare(password, c.password)))
        user = { id: c.customer_id, role, name: c.full_name };
    } else {
      const a = await one("select id,name,password_hash from app_admins where lower(email)=lower($1)", [email]);
      if (a && (await bcrypt.compare(password, a.password_hash))) user = { id: `admin:${a.id}`, role, name: a.name || "Admin" };
    }
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    res.cookie(SESSION_COOKIE, await signSession(user), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
    });
    res.json({ user });
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  router.get("/me", async (req, res) => res.json({ user: await readSession(req) }));

  return router;
}
