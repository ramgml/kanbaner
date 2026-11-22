"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ShieldAlert, Sparkles, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { useUiContributions, UiResourceOpenerRuntime } from "../../ui/provider";
import { SETTINGS_PLUGINS_HREF } from "./nav-items";
import { DesktopSidebar, MobileNavigation } from "./shell-nav";
import { UiSlot } from "./ui-slot";
import { useDesktopAssistantResizer } from "./use-desktop-assistant-resizer";

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
        <Link href={SETTINGS_PLUGINS_HREF} className="underline underline-offset-4">
          Открыть plugin manager
        </Link>
      </AlertDescription>
    </Alert>
  );
}

function DetailsSlot({
  pathname,
  search,
  replaceSearch,
}: {
  readonly pathname: string;
  readonly search: string;
  readonly replaceSearch: (search: string) => void;
}) {
  const contributions = useUiContributions("app.details", pathname);

  if (contributions.length === 0) {
    return null;
  }

  return (
    <aside
      aria-label="Детали"
      data-testid="details-slot"
      className="hidden w-80 shrink-0 overflow-y-auto border-l bg-muted/20 p-4 xl:block"
    >
      <UiSlot
        slot="app.details"
        className="flex flex-col gap-3"
        pathname={pathname}
        search={search}
        replaceSearch={replaceSearch}
      />
    </aside>
  );
}

function AssistantSlot({
  pathname,
  search,
  replaceSearch,
}: {
  readonly pathname: string;
  readonly search: string;
  readonly replaceSearch: (search: string) => void;
}) {
  const contributions = useUiContributions("app.assistant");
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const resizer = useDesktopAssistantResizer();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setOpen(window.localStorage.getItem("kanbaner.opencode.panelOpen") === "true");
      setRestored(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (restored) window.localStorage.setItem("kanbaner.opencode.panelOpen", String(open));
  }, [open, restored]);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  if (contributions.length === 0) return null;

  return (
    <>
      {open ? null : (
        <button
          type="button"
          aria-label="Открыть OpenCode"
          data-testid="opencode-open"
          onClick={() => setOpen(true)}
          className="fixed right-3 bottom-20 z-30 inline-flex size-10 items-center justify-center rounded-full border bg-primary text-primary-foreground shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:bottom-4"
        >
          <Sparkles aria-hidden="true" className="size-5" />
        </button>
      )}
      {open ? (
        <aside
          id="opencode-assistant"
          aria-label="OpenCode assistant"
          data-testid="opencode-sidebar"
          style={resizer.asideStyle}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          className="fixed inset-0 z-50 flex max-h-dvh w-full shrink-0 flex-col border-l bg-background md:relative md:z-40"
        >
          <div
            {...resizer.separatorProps}
            aria-label="Ширина панели OpenCode"
            aria-controls="opencode-assistant"
            title="Потяните за границу, используйте стрелки, Home/End; двойной клик сбрасывает ширину"
            className="group absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none select-none focus-visible:bg-accent/60 focus-visible:outline-none md:block"
          >
            <span
              aria-hidden="true"
              data-app-assistant-resizer-line
              className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
                resizer.dragging
                  ? "bg-primary"
                  : "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary"
              }`}
            />
          </div>
          <div className="flex items-center justify-end border-b px-2 py-1">
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Закрыть OpenCode"
              data-testid="opencode-close"
              onClick={() => setOpen(false)}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <UiSlot
            slot="app.assistant"
            className="flex min-h-0 flex-1 flex-col"
            pathname={pathname}
            search={search}
            replaceSearch={replaceSearch}
          />
        </aside>
      ) : null}
    </>
  );
}

function OverlaysSlot({
  pathname,
  search,
  replaceSearch,
}: {
  readonly pathname: string;
  readonly search: string;
  readonly replaceSearch: (search: string) => void;
}) {
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
        <UiSlot
          slot="app.overlays"
          className="flex flex-col gap-2"
          pathname={pathname}
          search={search}
          replaceSearch={replaceSearch}
        />
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
  const search = useSearchParams()?.toString() ?? "";
  const router = useRouter();
  const [resourceNotice, setResourceNotice] = useState<string | null>(null);
  const replaceSearch = useCallback(
    (nextSearch: string) => {
      router.replace(`${pathname}${nextSearch}`, { scroll: false });
    },
    [pathname, router],
  );
  const navigateToResource = useCallback(
    (href: string) => {
      setResourceNotice(null);
      router.push(href, { scroll: false });
    },
    [router],
  );

  return (
    <UiResourceOpenerRuntime navigate={navigateToResource} onUnavailable={setResourceNotice}>
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
              {resourceNotice === null ? null : (
                <Alert role="status" data-testid="resource-open-notice" className="mb-4">
                  <AlertTitle>Ресурс недоступен</AlertTitle>
                  <AlertDescription>{resourceNotice}</AlertDescription>
                </Alert>
              )}
              {children}
            </main>

            <DetailsSlot pathname={pathname} search={search} replaceSearch={replaceSearch} />
            <AssistantSlot pathname={pathname} search={search} replaceSearch={replaceSearch} />
          </div>
        </div>

        <MobileNavigation pathname={pathname} safeMode={safeMode} />
        <OverlaysSlot pathname={pathname} search={search} replaceSearch={replaceSearch} />
      </div>
    </UiResourceOpenerRuntime>
  );
}
