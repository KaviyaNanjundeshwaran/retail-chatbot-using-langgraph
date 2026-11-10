import { BaseMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { getLlm, textOfMessage } from "../llm/factory";
import { getSetting } from "../db/client";
import { createSkillTools } from "../skills/loader";
import { createMcpClient } from "../mcp/client";
import { createRagTool, searchKnowledgeBase } from "../rag/knowledge";
import { getSubAgentPrompt } from "../prompts/system";

export type SubAgentType = "policy" | "orders" | "returns" | "general";

const firstHuman = (h: BaseMessage[]) => {
  const a = [...h];
  while (a.length && a[0]._getType() !== "human") a.shift();
  return a;
};

export async function executeSubAgent(
  agent: SubAgentType,
  state: any,
  emitStep: (label: string) => void
) {
  emitStep(`Running ${agent} specialist`);
  const grounding: string[] = [];
  const steps: string[] = [];
  const cs = await getSetting("chat");
  const gr = await getSetting("guardrails");
  const sk = await createSkillTools(agent);

  const mcp = await createMcpClient(
    state.customerId,
    { message: state.cleaned, sessionId: state.sessionId, turn: state.turn },
    grounding,
    steps
  );

  try {
    const tools: any[] = [sk.tool];
    if (agent !== "general") tools.push(createRagTool(steps, grounding));

    if (agent === "orders") {
      tools.push(
        ...mcp.byName([
          "get_my_profile",
          "list_my_orders",
          "get_order_details",
          "list_my_cases",
          "get_case_status",
          "escalate_to_human",
          "send_customer_email_notification",
        ])
      );
    }
    if (agent === "returns") {
      tools.push(...mcp.byName());
    }
    if (agent === "policy") {
      tools.push(...mcp.byName(["search_products", "escalate_to_human"]));
    }
    if (agent === "general") {
      tools.push(
        ...mcp.byName([
          "get_my_profile",
          "escalate_to_human",
          "send_customer_email_notification",
        ])
      );
    }

    let pre = "";
    if (agent === "policy") {
      const r = await searchKnowledgeBase(state.query, 5);
      pre = r.map((x: any) => `[${x.source}:${x.source_id}] ${x.content}`).join("\n");
      grounding.push(pre);
    }

    const systemPrompt = getSubAgentPrompt(
      agent,
      state.profile?.full_name || "Customer",
      state.customerId,
      gr.scope,
      sk.listing,
      state.memory,
      pre
    );

    const model = getLlm().bindTools(tools);
    const recent = (state.messages || []).slice(-((cs.history_window || 10) + 1));
    const msgs: BaseMessage[] = [new SystemMessage(systemPrompt), ...firstHuman(recent)];

    let text = "";
    for (let i = 0; i < (cs.max_tool_steps || 6); i++) {
      const res: any = await model.invoke(msgs);
      msgs.push(res);
      if (!res.tool_calls?.length) {
        text = textOfMessage(res);
        break;
      }
      for (const c of res.tool_calls) {
        const t = tools.find((x) => x.name === c.name);
        let out: string;
        try {
          out = t ? String(await t.invoke(c.args)) : "Unknown tool";
        } catch (e: any) {
          out = "Error: " + e.message;
        }
        msgs.push(new ToolMessage({ content: out, tool_call_id: c.id, name: c.name }));
      }
    }

    if (!text) {
      return {
        blocked: "incomplete",
        grounding: [...(state.grounding || []), ...grounding],
        steps: [...(state.steps || []), ...steps],
        notes: [...(state.notes || []), "agent_incomplete"],
      };
    }

    const cacheable = agent === "policy" && grounding.every((g) => !/customer_id/.test(g));
    return {
      draft: text,
      grounding: [...(state.grounding || []), ...grounding],
      steps: [...(state.steps || []), ...steps],
      cacheable,
    };
  } finally {
    await mcp.close().catch(() => {});
  }
}

