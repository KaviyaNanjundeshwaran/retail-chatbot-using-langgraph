"use client";
/* Single-page UI: Login (customer/admin) -> Chat (customer) | Dashboard (admin) */
import { useCallback, useEffect, useRef, useState } from "react";
import { FetchStreamTransport } from "@langchain/langgraph-sdk/react";

const api = async (path: string, opts: any = {}) => {
  const r = await fetch("/api/" + path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
};
const md = (t: string) => t.split("\n").map((l, i) => {
  const parts = l.split(/(\*\*[^*]+\*\*)/g).map((p, j) => (p.startsWith("**") && p.endsWith("**") ? <b key={j}>{p.slice(2, -2)}</b> : p));
  return /^\s*[-*•]\s+/.test(l) ? <div key={i} className="li">• {parts.map((p) => (typeof p === "string" ? p.replace(/^\s*[-*•]\s+/, "") : p))}</div> : <div key={i}>{parts.length ? parts : " "}</div>;
});

export default function Page() {
  const [user, setUser] = useState<any>(undefined);
  const load = useCallback(() => api("auth/me").then((d) => setUser(d.user)).catch(() => setUser(null)), []);
  useEffect(() => { load(); }, [load]);
  const logout = async () => { await api("auth/logout", { method: "POST" }); setUser(null); };
  return (<>
    {user === undefined ? <div className="center muted">Loading…</div>
      : !user ? <Login onDone={load} />
      : user.role === "admin" ? <Admin user={user} logout={logout} />
      : <Chat user={user} logout={logout} />}
  </>);
}

/* ------------------------------- login ------------------------------- */
function Login({ onDone }: { onDone: () => void }) {
  const [role, setRole] = useState<"customer" | "admin">("customer");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: any) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("auth/login", { method: "POST", body: { role, email, password } }); onDone(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (<div className="center"><form className="card login" onSubmit={submit}>
    <h1>Returns &amp; Refunds</h1><p className="muted">Sign in to continue</p>
    <div className="tabs">{(["customer", "admin"] as const).map((r) => <button type="button" key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>{r === "customer" ? "Customer" : "Admin"}</button>)}</div>
    <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required /></label>
    <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required /></label>
    {err && <div className="err">{err}</div>}
    <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
  </form></div>);
}

/* -------------------------------- chat -------------------------------- */
type Msg = { role: "user" | "assistant"; content: string; steps?: string[] };
function Chat({ user, logout }: { user: any; logout: () => void }) {
  const [sessions, setSessions] = useState<any[]>([]), [sid, setSid] = useState(() => crypto.randomUUID());
  const [msgs, setMsgs] = useState<Msg[]>([]), [input, setInput] = useState(""), [busy, setBusy] = useState(false), [chips, setChips] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const refresh = useCallback(() => api("chat/sessions").then(setSessions).catch(() => {}), []);
  useEffect(() => { refresh(); api("chat/suggestions").then(setChips).catch(() => {}); }, [refresh]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  const open = async (id: string) => { setSid(id); const h = await api("chat/history?sessionId=" + id); setMsgs(h.map((m: any) => ({ role: m.role, content: m.content }))); };
  const newChat = () => { setSid(crypto.randomUUID()); setMsgs([]); };

  const send = async (text: string) => {
    text = text.trim(); if (!text || busy) return;
    setInput(""); setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "", steps: [] }]);
    const patch = (fn: (m: Msg) => Msg) => setMsgs((all) => { const c = [...all]; c[c.length - 1] = fn(c[c.length - 1]); return c; });
    try {
      const transport = new FetchStreamTransport({
        apiUrl: "/api/chat",
        fetch: (url, init) => fetch(url, { ...init, credentials: "same-origin" }),
      });
      const stream = await transport.stream({
        input: { message: text, sessionId: sid } as any,
        context: undefined,
        command: undefined,
        signal: new AbortController().signal,
      });
      for await (const ev of stream) {
        const d: any = ev.data;
        if (ev.event === "step") patch((m) => ({ ...m, steps: [...(m.steps || []), d.label] }));
        else if (ev.event === "token") patch((m) => ({ ...m, content: m.content + String(d ?? "") }));
        else if (ev.event === "replace") patch((m) => ({ ...m, content: String(d ?? "") }));
        else if (ev.event === "error") patch((m) => ({ ...m, content: "⚠️ " + (d?.message || "Error") }));
        else if (ev.event === "done") refresh();
      }
    } catch (e: any) { patch((m) => ({ ...m, content: "⚠️ " + e.message })); } finally { setBusy(false); }
  };

  return (<div className="app">
    <aside>
      <button className="primary" onClick={newChat}>+ New chat</button>
      <div className="list">{sessions.map((s) => <button key={s.session_id} className={"item" + (s.session_id === sid ? " on" : "")} onClick={() => open(s.session_id)}>
        <span>{(s.title || "Chat").slice(0, 38)}</span><small>{new Date(s.updated).toLocaleString()}</small></button>)}</div>
      <div className="me"><b>{user.name}</b><small>{user.id} · {user.profile?.loyalty?.tier || user.profile?.customer_type}</small><button onClick={logout}>Sign out</button></div>
    </aside>
    <main>
      <header>Returns &amp; Refunds Assistant</header>
      <div className="msgs">
        {!msgs.length && <div className="hello"><h2>Hi {user.profile?.first_name || user.name} 👋</h2><p className="muted">I can help with returns, refunds and replacements: eligibility, requests, case status and policies.</p>
          <div className="chips">{chips.map((c) => <button key={c} onClick={() => send(c)}>{c}</button>)}</div></div>}
        {msgs.map((m, i) => <div key={i} className={"msg " + m.role}>
          {m.role === "assistant" && !m.content && busy && i === msgs.length - 1 && <div className="steps">{(m.steps || []).slice(-1).map((s) => <span key={s}>⏳ {s}…</span>)}</div>}
          <div className="bubble">{m.content ? md(m.content) : null}</div></div>)}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type your message…" disabled={busy} maxLength={1500} />
        <button className="primary" disabled={busy || !input.trim()}>{busy ? "…" : "Send"}</button>
      </form>
    </main>
  </div>);
}

