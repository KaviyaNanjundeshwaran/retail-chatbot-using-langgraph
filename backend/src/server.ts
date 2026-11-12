import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import type { ChatGraph } from "./agent/graph";
import { env } from "./config";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { chatRouter } from "./routes/chat";

export function createApp(graph: ChatGraph) {
  const app = express();
  const allowedOrigins = new Set([new URL(env.FRONTEND_URL).origin]);

  app.use(cors({ origin: [...allowedOrigins], credentials: true }));
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());

  // CSRF defence in addition to SameSite=Lax cookies: a browser always sends Origin on cross-site writes.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "Bad origin" });
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter());
  app.use("/api/chat", chatRouter(graph));
  app.use("/api/admin", adminRouter(graph));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Express 5 forwards async errors here. Log the detail, return a generic message.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api]", err);
    if (res.headersSent) return res.end();
    res.status(err.status ?? 500).json({ error: err.expose ? err.message : "Internal server error" });
  });

  return app;
}
