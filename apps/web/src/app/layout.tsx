import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Kanbaner",
  description: "Локальная система управления задачами и заметками",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ru">
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
