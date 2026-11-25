import { Flag, FolderKanban, NotebookTabs, Search, type LucideIcon } from "lucide-react";

export interface ShellNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * Статический allowlist иконок навигации плагинов.
 *
 * Metadata содержат только строковый идентификатор: shell не выполняет
 * динамический импорт и не разрешает произвольные имена компонентов.
 */
const PLUGIN_NAV_ICONS: ReadonlyMap<string, LucideIcon> = new Map([
  ["folder-kanban", FolderKanban],
  ["notebook-tabs", NotebookTabs],
  ["search", Search],
]);

/** Иконка плагина без `icon` или с неизвестным идентификатором. */
export const FALLBACK_PLUGIN_NAV_ICON: LucideIcon = Flag;

export function resolvePluginNavIcon(icon: string | undefined): LucideIcon {
  if (icon === undefined) {
    return FALLBACK_PLUGIN_NAV_ICON;
  }

  return PLUGIN_NAV_ICONS.get(icon) ?? FALLBACK_PLUGIN_NAV_ICON;
}

/**
 * Пункты рабочей навигации shell-а.
 *
 * Ядро не добавляет собственных пунктов: рабочая навигация строится только
 * из вкладов доменных плагинов. Администрирование (плагины и настройки)
 * сюда не входит: plugin manager живёт в `/settings/plugins`, а вход в
 * настройки — отдельная компактная иконка внизу навигации. Обзор доступен
 * с корневого маршрута `/` и из карточки в `/settings`.
 */
export const CORE_NAV_ITEMS: readonly ShellNavItem[] = [];

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
