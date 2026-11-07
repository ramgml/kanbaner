import type { CommandInvoker, ExecutionContext, QueryInvoker } from "./context.ts";
import type {
  EventEnvelope,
  EventSubscription,
  EventType,
  EventDeliveryContext,
  EventPublishOptions,
  EventPublishResult,
  EventUnsubscribe,
} from "./events.ts";
import { parseResourceRef } from "./resources.ts";
import type { OperationId, PluginId } from "./plugin-id.ts";
import type { CommandMetadata, QueryMetadata } from "./operations.ts";
import type {
  ResourceDescriptor,
  ResourceRef,
  ResourceService,
  ResourceType,
} from "./resources.ts";
import type { OperationResult } from "./results.ts";
import type { SearchRegistrar, PluginSearchService } from "./search.ts";
import type { PluginStorage } from "./storage/plugin-storage.ts";
import type { StorageProvider } from "./storage/provider.ts";
import { validateOperationResult } from "./validation.ts";
import type { UiContribution } from "./ui.ts";

/**
 * Обработчик операции, зарегистрированной через activation context.
 *
 * SDK намеренно не импортирует реализацию шины: обработчик получает только
 * публичный `ExecutionContext` и возвращает данные результата.
 */
export type ActivationOperationHandler = (
  input: unknown,
  context: ExecutionContext,
) => unknown | Promise<unknown>;

export interface ActivationCommandRegistration {
  readonly metadata: CommandMetadata;
  readonly handler: ActivationOperationHandler;
}

export interface ActivationQueryRegistration {
  readonly metadata: QueryMetadata;
  readonly handler: ActivationOperationHandler;
}

/**
 * Регистратор команд, доступный плагину во время активации.
 *
 * ID команды обязан принадлежать namespace-у плагина; ядро проверяет это до
 * регистрации. `unregister` нужен для повторной активации в новом runtime.
 */
export interface PluginCommandService extends CommandInvoker {
  register(registration: ActivationCommandRegistration): void;
  unregister(operationId: OperationId): boolean;
}

export interface PluginQueryService extends QueryInvoker {
  register(registration: ActivationQueryRegistration): void;
  unregister(operationId: OperationId): boolean;
}

/**
 * Структурный адаптер типа ресурса.
 *
 * `resolve` обязан быть чистым чтением. `null`/`undefined` означает
 * отсутствующий ресурс; `ResourceService.resolve` вернёт `NOT_FOUND`.
 */
export interface ActivationResourceAdapter {
  resolve(
    ref: ResourceRef,
  ): Promise<ResourceDescriptor | null | undefined> | ResourceDescriptor | null | undefined;
  canOpen?(ref: ResourceRef): Promise<boolean> | boolean;
  open?(ref: ResourceRef): Promise<void> | void;
}

/** Регистрация типов ресурсов, принадлежащих активируемому плагину. */
export interface ActivationResourceRegistration {
  readonly resourceTypes: readonly ResourceType[];
  readonly adapter: ActivationResourceAdapter;
}

/** Плагинный регистратор ресурсов; владелец подставляется runtime-ом. */
export interface PluginResourceRegistrar {
  register(registration: ActivationResourceRegistration): void;
  unregister(): void;
}

/** Хост-регистратор ресурсов; pluginId передаёт доверенный runtime. */
export interface ResourceRegistrar {
  register(pluginId: PluginId, registration: ActivationResourceRegistration): void;
  unregister(pluginId: PluginId): boolean;
}

/**
 * Подписка на события и публикация после коммита.
 *
 * Это хост-контракт: `pluginId` передаёт runtime, а не сам плагин.
 */
export interface EventService {
  subscribe(
    type: EventSubscription,
    handler: (envelope: EventEnvelope, context: EventDeliveryContext) => void | Promise<void>,
    options: { readonly pluginId: PluginId },
  ): EventUnsubscribe;
  publishAfterCommit(
    envelope: EventEnvelope,
    options: EventPublishOptions,
  ): Promise<EventPublishResult>;
}

