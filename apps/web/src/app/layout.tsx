import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "../components/shell/app-shell";
import { FONT_SCALE_BOOTSTRAP_SCRIPT } from "../components/shell/font-scale";
import { toUiPluginAvailability } from "../lib/plugin-manager-types";
import { executePluginOperation } from "../server/plugin-operations";
import { getPluginManagerState, getPluginUiContributions } from "../server/plugin-service";
import { BuiltinUiPlugins } from "../ui/builtin-ui-plugins";
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
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: FONT_SCALE_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <UiRegistryProvider availability={availability} invoke={executePluginOperation}>
          <ServerUiContributions contributions={uiContributions} />
          <BuiltinUiPlugins />
          <AppShell safeMode={pluginState.safeMode} problemCount={pluginState.problems.length}>
            {children}
          </AppShell>
        </UiRegistryProvider>
      </body>
    </html>
  );
}