/* ------------------------------- admin ------------------------------- */
const TABS = ["Overview", "Policies", "Skills", "Settings", "Conversations", "Escalations", "Audit"] as const;
function Admin({ user, logout }: { user: any; logout: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview"); const [toast, setToast] = useState("");
  const note = (t: string) => { setToast(t); setTimeout(() => setToast(""), 3500); };
  return (<div className="admin">
    <header><b>Admin Dashboard</b><nav>{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
      <span className="grow" /><span className="muted">{user.name}</span><button onClick={logout}>Sign out</button></header>
    <section>
      {tab === "Overview" && <Overview note={note} />}{tab === "Policies" && <Policies note={note} />}{tab === "Skills" && <Skills note={note} />}
      {tab === "Settings" && <Settings note={note} />}
      {tab === "Conversations" && <Table path="admin/conversations" cols={["created_at", "customer_id", "full_name", "role", "intent", "content"]} />}
      {tab === "Escalations" && <Escalations note={note} />}
      {tab === "Audit" && <Table path="admin/audit" cols={["at", "actor", "role", "action", "detail"]} />}
    </section>
    {toast && <div className="toast">{toast}</div>}
  </div>);
}
function useGet(path: string) {
  const [d, setD] = useState<any>(null), [err, setErr] = useState("");
  const reload = useCallback(() => api(path).then(setD).catch((e) => setErr(e.message)), [path]);
  useEffect(() => { reload(); }, [reload]); return { d, err, reload };
}
function Overview({ note }: any) {
  const { d, err, reload } = useGet("admin/stats"); if (err) return <div className="err">{err}</div>; if (!d) return <p className="muted">Loading…</p>;
  const cards = [["Customers", d.customers], ["Orders", d.orders], ["Return cases", d.cases], ["Refund requests", d.refunds], ["Replacements", d.replacements], ["Active policies", d.policies], ["Messages (24h)", d.messages24h], ["Cache entries", d.cacheEntries], ["Cache hits", d.cacheHits], ["RAG documents", d.kbDocs]];
  const act = async (p: string, m: string) => { try { const r = await api(p, { method: "POST" }); note(m + (r.policies ? ` (${r.policies} policies, ${r.products} products)` : "")); reload(); } catch (e: any) { note(e.message); } };
  return (<>
    <div className="cards">{cards.map(([k, v]) => <div className="card stat" key={k as string}><small>{k}</small><b>{v as any}</b></div>)}</div>
    <div className="row"><button onClick={() => act("admin/reindex", "RAG index rebuilt")}>Rebuild RAG index</button><button onClick={() => act("admin/clear-cache", "Semantic cache cleared")}>Clear semantic cache</button></div>
    <div className="two"><div className="card"><h3>Chat intents</h3>{d.intents.map((x: any) => <Bar key={x.intent} l={x.intent} n={x.n} max={d.intents[0]?.n} />)}</div>
      <div className="card"><h3>Cases by status</h3>{d.casesByStatus.map((x: any) => <Bar key={x.status} l={x.status} n={x.n} max={d.casesByStatus[0]?.n} />)}</div></div>
  </>);
}
const Bar = ({ l, n, max }: any) => <div className="bar"><span>{l}</span><div><i style={{ width: (n / max) * 100 + "%" }} /></div><b>{n}</b></div>;

function Policies({ note }: any) {
  const { d, err, reload } = useGet("admin/policies"); const [edit, setEdit] = useState<any>(null);
  if (err) return <div className="err">{err}</div>; if (!d) return <p className="muted">Loading…</p>;
  const save = async () => {
    try {
      const body = { ...edit, allowed_conditions: Array.isArray(edit.allowed_conditions) ? edit.allowed_conditions : String(edit.allowed_conditions || "").split(",") };
      const r = edit.policy_rule_id ? await api("admin/policies/" + edit.policy_rule_id, { method: "PUT", body }) : await api("admin/policies", { method: "POST", body });
      note(r.index === "ok" ? "Policy saved to database and RAG index refreshed" : r.index); setEdit(null); reload();
    } catch (e: any) { note(e.message); }
  };
  const B = ({ k, label }: any) => <label className="chk"><input type="checkbox" checked={!!edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.checked })} />{label}</label>;
  return (<>
    <div className="row"><h3 className="grow">Return policies (live database table <code>policy_rules</code>)</h3><button className="primary" onClick={() => setEdit({ policy_name: "", category: "", return_window_days: 7, allowed_conditions: [], active: true, refund_allowed: true, replacement_allowed: true, exchange_allowed: true, packaging_required: true, accessories_required: true, high_risk_requires_manual_review: true, seal_requirement: "ORIGINAL_PACKAGING" })}>+ New policy</button></div>
    <div className="scroll"><table><thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Window</th><th>Refund</th><th>Replace</th><th>Exchange</th><th>Active</th><th /></tr></thead><tbody>
      {d.map((p: any) => <tr key={p.policy_rule_id}><td>{p.policy_rule_id}</td><td>{p.policy_name}</td><td>{p.category}</td><td>{p.return_window_days}d</td><td>{p.refund_allowed ? "✓" : "–"}</td><td>{p.replacement_allowed ? "✓" : "–"}</td><td>{p.exchange_allowed ? "✓" : "–"}</td><td>{p.active ? "✓" : "–"}</td><td><button onClick={() => setEdit({ ...p })}>Edit</button></td></tr>)}</tbody></table></div>
    {edit && <div className="modal" onClick={() => setEdit(null)}><div className="card form" onClick={(e) => e.stopPropagation()}>
      <h3>{edit.policy_rule_id ? "Edit " + edit.policy_rule_id : "New policy"}</h3>
      <label>Policy name<input value={edit.policy_name || ""} onChange={(e) => setEdit({ ...edit, policy_name: e.target.value })} /></label>
      <label>Category<input value={edit.category || ""} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></label>
      <label>Return window (days)<input type="number" min={0} value={edit.return_window_days ?? 0} onChange={(e) => setEdit({ ...edit, return_window_days: +e.target.value })} /></label>
      <label>Allowed reasons (comma separated)<input value={Array.isArray(edit.allowed_conditions) ? edit.allowed_conditions.join(", ") : edit.allowed_conditions || ""} onChange={(e) => setEdit({ ...edit, allowed_conditions: e.target.value })} /></label>
      <label>Seal requirement<input value={edit.seal_requirement || ""} onChange={(e) => setEdit({ ...edit, seal_requirement: e.target.value })} /></label>
      <div className="checks"><B k="active" label="Active" /><B k="refund_allowed" label="Refund" /><B k="replacement_allowed" label="Replacement" /><B k="exchange_allowed" label="Exchange" /><B k="packaging_required" label="Packaging required" /><B k="accessories_required" label="Accessories required" /><B k="high_risk_requires_manual_review" label="High-risk → manual review" /></div>
      <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
    </div></div>}
  </>);
}
function Skills({ note }: any) {
  const { d, err, reload } = useGet("admin/skills"); const [edit, setEdit] = useState<any>(null);
  if (err) return <div className="err">{err}</div>; if (!d) return <p className="muted">Loading…</p>;
  const save = async () => { try { await api("admin/skills", { method: "PUT", body: edit }); note("Skill saved"); setEdit(null); reload(); } catch (e: any) { note(e.message); } };
  return (<>
    <div className="row"><h3 className="grow">Agent skills (loaded on demand by the sub-agents)</h3><button className="primary" onClick={() => setEdit({ name: "", agent: "all", description: "", instructions: "", enabled: true })}>+ New skill</button></div>
    <div className="cards">{d.map((s: any) => <div className="card" key={s.name}><b>{s.name}</b> <small className="muted">· {s.agent} · {s.enabled ? "enabled" : "disabled"}</small><p>{s.description}</p><button onClick={() => setEdit({ ...s })}>Edit</button></div>)}</div>
    {edit && <div className="modal" onClick={() => setEdit(null)}><div className="card form" onClick={(e) => e.stopPropagation()}>
      <label>Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
      <label>Agent<select value={edit.agent} onChange={(e) => setEdit({ ...edit, agent: e.target.value })}>{["all", "policy", "orders", "returns", "general"].map((a) => <option key={a}>{a}</option>)}</select></label>
      <label>Description<input value={edit.description || ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
      <label>Instructions<textarea rows={8} value={edit.instructions || ""} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} /></label>
      <label className="chk"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />Enabled</label>
      <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div></div></div>}
  </>);
}
function Settings({ note }: any) {
  const { d, err, reload } = useGet("admin/settings"); const [txt, setTxt] = useState<Record<string, string>>({});
  if (err) return <div className="err">{err}</div>; if (!d) return <p className="muted">Loading…</p>;
  const save = async (key: string) => { try { await api("admin/settings", { method: "PUT", body: { key, value: JSON.parse(txt[key] ?? JSON.stringify(d[key])) } }); note(key + " saved"); reload(); } catch (e: any) { note(e.message); } };
  return (<div className="cards">{Object.keys(d).map((k) => <div className="card" key={k}><h3>{k}</h3>
    <textarea rows={12} value={txt[k] ?? JSON.stringify(d[k], null, 2)} onChange={(e) => setTxt({ ...txt, [k]: e.target.value })} /><button className="primary" onClick={() => save(k)}>Save {k}</button></div>)}</div>);
}

