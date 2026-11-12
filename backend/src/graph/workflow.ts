import { z } from "zod";
import { StateGraph, Annotation, START, END, LangGraphRunnableConfig } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { pool, getSetting } from "../db/client";
import { getLlm, textOfMessage } from "../llm/factory";
import { lookupSemanticCache } from "../cache/semantic";
import { validateInputText, runLlmInputGuard, validateOutputText } from "../guardrails/validator";
import { getOrchestratorPrompt, getSpeakerPrompt, SITUATIONS, INTENTS } from "../prompts/system";
import { executeSubAgent } from "../agents/specialists";

const G = globalThis as any;

export const ChatState = Annotation.Root({
  message: Annotation<string>(),
  cleaned: Annotation<string>(),
  customerId: Annotation<string>(),
  sessionId: Annotation<string>(),
  turn: Annotation<string>(),
  messages: Annotation<BaseMessage[]>({
    reducer: (a, b) => (a || []).concat(b || []),
    default: () => [],
  }),
  profile: Annotation<any>(),
  memory: Annotation<string>(),
  blocked: Annotation<string>(),
  cached: Annotation<boolean>(),
  intent: Annotation<string>(),
  query: Annotation<string>(),
  draft: Annotation<string>(),
  final: Annotation<string>(),
  grounding: Annotation<string[]>(),
  steps: Annotation<string[]>(),
  notes: Annotation<string[]>(),
  products: Annotation<any[]>(),
  cacheable: Annotation<boolean>(),
  humanAppended: Annotation<boolean>(),
});

export const emitOf = (cfg?: LangGraphRunnableConfig) => (type: string, data: any) =>
  cfg?.writer?.({ type, data });

export const step = (cfg: LangGraphRunnableConfig | undefined, node: string, label: string) =>
  emitOf(cfg)("step", { node, label });

export const knownText = (s: any) =>
  [s.message, s.memory, ...(s.messages || []).map(textOfMessage), ...(s.grounding || []), s.profile?.customer_id].join(
    "\n"
  );

async function inputGuardNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  step(cfg, "input_guardrails", "Checking your message");
  const res = await validateInputText(s.message, s.customerId);
  return { cleaned: res.cleaned, notes: res.notes, blocked: res.blocked };
}

async function cacheNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  step(cfg, "semantic_cache", "Looking for a cached answer");
  const res = await lookupSemanticCache(s.cleaned, s.profile?.first_name);
  if (res.hit && res.answer) {
    return {
      cached: true,
      draft: res.answer,
      intent: "cached",
      steps: [...(s.steps || []), "semantic_cache_hit"],
      messages: [new HumanMessage(s.cleaned)],
      humanAppended: true,
    };
  }
  return { cached: false };
}

async function llmGuardNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  const human = { messages: [new HumanMessage(s.cleaned)], humanAppended: true };
  const gr = await getSetting("guardrails");
  if (!gr.llm_input) return human;
  step(cfg, "llm_input_guardrail", "Running safety verification");

  try {
    const r = await runLlmInputGuard(s.cleaned, gr.scope);
    if (r.verdict === "block" && r.category !== "ok" && (r.confidence ?? 1) >= 0.8) {
      return {
        blocked: r.category === "off_topic" ? "off_topic" : "blocked_request",
        notes: [
          ...(s.notes || []),
          `llm_input_guard:${r.category}(${Number(r.confidence).toFixed(2)}): ${String(r.reason).slice(0, 140)}`,
        ],
        steps: [...(s.steps || []), "llm_input_blocked"],
      };
    }
    return { ...human, steps: [...(s.steps || []), "llm_input_ok"] };
  } catch (e: any) {
    console.error("llm input guard failed:", e.message);
    return { ...human, notes: [...(s.notes || []), "llm_input_guard_unavailable"] };
  }
}

