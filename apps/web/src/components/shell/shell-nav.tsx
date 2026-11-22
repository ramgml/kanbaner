"use client";

import Link from "next/link";

import { Blocks, Settings, ShieldAlert } from "lucide-react";

import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";
import { useUiContributions } from "../../ui/provider";
import {
  CORE_NAV_ITEMS,
  SETTINGS_HREF,
  SETTINGS_PLUGINS_HREF,
  isActivePath,
  resolvePluginNavIcon,
  type ShellNavItem,
} from "./nav-items";
import { UiSlot } from "./ui-slot";
import { useDesktopSidebarResizer } from "./use-desktop-sidebar-resizer";

interface ShellNavProps {
  readonly pathname: string;
  readonly safeMode?: boolean;
  readonly problemCount?: number;
}

function pluginNavItems(
  contributions: ReturnType<typeof useUiContributions>,
): readonly ShellNavItem[] {
  return contributions
    .filter(
      (contribution) =>
        contribution.contribution.kind === "navigation" &&
        contribution.contribution.route !== undefined,
    )
    .map((contribution) => ({
      href: contribution.contribution.route as string,
      label: contribution.contribution.title ?? contribution.contribution.id,
      icon: resolvePluginNavIcon(contribution.contribution.icon),
    }));
}

function mergeNavItems(pluginItems: readonly ShellNavItem[]): readonly ShellNavItem[] {
  const seen = new Set<string>();

  return [...CORE_NAV_ITEMS, ...pluginItems].filter((item) => {
    if (seen.has(item.href)) {
      return false;
    }

    seen.add(item.href);

    return true;
  });
}

function navLinkClass(active: boolean, mobile: boolean): string {
  const base = mobile
    ? "flex min-h-12 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    : "flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return `${base} ${
    active
      ? "bg-secondary text-secondary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  }`;
}

/**
 * Компактная иконка настройки: одна и та же доступная ссылка на desktop и
 * mobile, без текстового пункта в рабочей навигации.
 */
function navIconLinkClass(active: boolean, mobile: boolean): string {
  const base = mobile
    ? "flex min-h-12 w-12 flex-col items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    : "flex size-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return `${base} ${
    active
      ? "bg-secondary text-secondary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  }`;
}

export function DesktopSidebar({ pathname, safeMode = false, problemCount = 0 }: ShellNavProps) {
  const sidebarContributions = useUiContributions("app.sidebar");
  const items = mergeNavItems(pluginNavItems(sidebarContributions));
  const settingsActive = isActivePath(pathname, SETTINGS_HREF);
  const resizer = useDesktopSidebarResizer();

  return (
    <aside
      aria-label="Боковая панель"
      id="app-sidebar"
      data-testid="desktop-sidebar"
      style={resizer.asideStyle}
      className="relative hidden max-h-dvh shrink-0 flex-col border-r bg-muted/20 md:flex"
    >
      <div className="flex h-14 items-center border-b px-4">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Blocks aria-hidden="true" className="size-5" />
          Kanbaner
        </Link>
      </div>

      <nav aria-label="Основная навигация" className="flex min-h-0 flex-1 flex-col gap-4 p-3">
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = isActivePath(pathname, item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={navLinkClass(active, false)}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <UiSlot
          slot="app.sidebar"
          excludeKinds={["navigation"]}
          className="flex min-h-0 flex-1 flex-col gap-2"
        />

        <div className="mt-auto flex flex-col gap-3">
          <Separator />
          {safeMode ? (
            <Link
              href={SETTINGS_PLUGINS_HREF}
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0">
                Safe mode
                {problemCount > 0 ? `: ${String(problemCount)} проблем` : ""}
              </span>
            </Link>
          ) : (
            <p className="px-3 text-xs text-muted-foreground">Локальный режим</p>
          )}
          <div className="flex items-center justify-between gap-2 px-1">
            <Badge variant="outline" className="mx-2 w-fit">
              Plugin Contract v1
            </Badge>
            <Link
              href={SETTINGS_HREF}
              aria-label="Настройки"
              aria-current={settingsActive ? "page" : undefined}
              data-testid="settings-link-desktop"
              title="Настройки"
              className={navIconLinkClass(settingsActive, false)}
            >
              <Settings aria-hidden="true" className="size-4 shrink-0" />
            </Link>
          </div>
        </div>
      </nav>
      <div
        {...resizer.separatorProps}
        aria-label="Ширина боковой панели"
        aria-controls="app-sidebar"
        title="Потяните за границу, используйте стрелки, Home/End; двойной клик сбрасывает ширину"
        className="group absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none select-none focus-visible:bg-accent/60 focus-visible:outline-none md:block"
      >
        <span
          aria-hidden="true"
          data-app-sidebar-resizer-line
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
            resizer.dragging
              ? "bg-primary"
              : "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary"
          }`}
        />
      </div>
    </aside>
  );
}

export function MobileNavigation({ pathname, safeMode = false }: ShellNavProps) {
  const sidebarContributions = useUiContributions("app.sidebar");
  const items = mergeNavItems(pluginNavItems(sidebarContributions));
  const settingsActive = isActivePath(pathname, SETTINGS_HREF);

  return (
    <nav
      aria-label="Мобильная навигация"
      data-testid="mobile-navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="flex items-stretch gap-1 overflow-x-auto px-1 py-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActivePath(pathname, item.href);

          return (
            <li key={item.href} className="flex min-w-16 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={navLinkClass(active, true)}
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex shrink-0">
          <Link
            href={SETTINGS_HREF}
            aria-label="Настройки"
            aria-current={settingsActive ? "page" : undefined}
            data-testid="settings-link-mobile"
            title="Настройки"
            className={navIconLinkClass(settingsActive, true)}
          >
            <Settings aria-hidden="true" className="size-5 shrink-0" />
          </Link>
        </li>
        {safeMode ? (
          <li className="flex min-w-16 flex-1">
            <Link
              href={SETTINGS_PLUGINS_HREF}
              className={navLinkClass(false, true)}
              aria-label="Открыть plugin manager: safe mode"
            >
              <ShieldAlert aria-hidden="true" className="size-5 shrink-0 text-destructive" />
              <span className="max-w-full truncate">Safe mode</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
