import { Blocks, LayoutDashboard, Settings, type LucideIcon } from "lucide-react";

export interface ShellNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/** Навигация shell-а. Доменных разделов здесь нет. */
export const CORE_NAV_ITEMS: readonly ShellNavItem[] = [
  { href: "/", label: "Обзор", icon: LayoutDashboard },
  { href: "/plugins", label: "Плагины", icon: Blocks },
  { href: "/settings", label: "Настройки", icon: Settings },
];

export function isActivePath(pathname: string, href: string): boolean {
  // Навигационный вклад может вести на тот же маршрут с query
  // (`/view/projects?entry=1`): активность определяется только pathname.
  const path = href.split("#")[0]?.split("?")[0] ?? href;

  if (path === "/") {
    return pathname === "/";
  }

  return pathname === path || pathname.startsWith(`${path}/`);
}
