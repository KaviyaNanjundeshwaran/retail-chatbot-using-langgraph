import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "../llm/factory";

const G = globalThis as any;
const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:3333/mcp";

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || "");

export const isMcpUp = async () => {
  try {
    return (await fetch(MCP_URL.replace(/\/mcp$/, "/health"), { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};

export async function ensureMcpServer() {
  if (await isMcpUp()) return;
  if (process.env.MCP_URL) throw new Error("MCP server not reachable at " + MCP_URL);
  if (!G.__mcpProc || G.__mcpProc.exitCode !== null) {
    const candidates = [
      path.resolve(__dirname, "../../mcp-server.mjs"),
      path.join(process.cwd(), "mcp-server.mjs"),
      path.join(process.cwd(), "backend", "mcp-server.mjs"),
    ];
    const serverPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];
    G.__mcpProc = spawn(process.execPath, [serverPath], {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    process.once("exit", () => {
      try {
        G.__mcpProc?.kill();
      } catch {}
    });
  }
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if (await isMcpUp()) return;
  }
  throw new Error("MCP server failed to start (run `node mcp-server.mjs` to test)");
}

export function jsToZod(sc: any): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (sc?.enum) t = z.enum(sc.enum as [string, ...string[]]);
  else {
    switch (sc?.type) {
      case "integer": {
        let n = z.number().int();
        if (typeof sc.minimum === "number") n = n.min(sc.minimum);
        if (typeof sc.maximum === "number") n = n.max(sc.maximum);
        t = n;
        break;
      }
      case "number":
        t = z.number();
        break;
      case "boolean":
        t = z.boolean();
        break;
      case "array":
        t = z.array(jsToZod(sc.items || {}));
        break;
      default:
        t = z.string();
    }
  }
  return sc?.description ? t.describe(sc.description) : t;
}

export function toZodObject(schema: any) {
  const shape: Record<string, z.ZodTypeAny> = {};
  const req = new Set<string>(schema?.required || []);
  for (const [k, v] of Object.entries<any>(schema?.properties || {})) {
    const t = jsToZod(v);
    shape[k] = req.has(k) ? t : t.optional();
  }
  return z.object(shape);
}

export async function createMcpClient(
  customerId: string,
  ctx: { message: string; sessionId: string; turn: string },
  grounding: string[],
  steps: string[]
) {
  await ensureMcpServer();
  const token = await new SignJWT({ sid: ctx.sessionId, msg: ctx.message, turn: ctx.turn })
    .setSubject(customerId)
    .setAudience("mcp")
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(secret());

  const client = new Client({ name: "returns-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );

  const listed = await client.listTools();
  const byName = (names?: string[]) =>
    listed.tools
      .filter((t) => !names || names.includes(t.name))
      .map((t) =>
        tool(
          async (args: any) => {
            const r: any = await client.callTool({ name: t.name, arguments: args });
            const txt = (r.content || []).map((c: any) => c.text || "").join("");
            grounding.push(txt);
            steps.push(`mcp:${t.name}`);
            return txt;
          },
          { name: t.name, description: t.description || "", schema: toZodObject(t.inputSchema) }
        )
      );

  return { byName, close: () => client.close() };
}

