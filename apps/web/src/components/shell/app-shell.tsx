"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { useUiContributions } from "../../ui/provider";
import { DesktopSidebar, MobileNavigation } from "./shell-nav";
import { UiSlot } from "./ui-slot";

function SafeModeNotice({ problemCount }: { readonly problemCount: number }) {
  return (
    <Alert variant="destructive" className="mb-4" data-testid="safe-mode-notice">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>Безопасный режим</AlertTitle>
      <AlertDescription>
        <p>
          Ядро запущено в safe mode. Проблемные плагины не активированы
          {problemCount > 0 ? `: ${String(problemCount)}` : ""}. Остальные разделы доступны.
        </p>
        <Link href="/plugins" className="underline underline-offset-4">
          Открыть plugin manager
        </Link>
      </AlertDescription>
    </Alert>
  );
}

function DetailsSlot() {
  const contributions = useUiContributions("app.details");

  if (contributions.length === 0) {
    return null;
  }

  return (
    <aside
      aria-label="Детали"
      data-testid="details-slot"
      className="hidden w-80 shrink-0 overflow-y-auto border-l bg-muted/20 p-4 xl:block"
    >
      <UiSlot slot="app.details" className="flex flex-col gap-3" />
    </aside>
  );
}

function OverlaysSlot() {
  const contributions = useUiContributions("app.overlays");

  if (contributions.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="overlays-slot"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 flex flex-col items-end justify-end gap-2 p-4"
    >
      <div className="pointer-events-auto flex w-full max-w-sm flex-col gap-2">
        <UiSlot slot="app.overlays" className="flex flex-col gap-2" />
      </div>
    </div>
  );
}

export interface AppShellProps {
  readonly children: ReactNode;
  readonly safeMode?: boolean;
  readonly problemCount?: number;
}

/**
 * Адаптивный shell: sidebar на desktop, нижняя навигация на мобильном.
 * Слоты `app.sidebar`, `app.details`, `app.settings`, `app.main` и
 * `app.overlays` рендерятся через клиентский реестр вкладов.
 */
export function AppShell({ children, safeMode = false, problemCount = 0 }: AppShellProps) {
  const pathname = usePathname() ?? "/";

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-background px-4 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
      >
        К содержимому
      </a>

      <div className="flex min-h-0 flex-1">
        <DesktopSidebar pathname={pathname} safeMode={safeMode} problemCount={problemCount} />

        {/* details и main — соседние элементы горизонтального flex; колонкой
            остаётся только основной контент. */}
        <div className="flex min-w-0 flex-1">
          <main
            id="main-content"
            tabIndex={-1}
            className="flex min-w-0 flex-1 flex-col px-3 pt-4 pb-24 focus:outline-none sm:px-6 md:pb-6"
          >
            {safeMode ? <SafeModeNotice problemCount={problemCount} /> : null}
            {children}
          </main>

          <DetailsSlot />
        </div>
      </div>

      <MobileNavigation pathname={pathname} safeMode={safeMode} />
      <OverlaysSlot />
    </div>
  );
}
