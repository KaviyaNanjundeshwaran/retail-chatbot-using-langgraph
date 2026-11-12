import { AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import {
  END,
  GraphRecursionError,
  LangGraphRunnableConfig,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { getLlm, textOfMessage } from "../llm/factory";
import { getSetting } from "../db/client";
import { createSkillTools } from "../skills/loader";
import { createMcpClient, dedupeProductCards, ProductCard } from "../mcp/client";
import { createRagTool, resolveProductCardsFromKb, searchKnowledgeBase } from "../rag/knowledge";
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
  cfg?: LangGraphRunnableConfig
) {
  cfg?.writer?.({
    type: "step",
    data: { node: `${agent}_agent`, label: `Running ${agent} specialist` },
  });

  const grounding: string[] = [];
  const steps: string[] = [];
  const products: ProductCard[] = [];
  const skipMcp = state.intent === "smalltalk";
  const [cs, gr, sk, mcp, policyKb] = await Promise.all([
    getSetting("chat"),
    getSetting("guardrails"),
    createSkillTools(agent),
    skipMcp
      ? Promise.resolve(null)
      : createMcpClient(
          state.customerId,
          { message: state.cleaned, sessionId: state.sessionId, turn: state.turn },
          grounding,
          steps,
          products
        ),
    agent === "policy" ? searchKnowledgeBase(state.query, 5) : Promise.resolve(null),
  ]);

  try {
    const tools: any[] = [];
    if (agent !== "general") tools.push(createRagTool(steps, grounding, products));

    if (mcp) {
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
    }

    let pre = "";
    if (policyKb) {
      await resolveProductCardsFromKb(policyKb, products);
      pre = policyKb.map((x: any) => `[${x.source}:${x.source_id}] ${x.content}`).join("\n");
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

    const recent = firstHuman((state.messages || []).slice(-((cs.history_window || 10) + 1)));
    let text = "";
    if (!tools.length) {
      const res = await getLlm().invoke([new SystemMessage(systemPrompt), ...recent]);
      text = textOfMessage(res);
    } else {
      const model = getLlm().bindTools(tools);
      const agentGraph = new StateGraph(MessagesAnnotation)
        .addNode("agent", async (s) => {
          const res = await model.invoke([new SystemMessage(systemPrompt), ...s.messages]);
          return { messages: [res] };
        })
        .addNode("tools", new ToolNode(tools))
        .addEdge(START, "agent")
        .addConditionalEdges("agent", toolsCondition, {
          tools: "tools",
          [END]: END,
        })
        .addEdge("tools", "agent")
        .compile();

      try {
        const result = await agentGraph.invoke(
          { messages: recent },
          { recursionLimit: 2 * (cs.max_tool_steps || 6) + 1 }
        );
        const last = result.messages?.[result.messages.length - 1];
        if (AIMessage.isInstance(last) && !last.tool_calls?.length) {
          text = textOfMessage(last);
        }
      } catch (e: any) {
        if (!(e instanceof GraphRecursionError)) throw e;
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
      products: dedupeProductCards(products),
      cacheable,
    };
  } finally {
    if (mcp) await mcp.close().catch(() => {});
  }
}
