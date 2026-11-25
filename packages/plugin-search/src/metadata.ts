import type { UiContribution } from "@kanbaner/plugin-sdk";

import { SEARCH_ROUTE } from "./constants.ts";

/**
 * UI-вклады глобального поиска.
 *
 * Плагин публикует только view и navigation. Resource-opener-ы принадлежат
 * доменам: поиск не открывает чужие ресурсы сам, а передаёт `ResourceRef`
 * shell-у, который выбирает opener по pluginId/resourceType.
 */
export const searchUiContributions: readonly UiContribution[] = Object.freeze([
  {
    id: "kanbaner.search.view",
    slot: "app.main",
    kind: "view",
    priority: 90,
    title: "Поиск",
    description: "Глобальный поиск по задачам, заметкам и активным провайдерам",
    route: SEARCH_ROUTE,
  },
  {
    id: "kanbaner.search.navigation",
    slot: "app.sidebar",
    kind: "navigation",
    priority: 60,
    title: "Поиск",
    description: "Вход в глобальный поиск",
    route: SEARCH_ROUTE,
    icon: "search",
  },
]);
