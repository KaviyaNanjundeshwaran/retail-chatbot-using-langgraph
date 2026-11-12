import type { ReactNode } from "react";
import { APP_NAME } from "./_lib/config";
import "./tailwind.css";

export const metadata = { title: APP_NAME };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
