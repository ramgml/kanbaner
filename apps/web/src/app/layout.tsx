import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "../components/shell/app-shell";
import { toUiPluginAvailability } from "../lib/plugin-manager-types";
import { getPluginManagerState, getPluginUiContributions } from "../server/plugin-service";
import { UiRegistryProvider } from "../ui/provider";
import { ServerUiContributions } from "../ui/server-contributions";
import "./globals.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kanbaner",
  description: "Локальная система управления задачами и заметками",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const pluginState = await getPluginManagerState();
  const uiContributions = await getPluginUiContributions();
  const availability = toUiPluginAvailability(pluginState);

  return (
    <html lang="ru">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <UiRegistryProvider availability={availability}>
          <ServerUiContributions contributions={uiContributions} />
          <AppShell safeMode={pluginState.safeMode} problemCount={pluginState.problems.length}>
            {children}
          </AppShell>
        </UiRegistryProvider>
      </body>
    </html>
  );
}
