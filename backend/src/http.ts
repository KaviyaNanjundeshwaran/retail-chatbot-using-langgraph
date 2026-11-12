import type { NextFunction, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { env } from "./config";

export type User = { id: string; role: "customer" | "admin"; name: string };

export const SESSION_COOKIE = "rl_session";
const key = new TextEncoder().encode(env.JWT_SECRET);

export const signSession = (u: User) =>
  new SignJWT({ role: u.role, name: u.name }).setSubject(u.id).setProtectedHeader({ alg: "HS256" }).setExpirationTime(`${env.SESSION_TTL_HOURS}h`).sign(key);

export async function readSession(req: Request): Promise<User | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return { id: String(payload.sub), role: payload.role as User["role"], name: String(payload.name ?? "") };
  } catch {
    return null;
  }
}

/** Route guard: 401 without a session, 403 for the wrong role. Sets res.locals.user. */
export const requireRole = (role: User["role"]) => async (req: Request, res: Response, next: NextFunction) => {
  const user = await readSession(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (user.role !== role) return res.status(403).json({ error: "Forbidden" });
  res.locals.user = user;
  next();
};

const hits = new Map<string, number[]>();
/** Sliding-window limiter. shortcut: in-memory, so per process; move to Redis/Postgres when running more than one instance. */
export function rateLimited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (now - v[v.length - 1] > windowMs) hits.delete(k);
  return recent.length > max;
}
