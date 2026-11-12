import { AIMessage, HumanMessage, SystemMessage, ToolMessage, trimMessages, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command, END, MessagesValue, START, StateGraph, StateSchema, type BaseCheckpointSaver, type BaseStore, type GraphNode, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { env } from "../config";
import { MEMORY_LIMIT, memoryNamespace } from "../domain";
import { agentPrompt, inputGuardPrompt, inputVerdict, outputGuardPrompt, outputVerdict, type CustomerContext } from "./prompts";
import { tools } from "./tools";

const State = new StateSchema({ messages: MessagesValue });

const FALLBACK_REFUSAL = "Sorry, I can't help with that. I can help with returns, refunds, replacements and exchanges.";
const FALLBACK_ANSWER =
  "Sorry, I couldn't verify that answer against your records. Could you share the order or case number, or would you like me to connect you with our support team?";

/** Recent turns sent to a model. The full thread stays in the checkpoint. */
async function recentHistory(messages: BaseMessage[]) {
  // A run aborted between "agent" and "tools" leaves tool calls without results, which providers reject; skip those.
  const answered = new Set(messages.flatMap((m) => (ToolMessage.isInstance(m) ? [m.tool_call_id] : [])));
  const complete = messages.filter((m) => !AIMessage.isInstance(m) || !m.tool_calls?.some((c) => !answered.has(c.id!)));
  return trimMessages(complete, { maxTokens: env.CHAT_HISTORY_MESSAGES, tokenCounter: (msgs) => msgs.length, strategy: "last", startOn: "human" });
}

/** Plain-text transcript for the output guard, including what each tool returned. */
const transcript = (messages: BaseMessage[]) =>
  messages
    .map((m) =>
      HumanMessage.isInstance(m) ? `Customer: ${m.text}` : ToolMessage.isInstance(m) ? `Tool result (${m.name}): ${m.text}` : m.text.trim() ? `Assistant: ${m.text}` : ""
    )
    .filter(Boolean)
    .join("\n");

/**
 * Who the customer is, for every prompt: the profile the server loaded for this request (semantic "profile" memory)
 * plus the facts saved in the LangGraph Store across conversations (semantic "collection" memory).
 */
async function customerContext(config: LangGraphRunnableConfig): Promise<CustomerContext> {
  const { customer_id, customer_name, customer_profile } = config.configurable ?? {};
  const items = (await config.store?.search(memoryNamespace(customer_id), { limit: MEMORY_LIMIT })) ?? [];
  return { id: customer_id, name: customer_name, profile: customer_profile ?? {}, memories: items.map((i) => ({ id: i.key, text: String(i.value.text) })) };
}

/**
 * START -> input_guard -(blocked)-> END (polite refusal)
 *                      -(allowed)-> agent <-> tools
 *                                   agent (final answer) -> output_guard -> END
 * One tool-calling agent; the two guardrails are structured-output LLM checks around it.
 * Short-term memory: the checkpointer (one thread per conversation). Long-term memory: the store (per customer, across threads).
 * The models are injected so tests can run with scripted ones; `guardModel` may be a cheaper model.
 */
export function buildGraph(model: BaseChatModel, guardModel: BaseChatModel, checkpointer: BaseCheckpointSaver, store: BaseStore) {
  const llm = model.bindTools!(tools);
  const checkInput = guardModel.withStructuredOutput(inputVerdict, { name: "input_guard" });
  const checkOutput = guardModel.withStructuredOutput(outputVerdict, { name: "output_guard" });

  // Runs once per customer message; a confirm/cancel resume continues at "tools" and skips it.
  const input_guard: GraphNode<typeof State> = async (state, config) => {
    config.writer?.({ status: "Checking your message" });
    const latest = state.messages.at(-1);
    const previous = state.messages.slice(0, -1).findLast((m) => AIMessage.isInstance(m) && m.text.trim());
    const verdict = await checkInput.invoke(
      [
        new SystemMessage(inputGuardPrompt(await customerContext(config))),
        new HumanMessage(`Previous assistant message:\n${previous?.text ?? "(none)"}\n\nCustomer message:\n${latest?.text ?? ""}`),
      ],
      config
    );
    if (verdict.allowed) return new Command({ goto: "agent" });
    console.info(`[input_guard] blocked thread=${config.configurable?.thread_id} category=${verdict.category}`);
    return new Command({ update: { messages: [new AIMessage(verdict.reply.trim() || FALLBACK_REFUSAL)] }, goto: END });
  };

  const agent: GraphNode<typeof State> = async (state, config) => {
    const [context, history] = await Promise.all([customerContext(config), recentHistory(state.messages)]);
    return { messages: [await llm.invoke([new SystemMessage(agentPrompt(context)), ...history], config)] };
  };

  // Checks the final answer against the tool results. A failed draft is replaced in place (same message id).
  const output_guard: GraphNode<typeof State> = async (state, config) => {
    const draft = state.messages.at(-1);
    if (!draft || !AIMessage.isInstance(draft) || !draft.text.trim()) return {};
    config.writer?.({ status: "Double-checking the answer" });
    const history = await recentHistory(state.messages.slice(0, -1));
    const verdict = await checkOutput.invoke(
      [new SystemMessage(outputGuardPrompt(await customerContext(config))), new HumanMessage(`Conversation:\n${transcript(history)}\n\nDraft reply:\n${draft.text}`)],
      config
    );
    if (verdict.pass) return {};
    console.info(`[output_guard] revised thread=${config.configurable?.thread_id} issues=${JSON.stringify(verdict.issues)}`);
    return { messages: [new AIMessage({ id: draft.id, content: verdict.revised.trim() || FALLBACK_ANSWER })] };
  };

  return new StateGraph(State)
    .addNode("input_guard", input_guard, { ends: ["agent", END] })
    .addNode("agent", agent)
    .addNode("tools", new ToolNode(tools, { handleToolErrors: true }))
    .addNode("output_guard", output_guard)
    .addEdge(START, "input_guard")
    .addConditionalEdges("agent", toolsCondition, { tools: "tools", [END]: "output_guard" })
    .addEdge("tools", "agent")
    .addEdge("output_guard", END)
    .compile({ checkpointer, store });
}

export type ChatGraph = ReturnType<typeof buildGraph>;
