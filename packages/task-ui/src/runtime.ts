import type { ComponentType } from "react";

import type { JsonValue } from "@kanbaner/plugin-sdk";

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
}

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
