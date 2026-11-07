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
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