async function orchestratorNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  step(cfg, "orchestrator", "Routing your request");
  const schema = z.object({
    intent: z.enum(INTENTS),
    standalone_question: z.string().describe("Standalone rephrased request"),
  });
  const model = getLlm().withStructuredOutput(schema);
  const hist = (s.messages || [])
    .slice(-7, -1)
    .map((m) => `${m._getType() === "human" ? "Customer" : "Assistant"}: ${textOfMessage(m)}`)
    .join("\n");
  const gr = await getSetting("guardrails");

  const prompt = getOrchestratorPrompt(gr.scope, s.memory, hist);
  const r: any = await model.invoke([new SystemMessage(prompt), new HumanMessage(s.cleaned)]);
  return {
    intent: r.intent,
    query: r.standalone_question || s.cleaned,
    steps: [...(s.steps || []), "intent:" + r.intent],
  };
}

async function outputGuardNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  step(cfg, "output_guardrails", "Verifying the answer");
  if (s.blocked) return {};
  const g = validateOutputText(s.draft, {
    cid: s.customerId,
    email: s.profile?.email,
    known: knownText(s) + (s.cached ? " " + s.draft : ""),
  });
  const notes = [...(s.notes || []), ...g.notes];
  if (g.empty) return { blocked: "empty_answer", notes };
  if (g.unverified) return { blocked: "unverified_answer", notes };

  let draft = g.text;
  let clean = !g.notes.length;
  const gr = await getSetting("guardrails");

  if (gr.llm_output && !s.cached && clean && (s.intent !== "smalltalk" || (s.grounding || []).length > 0)) {
    step(cfg, "llm_output_guardrail", "Fact-checking answer");
    try {
      const r: any = await getLlm()
        .withStructuredOutput(
          z.object({
            grounded: z.boolean(),
            on_topic: z.boolean(),
            leaks_private_data: z.boolean(),
            issues: z.string(),
            corrected_answer: z.string(),
          })
        )
        .invoke([
          new SystemMessage(
            "You are output compliance reviewer. Check draft against verified sources. Be strict about non-existent order numbers or policies."
          ),
          new HumanMessage(
            `Customer: ${s.customerId}\nVerified Sources:\n${(s.grounding || []).join("\n")}\nDraft:\n${draft}`
          ),
        ]);

      if (r.on_topic === false) return { blocked: "off_topic", notes: [...notes, "llm_output_guard:off_topic"] };
      if (!r.grounded || r.leaks_private_data) {
        clean = false;
        const fixed =
          !r.leaks_private_data && String(r.corrected_answer || "").trim()
            ? validateOutputText(r.corrected_answer, { cid: s.customerId, email: s.profile?.email, known: knownText(s) })
            : null;
        if (fixed && !fixed.notes.length) {
          draft = fixed.text;
          notes.push("llm_output_guard:corrected");
        } else {
          return { blocked: "unverified_answer", notes: [...notes, "llm_output_guard:unverified"] };
        }
      }
    } catch (e: any) {
      console.error("llm output guard failed:", e.message);
      notes.push("llm_output_guard_unavailable");
    }
  }

  return { draft, notes, cacheable: s.cacheable && clean };
}

async function speak(code: string, s: typeof ChatState.State, emit?: (t: string, d: any) => void): Promise<string> {
  const [gr, msgs, chatCfg] = await Promise.all([
    getSetting("guardrails"),
    getSetting("messages"),
    getSetting("chat"),
  ]);
  const bot = chatCfg.bot_name;

  const situation = SITUATIONS[code];
  if (!situation) {
    const t = String(msgs[code] || msgs.error).split("{max}").join(String(gr.max_input_chars));
    emit?.("token", t);
    return t;
  }

  let full = "";
  try {
    const stream = await getLlm().stream([
      new SystemMessage(getSpeakerPrompt(situation, gr.scope, bot, s.profile?.first_name || "")),
      new HumanMessage(`Customer message: ${String(s.cleaned || s.message || "").slice(0, 400)}`),
    ]);
    for await (const ch of stream) {
      const t = textOfMessage(ch);
      if (t) {
        full += t;
        emit?.("token", t);
      }
    }
  } catch (e: any) {
    console.error("speak failed:", e.message);
  }
  if (!full.trim()) {
    full = String(msgs["fallback_" + code] || msgs.error);
    emit?.("token", full);
  }
  return full;
}

async function respondNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  const emit = emitOf(cfg);
  step(cfg, "orchestrator_response", "Writing your answer");
  let full = "";

  if (s.blocked) {
    full = await speak(s.blocked, s, emit);
  } else {
    full = s.draft || "";
    emit("token", full);
    if (!s.cached && s.products?.length) {
      emit("products", s.products);
    }
  }

  return !s.blocked || s.humanAppended ? { final: full, messages: [new AIMessage(full)] } : { final: full };
}

