import type { ComponentType, ReactNode } from "react";

import type { JsonObject, JsonValue, ResourceRef } from "@kanbaner/plugin-sdk";

/**
 * React-free контракт вызова публичной операции из UI.
 *
 * `apps/web` передаёт структурно совместимую реализацию, которая выполняет
 * ту же команду или запрос через общий OperationBus. UI-плагин не импортирует
 * server actions, shell или внутренности приложения.
 */
export interface UiOperationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type UiOperationResult =
  | { readonly ok: true; readonly data: JsonValue | null }
  | { readonly ok: false; readonly error: UiOperationError };

export type UiOperationInvoker = (
  operationId: string,
  input: JsonValue,
) => Promise<UiOperationResult>;

/**
 * Плоское описание метаданных вклада.
 *
 * Совместимо с `UiContribution` из `@kanbaner/plugin-sdk`, но не требует
 * импорта React-типов приложения. Дополнительные поля SDK допустимы.
 */
export interface UiContributionDescriptor {
  readonly id: string;
  readonly slot: string;
  readonly kind: string;
  readonly priority: number;
  readonly title?: string;
  readonly description?: string;
  readonly route?: string;
  readonly commandId?: string;
  readonly resourceType?: string;
  /** Плагин-владелец ресурса; по умолчанию совпадает с владельцем вклада. */
  readonly resourcePluginId?: string;
}

/** Безопасный результат открытия чужого ресурса через resource-opener. */
export type UiResourceOpenResult =
  | { readonly ok: true; readonly href: string; readonly contributionId: string }
  | {
      readonly ok: false;
      readonly code: "INVALID_RESOURCE_REF" | "RESOURCE_UNAVAILABLE";
      readonly message: string;
    };

/** Ссылка на ресурс другого плагина. */
export type UiResourceOpener = (ref: ResourceRef) => UiResourceOpenResult;

/** Слот, опубликованный плагином, вместе с JSON-контекстом. */
export type UiSlotRenderer = (slot: string, context?: JsonObject) => ReactNode;

export interface RegisteredUiContributionLike {
  readonly pluginId: string;
  readonly contribution: UiContributionDescriptor;
}

export interface UiRendererProps {
  readonly contribution: RegisteredUiContributionLike;
  readonly invoke: UiOperationInvoker;
  /**
   * Текущий pathname App Router из shell-а.
   *
   * Необязателен для обратной совместимости прямых рендеров в тестах;
   * production-shell всегда передаёт значение.
   */
  readonly pathname?: string | undefined;
  /**
   * Текущая query string App Router (с ведущим `?` или пустая).
   *
   * Additive-поле: прямые рендеры в тестах могут его не передавать.
   */
  readonly search?: string | undefined;
  /**
   * Поддерживаемое обновление query string через App Router.
   *
   * Нужно, чтобы `useSearchParams` оставался источником истины после
   * локального изменения фильтров/выбранной карточки. Если shell не передал
   * колбэк, плагин использует `history.replaceState`.
   */
  readonly replaceSearch?: ((search: string) => void) | undefined;
  /**
   * Сериализуемый контекст вложенного слота.
   *
   * Вклад не получает React-объекты или DOM родителя; только JSON-значения
   * вроде `{ resourceRef: "kanbaner.tasks:task:<id>" }`.
   */
  readonly context?: JsonObject | undefined;
  /**
   * Открывает `ResourceRef` через opener, зарегистрированный shell-ом.
   *
   * Неизвестный или отключённый ресурс возвращает безопасную ошибку.
   */
  readonly openResource?: UiResourceOpener | undefined;
  /** Рендерит вклад в опубликованный слот с JSON-контекстом. */
  readonly renderSlot?: UiSlotRenderer | undefined;
}

export type UiRenderer = ComponentType<UiRendererProps>;

export interface UiPluginContribution {
  readonly metadata: UiContributionDescriptor;
  readonly render: UiRenderer;
}

export interface UiPluginDefinition {
  readonly id: string;
  readonly contributions: readonly UiPluginContribution[];
}

/** Объявляет UI-плагин без зависимости от внутренностей shell. */
export function defineUiPlugin(definition: UiPluginDefinition): UiPluginDefinition {
  return definition;
}
