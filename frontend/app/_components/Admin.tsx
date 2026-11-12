"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Msg, type User } from "../_lib/api";
import { APP_NAME } from "../_lib/config";
import { Markdown } from "./Markdown";
import { Bubble, Button, Card, Checkbox, ErrorText, Field, Input, Modal, Muted, Segmented, Table, Title, TopBar, cx } from "./ui";

const TABS = ["Policies", "Escalations", "Conversations"] as const;
const FLAGS = [
  ["active", "Active"],
  ["refund_allowed", "Refund"],
  ["replacement_allowed", "Replacement"],
  ["exchange_allowed", "Exchange"],
  ["packaging_required", "Packaging required"],
  ["accessories_required", "Accessories required"],
  ["high_risk_requires_manual_review", "High-risk needs manual review"],
] as const;
const STATUS: Record<string, { label: string; dot: string }> = {
  OPEN: { label: "Open", dot: "bg-danger" },
  IN_PROGRESS: { label: "In progress", dot: "bg-warning" },
  RESOLVED: { label: "Resolved", dot: "bg-success" },
};

/** Loads a GET endpoint and exposes reload(). */
function useGet<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api<T>(path).then(setData, (e) => setError(e.message)), [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, reload };
}

/** Shared loading/error states for the admin views. */
function Loaded<T>({ state, children }: { state: { data: T | null; error: string }; children: (data: T) => ReactNode }) {
  if (state.error) return <ErrorText>{state.error}</ErrorText>;
  if (!state.data) return <Muted>Loading…</Muted>;
  return <>{children(state.data)}</>;
}

const SectionHeader = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <Title>{title}</Title>
    <div className="flex gap-2">{children}</div>
  </div>
);

const yes = (v: boolean) => (v ? <span className="text-success">●</span> : <span className="text-line">●</span>);

export function Admin({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Policies");
  const [toast, setToast] = useState("");
  const notify = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 3500);
  };
  return (
    <div className="min-h-dvh bg-canvas">
      <TopBar>
        <span className="flex-1 text-[15px] font-semibold text-ink">{APP_NAME} · Admin</span>
        <span className="hidden text-[13px] text-ink-2 sm:inline">{user.name}</span>
        <Button variant="link" size="inline" onClick={onLogout}>Sign Out</Button>
      </TopBar>
      <section className="mx-auto max-w-5xl space-y-6 px-4 py-8 md:px-6">
        <div className="overflow-x-auto">
          <Segmented label="Admin sections" options={TABS} value={tab} onChange={setTab} />
        </div>
        {tab === "Policies" && <Policies notify={notify} />}
        {tab === "Escalations" && <Escalations notify={notify} />}
        {tab === "Conversations" && <Conversations />}
      </section>
      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-ink/90 px-5 py-2.5 text-sm text-white shadow-lg backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}

