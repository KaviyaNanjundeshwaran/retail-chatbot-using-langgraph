"use client";
import { useEffect, useState } from "react";
import { Admin } from "./_components/Admin";
import { Chat } from "./_components/Chat";
import { Login } from "./_components/Login";
import { api, type User } from "./_lib/api";

export default function Page() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: User | null }>("auth/me").then((d) => setUser(d.user), () => setUser(null));
  }, []);

  async function logout() {
    await api("auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }

  if (user === undefined) return <div className="grid min-h-dvh place-items-center text-sm text-ink-3">Loading…</div>;
  if (!user) return <Login onLogin={setUser} />;
  return user.role === "admin" ? <Admin user={user} onLogout={logout} /> : <Chat user={user} onLogout={logout} />;
}