/**
 * Публикация события из `ExecutionContext`.
 *
 * В execution context намеренно нет `subscribe`: подписки регистрируются
 * только activation tracker-ом и снимаются при деактивации.
 */
export interface PluginEventPublisher {
  publishAfterCommit(
    envelope: EventEnvelope,
    options: EventPublishOptions,
  ): Promise<EventPublishResult>;
}

/**
 * Плагинный фасад событий активации.
 *
 * Подписка автоматически привязывается к plugin ID. Публикация разрешена
 * только для событий и ресурсов собственного namespace-а.
 */
export interface PluginEventService extends PluginEventPublisher {
  subscribe(
    type: EventSubscription,
    handler: (envelope: EventEnvelope, context: EventDeliveryContext) => void | Promise<void>,
  ): EventUnsubscribe;
}

/** Плагинный регистратор UI-метаданных; владелец подставляется runtime-ом. */
export interface PluginUiRegistrar {
  register(contributions: readonly UiContribution[]): void;
  unregister(): void;
}

/** Хост-регистратор UI-метаданных активных плагинов. */
export interface UiContributionRegistrar {
  register(pluginId: PluginId, contributions: readonly UiContribution[]): void;
  unregister(pluginId: PluginId): void;
}

/**
 * Общие сервисы, которые composition root передаёт runtime-у.
 *
 * Это инфраструктура, а не доменный API: SDK не содержит React, SQL,
 * конкретного backend-а или реализаций ядра.
 */
export interface PluginHostServices {
  readonly commands: PluginCommandService;
  readonly queries: PluginQueryService;
  readonly resources: ResourceService;
  readonly resourceTypes: ResourceRegistrar;
  readonly events: EventService;
  readonly storage: StorageProvider;
  readonly search: SearchRegistrar;
  readonly ui: UiContributionRegistrar;
}

/**
 * Сервисы, которые получает серверный код плагина.
 *
 * Регистраторы уже привязаны к plugin ID. Storage — активный публичный
 * Storage Provider; плагин не открывает собственное соединение.
 */
export interface PluginActivationServices {
  readonly commands: PluginCommandService;
  readonly queries: PluginQueryService;
  readonly resources: ResourceService;
  readonly resourceTypes: PluginResourceRegistrar;
  readonly events: PluginEventService;
  readonly storage: PluginStorage;
  readonly search: PluginSearchService;
  readonly ui: PluginUiRegistrar;
}

/** Проверяет, что операция принадлежит namespace-у плагина. */
export function isOperationOwnedBy(operationId: OperationId, pluginId: PluginId): boolean {
  return operationId.startsWith(`${pluginId}.`);
}

/** Проверяет, что тип события принадлежит namespace-у плагина. */
export function isEventOwnedBy(type: EventType, pluginId: PluginId): boolean {
  return type.startsWith(`${pluginId}.`);
}

/**
 * Полная проверка владения событием.
 *
 * Источник, тип и ResourceRef обязаны принадлежать одному plugin ID. Это не
 * даёт опубликовать событие от чужого имени или очистить чужой ресурс.
 */
export function isEventOwnedByPlugin(envelope: EventEnvelope, pluginId: PluginId): boolean {
  if (envelope.source !== pluginId || !isEventOwnedBy(envelope.type, pluginId)) {
    return false;
  }

  try {
    return parseResourceRef(envelope.resource).pluginId === pluginId;
  } catch {
    return false;
  }
}

/**
 * Структурная проверка результата операции без импорта ядра.
 *
 * Используется обработчиками, которые хотят отличить ожидаемую ошибку
 * вложенного вызова от успешного результата.
 */
export function isOperationResult(value: unknown): value is OperationResult<unknown> {
  return validateOperationResult(value).ok;
}
