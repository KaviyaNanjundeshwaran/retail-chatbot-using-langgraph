"use client";
import { useState, type FormEvent } from "react";
import { api, type User } from "../_lib/api";
import { APP_NAME } from "../_lib/config";
import { Button, Card, ErrorText, Field, Input, Muted, Segmented } from "./ui";

const ROLES = { Customer: "customer", Admin: "admin" } as const;

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [tab, setTab] = useState<keyof typeof ROLES>("Customer");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin((await api<{ user: User }>("auth/login", { method: "POST", body: { role: ROLES[tab], email, password } })).user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-ink">{APP_NAME}</h1>
          <Muted>Sign in to continue.</Muted>
        </div>
        <Card className="p-6">
          <form className="space-y-5" onSubmit={submit}>
            <Segmented label="Account type" options={Object.keys(ROLES) as (keyof typeof ROLES)[]} value={tab} onChange={setTab} full />
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required />
            </Field>
            <Field label="Password">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
            </Field>
            {error && <ErrorText>{error}</ErrorText>}
            <Button variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign In"}</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