function Policies({ notify }: { notify: (t: string) => void }) {
  const state = useGet<any[]>("admin/policies");
  const [edit, setEdit] = useState<any>(null);

  async function save() {
    const conditions = Array.isArray(edit.allowed_conditions) ? edit.allowed_conditions : String(edit.allowed_conditions).split(",");
    const body = { ...edit, allowed_conditions: conditions.map((c: string) => c.trim()).filter(Boolean) };
    try {
      if (edit.policy_rule_id) await api("admin/policies/" + edit.policy_rule_id, { method: "PUT", body });
      else await api("admin/policies", { method: "POST", body });
      notify("Policy saved");
      setEdit(null);
      state.reload();
    } catch (e: any) {
      notify(e.message);
    }
  }

  const blank = { policy_name: "", category: "", return_window_days: 7, allowed_conditions: [], seal_requirement: "", ...Object.fromEntries(FLAGS.map(([k]) => [k, true])) };
  const set = (patch: object) => setEdit({ ...edit, ...patch });
  return (
    <>
      <SectionHeader title="Return Policies">
        <Button variant="primary" size="sm" onClick={() => setEdit(blank)}>New Policy</Button>
      </SectionHeader>
      <Loaded state={state}>
        {(data) => (
          <Table>
            <thead>
              <tr><th>ID</th><th>Name</th><th>Category</th><th>Window</th><th>Refund</th><th>Replace</th><th>Exchange</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.policy_rule_id}>
                  <td className="text-ink-2">{p.policy_rule_id}</td>
                  <td className="font-medium">{p.policy_name}</td>
                  <td>{p.category}</td>
                  <td>{p.return_window_days} days</td>
                  <td>{yes(p.refund_allowed)}</td><td>{yes(p.replacement_allowed)}</td><td>{yes(p.exchange_allowed)}</td><td>{yes(p.active)}</td>
                  <td className="text-right"><Button variant="link" size="inline" onClick={() => setEdit({ ...p })}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Loaded>
      {edit && (
        <Modal onClose={() => setEdit(null)}>
          <Title>{edit.policy_rule_id ? `Edit ${edit.policy_rule_id}` : "New Policy"}</Title>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Policy name"><Input value={edit.policy_name} onChange={(e) => set({ policy_name: e.target.value })} /></Field>
            <Field label="Category"><Input value={edit.category} onChange={(e) => set({ category: e.target.value })} /></Field>
            <Field label="Return window (days)"><Input type="number" min={0} value={edit.return_window_days} onChange={(e) => set({ return_window_days: e.target.value })} /></Field>
            <Field label="Seal requirement"><Input value={edit.seal_requirement ?? ""} onChange={(e) => set({ seal_requirement: e.target.value })} /></Field>
          </div>
          <Field label="Allowed reasons (comma separated)">
            <Input
              value={Array.isArray(edit.allowed_conditions) ? edit.allowed_conditions.join(", ") : edit.allowed_conditions}
              onChange={(e) => set({ allowed_conditions: e.target.value })}
            />
          </Field>
          <div className="grid gap-2.5 rounded-xl bg-canvas p-4 sm:grid-cols-2">
            {FLAGS.map(([k, label]) => (
              <Checkbox key={k} label={label} checked={!!edit[k]} onChange={(e) => set({ [k]: e.target.checked })} />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" onClick={save}>Save</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Escalations({ notify }: { notify: (t: string) => void }) {
  const state = useGet<any[]>("admin/escalations");

  async function setStatus(id: string, status: string) {
    try {
      await api("admin/escalations/" + id, { method: "PUT", body: { status } });
      notify(`Marked ${STATUS[status].label.toLowerCase()}`);
      state.reload();
    } catch (e: any) {
      notify(e.message);
    }
  }

  return (
    <>
      <SectionHeader title="Human Escalations">
        <Button size="sm" onClick={state.reload}>Refresh</Button>
      </SectionHeader>
      <Loaded state={state}>
        {(data) =>
          data.length ? (
            <div className="space-y-3">
              {data.map((e) => (
                <Card key={e.escalation_id} className="space-y-3 p-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
                      <span className={cx("size-2 rounded-full", STATUS[e.status]?.dot ?? "bg-ink-3")} />
                      {STATUS[e.status]?.label ?? e.status}
                    </span>
                    <span className="font-mono text-xs text-ink-3">{e.escalation_id}</span>
                    <span className={cx("text-xs", e.notify_status === "sent" ? "text-success" : "text-danger")}>
                      {e.notify_status === "sent" ? "Support emailed" : `Email ${e.notify_status ?? "not sent"}`}
                    </span>
                    <span className="flex-1" />
                    <span className="text-xs text-ink-3">{new Date(e.notified_at).toLocaleString()}</span>
                  </div>
                  <div>
                    <p className="text-[15px] font-medium text-ink">{e.full_name || e.customer_id}</p>
                    <Muted>{e.email}{e.case_id && ` · Case ${e.case_id}`}</Muted>
                  </div>
                  <p className="text-sm text-ink">{e.reason}</p>
                  {e.summary && <p className="rounded-xl bg-canvas px-4 py-3 text-sm text-ink-2">{e.summary}</p>}
                  {e.status !== "RESOLVED" && (
                    <div className="flex justify-end gap-2">
                      {e.status === "OPEN" && <Button size="sm" onClick={() => setStatus(e.escalation_id, "IN_PROGRESS")}>Start</Button>}
                      <Button variant="primary" size="sm" onClick={() => setStatus(e.escalation_id, "RESOLVED")}>Mark Resolved</Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          ) : (
            <Muted>No escalations yet.</Muted>
          )
        }
      </Loaded>
    </>
  );
}

function Conversations() {
  const state = useGet<any[]>("admin/conversations");
  const [open, setOpen] = useState<{ title: string; messages: Msg[] } | null>(null);

  async function view(c: any) {
    const h = await api<{ messages: Msg[] }>(`admin/conversations/${encodeURIComponent(c.customer_id)}/${encodeURIComponent(c.session_id)}`);
    setOpen({ title: c.full_name || c.customer_id, messages: h.messages });
  }

  return (
    <>
      <SectionHeader title="Recent Conversations" />
      <Loaded state={state}>
        {(data) =>
          data.length ? (
            <Table>
              <thead><tr><th>Updated</th><th>Customer</th><th>First message</th><th /></tr></thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.customer_id + c.session_id}>
                    <td className="whitespace-nowrap text-ink-2">{new Date(c.updated_at).toLocaleString()}</td>
                    <td className="font-medium">{c.full_name || c.customer_id}</td>
                    <td className="max-w-xs truncate">{c.title}</td>
                    <td className="text-right"><Button variant="link" size="inline" onClick={() => view(c)}>View</Button></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Muted>No conversations yet.</Muted>
          )
        }
      </Loaded>
      {open && (
        <Modal onClose={() => setOpen(null)}>
          <div className="flex items-center justify-between gap-3">
            <Title>{open.title}</Title>
            <Button size="sm" onClick={() => setOpen(null)}>Done</Button>
          </div>
          <div className="flex flex-col gap-2.5">
            {open.messages.map((m, i) => (
              <Bubble key={i} role={m.role}><Markdown text={m.content} /></Bubble>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