const routeIntent = (s: typeof ChatState.State) =>
  ({
    policy_question: "policy",
    order_lookup: "orders",
    case_status: "orders",
    return_or_refund: "returns",
    replacement_or_exchange: "returns",
    out_of_scope: "scope_refusal",
  } as any)[s.intent] || "general";

async function scopeRefusalNode(s: typeof ChatState.State, cfg: LangGraphRunnableConfig) {
  step(cfg, "scope_guardrail", "Checking scope");
  return { blocked: "off_topic", notes: [...(s.notes || []), "off_topic_refused"] };
}

export async function getCompiledGraph() {
  if (G.__graphP) return G.__graphP;
  G.__graphP = (async () => {
    const saver = new PostgresSaver(pool as any);
    await saver.setup();
    const store = new PostgresStore({
      connectionOptions: { connectionString: process.env.PG_URI, ssl: { rejectUnauthorized: false }, max: 3 },
    });
    await store.setup();
    G.__store = store;

    return new StateGraph(ChatState)
      .addNode("input_guard", inputGuardNode)
      .addNode("cache", cacheNode)
      .addNode("llm_guard", llmGuardNode)
      .addNode("orchestrator", orchestratorNode)
      .addNode("policy", (s, c) => executeSubAgent("policy", s, c))
      .addNode("orders", (s, c) => executeSubAgent("orders", s, c))
      .addNode("returns", (s, c) => executeSubAgent("returns", s, c))
      .addNode("general", (s, c) => executeSubAgent("general", s, c))
      .addNode("output_guard", outputGuardNode)
      .addNode("respond", respondNode)
      .addNode("scope_refusal", scopeRefusalNode)
      .addEdge(START, "input_guard")
      .addConditionalEdges("input_guard", (s) => (s.blocked ? "respond" : "cache"), {
        respond: "respond",
        cache: "cache",
      })
      .addConditionalEdges("cache", (s) => (s.cached ? "output_guard" : "llm_guard"), {
        output_guard: "output_guard",
        llm_guard: "llm_guard",
      })
      .addConditionalEdges("llm_guard", (s) => (s.blocked ? "respond" : "orchestrator"), {
        respond: "respond",
        orchestrator: "orchestrator",
      })
      .addConditionalEdges("orchestrator", routeIntent, {
        policy: "policy",
        orders: "orders",
        returns: "returns",
        general: "general",
        scope_refusal: "scope_refusal",
      })
      .addEdge("policy", "output_guard")
      .addEdge("orders", "output_guard")
      .addEdge("returns", "output_guard")
      .addEdge("general", "output_guard")
      .addEdge("scope_refusal", "respond")
      .addEdge("output_guard", "respond")
      .addEdge("respond", END)
      .compile({ checkpointer: saver, store });
  })().catch((e) => {
    G.__graphP = undefined;
    throw e;
  });
  return G.__graphP;
}

export async function loadLongTermMemory(cid: string) {
  const store = G.__store;
  if (!store) return "";
  const items = await store.search(["memory", cid], { limit: 20 });
  return items.map((i: any) => `${i.key}: ${i.value?.text}`).join("; ");
}

export async function updateLongTermMemory(cid: string, user: string, bot: string) {
  try {
    const store = G.__store;
    if (!store) return;
    const cur = await loadLongTermMemory(cid);
    const model = getLlm().withStructuredOutput(
      z.object({ facts: z.array(z.object({ key: z.string(), value: z.string() })).max(3) })
    );
    const r: any = await model.invoke([
      new SystemMessage(
        `Extract up to 3 durable, non-sensitive facts worth remembering about this customer (preferences, ongoing issue, resolution preference). Existing: ${
          cur || "none"
        }`
      ),
      new HumanMessage(`Customer: ${user}\nAssistant: ${bot}`),
    ]);
    for (const f of r.facts || [])
      await store.put(["memory", cid], f.key.slice(0, 60).replace(/\W+/g, "_"), { text: f.value.slice(0, 300) });
  } catch {}
}