/* ---- Escalations admin tab ---- */
function Escalations({ note }: any) {
  const { d, err, reload } = useGet("admin/escalations");
  if (err) return <div className="err">{err}</div>;
  if (!d) return <p className="muted">Loading…</p>;
  const resolve = async (escalationId: string) => {
    try { await api("admin/escalations/" + escalationId, { method: "PUT", body: { status: "RESOLVED" } }); note("Marked as resolved"); reload(); }
    catch (e: any) { note(e.message); }
  };
  const STATUS_COLOR: Record<string, string> = { OPEN: "#b91c1c", RESOLVED: "#15803d", IN_PROGRESS: "#b45309" };
  return (<>
    <div className="row"><h3 className="grow">Human escalations (SNS email notifications)</h3><button onClick={reload}>↺ Refresh</button></div>
    {d.length === 0 && <p className="muted">No escalations yet.</p>}
    <div className="esc-list">
      {d.map((e: any) => (
        <div className="card esc-card" key={e.escalation_id}>
          <div className="esc-header">
            <span className="esc-id">{e.escalation_id}</span>
            <span className="esc-status" style={{ color: STATUS_COLOR[e.status] || "#6b7280" }}>{e.status}</span>
            <span className="grow" />
            <small className="muted">{new Date(e.notified_at).toLocaleString()}</small>
          </div>
          <div className="esc-meta">
            <b>{e.full_name || e.customer_id}</b> &lt;{e.email}&gt; · Session: <code>{(e.session_id || "").slice(0, 8)}…</code>
            {e.case_id && <> · Case: <code>{e.case_id}</code></>}
          </div>
          <p className="esc-reason"><b>Reason:</b> {e.reason}</p>
          <details><summary className="muted">Conversation summary</summary><pre className="esc-summary">{e.summary}</pre></details>
          {e.status === "OPEN" && <div className="row"><button className="primary" onClick={() => resolve(e.escalation_id)}>✓ Mark resolved</button></div>}
          {e.status === "RESOLVED" && <small className="muted">Resolved {e.resolved_at ? new Date(e.resolved_at).toLocaleString() : ""}{e.resolved_by ? " by " + e.resolved_by : ""}</small>}
        </div>
      ))}
    </div>
  </>);
}

function Table({ path, cols }: { path: string; cols: string[] }) {
  const { d, err } = useGet(path); if (err) return <div className="err">{err}</div>; if (!d) return <p className="muted">Loading…</p>;
  return (<div className="scroll"><table><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>
    {d.map((r: any, i: number) => <tr key={i}>{cols.map((c) => <td key={c}>{typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "").slice(0, 220)}</td>)}</tr>)}</tbody></table></div>);
}
