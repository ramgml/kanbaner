import { parseResourceRef, type ResourceRef } from "@kanbaner/plugin-sdk";

import type { RegisteredUiContribution, UiContributionRegistry } from "./registry";

/**
 * Безопасный результат открытия ресурса.
 *
 * Ошибка — обычное значение, а не исключение: shell и плагин остаются
 * работоспособными при неизвестной ссылке или отключённом обработчике.
 */
export type UiResourceOpenErrorCode = "INVALID_RESOURCE_REF" | "RESOURCE_UNAVAILABLE";

export type UiResourceOpenResult =
  | {
      readonly ok: true;
      readonly href: string;
      readonly contributionId: string;
    }
  | {
      readonly ok: false;
      readonly code: UiResourceOpenErrorCode;
      readonly message: string;
    };

export type UiResourceOpener = (ref: ResourceRef) => UiResourceOpenResult;

/** Минимальные данные доступности, не зависящие от plugin manager-а. */
export interface UiResourceAvailability {
  readonly activePluginIds: readonly string[];
}

function isActive(
  pluginId: string,
  availability: UiResourceAvailability | null | undefined,
): boolean {
  // Test-only и прямой рендер без availability разрешают вклад. Shell всегда
  // передаёт allowlist активных плагинов.
  return availability === null || availability === undefined
    ? true
    : availability.activePluginIds.includes(pluginId);
}

/**
 * Строит маршрут resource-opener-а с `resource=<encoded ResourceRef>`.
 *
 * Существующая query вклада сохраняется: opener может нести служебные
 * параметры, а ресурс добавляется отдельным ключом.
 */
export function buildResourceHref(route: string, ref: ResourceRef): string {
  const hashIndex = route.indexOf("#");
  const hash = hashIndex === -1 ? "" : route.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? route : route.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);

  params.set("resource", ref);

  return `${path}?${params.toString()}${hash}`;
}

/**
 * Находит доступный opener и вычисляет router-совместимый href.
 *
 * Ничего не навигирует и не трогает DOM: навигацию выполняет shell.
 */
export function resolveResourceOpen(
  registry: UiContributionRegistry,
  availability: UiResourceAvailability | null | undefined,
  ref: ResourceRef,
): UiResourceOpenResult {
  try {
    parseResourceRef(ref);
  } catch {
    return {
      ok: false,
      code: "INVALID_RESOURCE_REF",
      message: "Ссылка на ресурс повреждена и не может быть открыта",
    };
  }

  const opener: RegisteredUiContribution | null = registry.resolveResourceOpener(ref);

  if (opener === null || !isActive(opener.pluginId, availability)) {
    return {
      ok: false,
      code: "RESOURCE_UNAVAILABLE",
      message: "Для этого ресурса нет доступного способа открытия",
    };
  }

  const route = opener.contribution.route;

  if (route === undefined) {
    return {
      ok: false,
      code: "RESOURCE_UNAVAILABLE",
      message: "Обработчик ресурса не содержит маршрута",
    };
  }

  return {
    ok: true,
    href: buildResourceHref(route, ref),
    contributionId: opener.contribution.id,
  };
}

/**
 * Навигация без Next router-а.
 *
 * Используется только вне shell-а (например, в изолированных компонентных
 * тестах). AppShell передаёт router-aware колбэк.
 */
export function navigateWithHistory(href: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
