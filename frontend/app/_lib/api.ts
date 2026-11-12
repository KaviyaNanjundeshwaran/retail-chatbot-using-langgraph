export type User = { id: string; role: "customer" | "admin"; name: string };
export type Msg = { role: "user" | "assistant"; content: string; error?: boolean };
export type Confirmation = {
  type: "confirm_return";
  order_id: string;
  product_name: string;
  image_url?: string | null;
  reason: string;
  resolution: string;
  requires_manual_review: boolean;
};
type ChatEvent =
  | { event: "token"; data: string }
  | { event: "replace"; data: string }
  | { event: "status"; data: string }
  | { event: "tools"; data: string[] }
  | { event: "interrupt"; data: Confirmation }
  | { event: "done"; data: {} }
  | { event: "error"; data: { message: string } };

/** JSON call to the backend (proxied by Next rewrites, so the session cookie is same-origin). */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch("/api/" + path, {
    method: init.method ?? "GET",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** POST /api/chat and dispatch each Server-Sent Event as it arrives. */
export async function streamChat(body: object, signal: AbortSignal, onEvent: (e: ChatEvent) => void) {
  const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) onEvent({ event, data: JSON.parse(data) } as ChatEvent);
    }
  }
}
