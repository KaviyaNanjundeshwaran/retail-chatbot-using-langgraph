"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type Confirmation, type Msg, type User } from "../_lib/api";
import { APP_NAME } from "../_lib/config";
import { Markdown } from "./Markdown";
import { SessionList, type Session } from "./SessionList";
import { Bubble, Button, Card, Input, Muted, TopBar, cx } from "./ui";

const TOOL_LABELS: Record<string, string> = {
  list_my_orders: "Looking up your orders",
  check_return_eligibility: "Checking return eligibility",
  get_return_policy: "Reading the return policy",
  get_my_cases: "Checking your cases",
  create_return_request: "Preparing your request",
  escalate_to_human: "Contacting our support team",
  save_memory: "Saving that for next time",
  delete_memory: "Forgetting that",
};

const EXAMPLES = ["Can I return my last order?", "What is your return policy?", "What's the status of my cases?"];

type SendBody = { message: string } | { edit: string } | { resume: { approved: boolean } };

export function Chat({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const run = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);

  const loadSessions = useCallback(() => api<Session[]>("chat/sessions").then(setSessions).catch(() => {}), []);
  useEffect(() => {
    loadSessions();
    return () => run.current?.abort();
  }, [loadSessions]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, status, pending]);

  /** Cancels any in-flight answer so its events can never land in another conversation. */
  function stop() {
    run.current?.abort();
    run.current = null;
    setBusy(false);
    setStatus("");
  }

  async function openSession(id: string) {
    stop();
    setMenuOpen(false);
    setEditing(false);
    setInput("");
    setSessionId(id);
    setMsgs([]);
    setPending(null);
    try {
      const h = await api<{ messages: Msg[]; pending: Confirmation | null }>("chat/sessions/" + id);
      setMsgs(h.messages);
      setPending(h.pending);
    } catch (e: any) {
      setMsgs([{ role: "assistant", content: e.message, error: true }]);
    }
  }

  function newChat() {
    stop();
    setMenuOpen(false);
    setEditing(false);
    setInput("");
    setSessionId(crypto.randomUUID());
    setMsgs([]);
    setPending(null);
  }

  /** Stop button: abort the answer (the server stops the run) and show what the server actually saved. */
  function stopAnswer() {
    stop();
    void openSession(sessionId);
  }

  async function send(body: SendBody) {
    stop();
    const ctrl = new AbortController();
    run.current = ctrl;
    setBusy(true);
    setPending(null);
    setMsgs((m) => {
      if ("resume" in body) return [...m, { role: "assistant", content: "" }];
      // An edit replaces the last customer message and everything after it.
      const keep = "edit" in body ? m.slice(0, m.findLastIndex((x) => x.role === "user")) : m;
      return [...keep, { role: "user", content: "edit" in body ? body.edit : body.message }, { role: "assistant", content: "" }];
    });
    const patchLast = (fn: (m: Msg) => Msg) =>
      setMsgs((all) => (all.at(-1)?.role === "assistant" ? [...all.slice(0, -1), fn(all.at(-1)!)] : all));

    try {
      await streamChat({ sessionId, ...body }, ctrl.signal, (e) => {
        if (ctrl.signal.aborted) return;
        if (e.event === "token") {
          setStatus("");
          patchLast((m) => ({ ...m, content: m.content + e.data }));
        } else if (e.event === "replace") patchLast((m) => ({ ...m, content: e.data })); // output guardrail correction
        else if (e.event === "status") setStatus(e.data);
        else if (e.event === "tools") setStatus(TOOL_LABELS[e.data[0]] ?? "Working on it");
        else if (e.event === "interrupt") setPending(e.data);
        else if (e.event === "error") patchLast((m) => ({ ...m, content: e.data.message, error: true }));
      });
    } catch (err: any) {
      if (!ctrl.signal.aborted) patchLast((m) => ({ ...m, content: err.message, error: true }));
    } finally {
      if (run.current === ctrl) {
        run.current = null;
        setBusy(false);
        setStatus("");
        setMsgs((all) => all.filter((m) => m.content)); // drop the placeholder if nothing was written
        loadSessions();
      }
    }
  }

  function submit(text: string) {
    text = text.trim();
    if (!text || busy || pending) return;
    setInput("");
    setEditing(false);
    send(editing ? { edit: text } : { message: text });
  }

  function startEdit(text: string) {
    setEditing(true);
    setInput(text);
    composer.current?.focus();
  }

  const lastUser = msgs.findLastIndex((m) => m.role === "user");

  return (
    <div className="flex h-dvh bg-white">
      {menuOpen && <div className="fixed inset-0 z-20 bg-black/20 backdrop-blur-sm md:hidden" onClick={() => setMenuOpen(false)} />}
      <aside
        className={cx(
          "w-72 shrink-0 flex-col border-r border-line/60 bg-canvas",
          menuOpen ? "fixed inset-y-0 left-0 z-30 flex shadow-2xl md:static md:shadow-none" : "hidden md:flex"
        )}
      >
        <div className="flex h-14 items-center justify-between px-4">
          <span className="text-[15px] font-semibold text-ink">Chats</span>
          <Button variant="primary" size="sm" onClick={newChat}>New Chat</Button>
        </div>
        <SessionList
          sessions={sessions}
          activeId={sessionId}
          onOpen={openSession}
          onChanged={loadSessions}
          onDeleted={(id) => {
            if (id === sessionId) newChat();
            loadSessions();
          }}
        />
        <div className="flex items-center gap-3 border-t border-line/60 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fill text-sm font-semibold text-ink-2">
            {user.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{user.name}</span>
            <span className="block text-xs text-ink-3">{user.id}</span>
          </span>
          <Button variant="link" size="inline" onClick={onLogout}>Sign Out</Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar>
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Show conversations" onClick={() => setMenuOpen(true)}>☰</Button>
          <span className="text-[15px] font-semibold text-ink">{APP_NAME}</span>
        </TopBar>

        <div className="flex-1 overflow-y-auto" aria-live="polite">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-2.5 px-4 py-6 md:px-6">
            {!msgs.length && !busy && (
              <div className="m-auto max-w-lg space-y-4 py-12 text-center">
                <h2 className="text-3xl font-semibold tracking-tight text-ink">Hi, {user.name.split(" ")[0]}.</h2>
                <p className="text-[15px] text-ink-2">I can help with returns, refunds and replacements: eligibility, requests, case status and policies.</p>
                <div className="flex flex-wrap justify-center gap-2 pt-2">
                  {EXAMPLES.map((c) => (
                    <Button key={c} onClick={() => submit(c)}>{c}</Button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) =>
              m.content ? (
                <div key={i} className={cx("flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
                  <Bubble role={m.role} error={m.error}>
                    <Markdown text={m.content} />
                  </Bubble>
                  {i === lastUser && !busy && !pending && !editing && (
                    <Button variant="link" size="inline" className="px-1" onClick={() => startEdit(m.content)}>Edit</Button>
                  )}
                </div>
              ) : null
            )}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-[13px] text-ink-3">
                <span className="size-2 animate-pulse rounded-full bg-ink-3" />
                {status || "Thinking"}…
              </div>
            )}
            {pending && (
              <Card className="mt-1 w-full max-w-md space-y-4 self-start p-5">
                <div className="flex items-center gap-3">
                  {pending.image_url && (
                    <img
                      src={pending.image_url}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="size-14 shrink-0 rounded-xl bg-canvas object-cover"
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                  )}
                  <div>
                    <h3 className="text-[17px] font-semibold tracking-tight text-ink">Confirm your request</h3>
                    <Muted>{pending.product_name}</Muted>
                  </div>
                </div>
                <dl className="divide-y divide-line/50 rounded-xl bg-canvas px-4 text-sm [&>div]:flex [&>div]:justify-between [&>div]:gap-4 [&>div]:py-2.5 [&_dt]:text-ink-2 [&_dd]:font-medium [&_dd]:text-ink">
                  <div><dt>Order</dt><dd>{pending.order_id}</dd></div>
                  <div><dt>Request</dt><dd className="capitalize">{pending.resolution.toLowerCase()}</dd></div>
                  <div><dt>Reason</dt><dd className="capitalize">{pending.reason.replace(/_/g, " ").toLowerCase()}</dd></div>
                </dl>
                {pending.requires_manual_review && <Muted>A support specialist will review this request.</Muted>}
                <div className="flex gap-2">
                  <Button variant="primary" className="flex-1" disabled={busy} onClick={() => send({ resume: { approved: true } })}>Confirm</Button>
                  <Button className="flex-1" disabled={busy} onClick={() => send({ resume: { approved: false } })}>Cancel</Button>
                </div>
              </Card>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <form
          className="border-t border-line/60 bg-white/80 backdrop-blur-xl"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-2 px-4 py-3 md:px-6">
            {editing && (
              <div className="flex items-center justify-between px-1 text-[13px] text-ink-2">
                <span>Editing your last message</span>
                <Button type="button" variant="link" size="inline" onClick={() => { setEditing(false); setInput(""); }}>Cancel</Button>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                ref={composer}
                variant="pill"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={pending ? "Confirm or cancel the request above" : "Message"}
                aria-label="Message"
                disabled={busy || !!pending}
              />
              {busy ? (
                <Button type="button" size="lg" onClick={stopAnswer}>Stop</Button>
              ) : (
                <Button variant="primary" size="lg" disabled={!!pending || !input.trim()}>{editing ? "Save" : "Send"}</Button>
              )}
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
