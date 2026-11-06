import type {
  PluginLogger,
  ResourceDescriptor,
  ResourceLink,
  ResourceService,
  OperationResult,
} from "@kanbaner/plugin-sdk";

import { OperationFailure } from "./errors.ts";

/** Логгер по умолчанию: ядро не требует обязательного журналирования. */
export const NOOP_LOGGER: PluginLogger = Object.freeze({
  debug(): void {
    // Намеренно пусто.
  },
  info(): void {
    // Намеренно пусто.
  },
  warn(): void {
    // Намеренно пусто.
  },
  error(): void {
    // Намеренно пусто.
  },
});

function unavailable(): Promise<never> {
  return Promise.reject(
    new OperationFailure("PLUGIN_UNAVAILABLE", "Сервис ресурсов не подключён к шине операций"),
  );
}

/**
 * Заглушка `ctx.resources` до подключения сервиса из KAN-005.
 *
 * Не возвращает пустые данные: обращение к неприсоединённому сервису должно
 * быть явной ошибкой, а не скрытым успехом.
 */
export function createUnavailableResourceService(): ResourceService {
  return {
    link(): Promise<ResourceLink> {
      return unavailable();
    },
    unlink(): Promise<void> {
      return unavailable();
    },
    list(): Promise<readonly ResourceLink[]> {
      return unavailable();
    },
    resolve(): Promise<OperationResult<ResourceDescriptor>> {
      return unavailable();
    },
    canOpen(): Promise<boolean> {
      return unavailable();
    },
    open(): Promise<void> {
      return unavailable();
    },
  };
}
