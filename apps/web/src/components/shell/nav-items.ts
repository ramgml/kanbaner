import { LayoutDashboard, type LucideIcon } from "lucide-react";

export interface ShellNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * Пункты рабочей навигации shell-а. Администрирование (плагины и настройки)
 * сюда не входит: plugin manager живёт в `/settings/plugins`, а вход в
 * настройки — отдельная компактная иконка внизу навигации.
 */
export const CORE_NAV_ITEMS: readonly ShellNavItem[] = [
  { href: "/", label: "Обзор", icon: LayoutDashboard },
];

/** Единый адрес раздела настроек для shell-навигации. */
export const SETTINGS_HREF = "/settings";

/** Единственный адрес plugin manager после переноса в настройки. */
export const SETTINGS_PLUGINS_HREF = "/settings/plugins";

export function isActivePath(pathname: string, href: string): boolean {
  // Навигационный вклад может вести на тот же маршрут с query
  // (`/view/projects?entry=1`): активность определяется только pathname.
  const path = href.split("#")[0]?.split("?")[0] ?? href;

  if (path === "/") {
    return pathname === "/";
  }

  return pathname === path || pathname.startsWith(`${path}/`);
}
