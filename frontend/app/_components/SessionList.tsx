"use client";
import { useState, type KeyboardEvent } from "react";
import { api } from "../_lib/api";
import { Button, Input, Modal, Muted, Title, cx } from "./ui";

export type Session = { session_id: string; title: string; updated_at: string };

const icon = "size-4 fill-none stroke-current stroke-[1.75] [stroke-linecap:round] [stroke-linejoin:round]";
const PencilIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={icon}>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={icon}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
);

/** Sidebar conversation list with inline rename and confirmed delete. */
export function SessionList({
  sessions,
  activeId,
  onOpen,
  onChanged,
  onDeleted,
}: {
  sessions: Session[];
  activeId: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [error, setError] = useState("");

  async function saveTitle() {
    if (!renaming) return;
    const title = renaming.title.trim();
    setRenaming(null);
    if (!title || title === sessions.find((s) => s.session_id === renaming.id)?.title) return;
    try {
      await api("chat/sessions/" + renaming.id, { method: "PATCH", body: { title } });
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api("chat/sessions/" + deleting.session_id, { method: "DELETE" });
      onDeleted(deleting.session_id);
      setDeleting(null);
    } catch (e: any) {
      setError(e.message);
      setDeleting(null);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") saveTitle();
    if (e.key === "Escape") setRenaming(null);
  };

  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2" aria-label="Conversations">
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-danger" onClick={() => setError("")}>
          {error}
        </p>
      )}
      {!sessions.length && <p className="px-3 py-2 text-sm text-ink-3">No conversations yet.</p>}
      {sessions.map((s) =>
        renaming?.id === s.session_id ? (
          <div key={s.session_id} className="px-1 py-1">
            <Input
              autoFocus
              aria-label="Conversation title"
              maxLength={80}
              value={renaming.title}
              onChange={(e) => setRenaming({ id: s.session_id, title: e.target.value })}
              onKeyDown={onKey}
              onBlur={saveTitle}
            />
          </div>
        ) : (
          <div
            key={s.session_id}
            className={cx(
              "group flex items-center gap-1 rounded-xl pr-1.5 transition-colors",
              s.session_id === activeId ? "bg-white shadow-sm ring-1 ring-black/5" : "hover:bg-black/5"
            )}
          >
            <button
              onClick={() => onOpen(s.session_id)}
              className="min-w-0 flex-1 cursor-pointer rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-4 focus-visible:ring-accent/25"
            >
              <span className="block truncate text-sm font-medium text-ink">{s.title}</span>
              <span className="block text-xs text-ink-3">{new Date(s.updated_at).toLocaleString()}</span>
            </button>
            {/* Always visible on touch screens; on hover or keyboard focus on desktop. */}
            <span className="flex shrink-0 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
              <Button variant="subtle" size="iconSm" aria-label={`Rename "${s.title}"`} onClick={() => setRenaming({ id: s.session_id, title: s.title })}>
                <PencilIcon />
              </Button>
              <Button variant="subtle" size="iconSm" aria-label={`Delete "${s.title}"`} onClick={() => setDeleting(s)}>
                <TrashIcon />
              </Button>
            </span>
          </div>
        )
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <Title>Delete conversation?</Title>
          <Muted>
            “{deleting.title}” and its messages will be removed. Requests or escalations it created are not affected.
          </Muted>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Delete</Button>
          </div>
        </Modal>
      )}
    </nav>
  );
}
