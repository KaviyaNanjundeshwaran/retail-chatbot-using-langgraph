import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { q } from "../db/client";

export async function createSkillTools(agentName: string) {
  const rows = await q(
    "select name,description,instructions,agent from app_skills where enabled and agent in ($1,'all')",
    [agentName]
  );
  const listing =
    rows
      .map((r: any) => `- ${r.name} (${r.description}): ${String(r.instructions || "").replace(/\s*\n+\s*/g, " ")}`)
      .join("\n") || "(none)";

  const t = tool(
    async ({ name }: any) => {
      const match = rows.find((r: any) => r.name === name);
      return match?.instructions || "Unknown skill.";
    },
    {
      name: "load_skill",
      description: "Load the step-by-step instructions of a skill by name before acting.",
      schema: z.object({ name: z.string() }),
    }
  );

  return { listing, tool: t, rows };
}

