import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createPluginRuntime,
  InMemoryStorageProvider,
  type PluginRuntime,
  type PluginRuntimeSnapshot,
} from "@kanbaner/kernel";
import type { PluginLogger, StorageProvider } from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "../../apps/web/src/server/application-composition";
import {
  createApplicationStorage,
  type ApplicationStorageRuntime,
} from "../../apps/web/src/server/application-storage";
import { migratePluginWithSqlite } from "../../apps/web/src/server/sqlite-plugin-migrations";

/**
 * Discovery root, а не сам пакет: ядро ищет `<root>/<plugin-dir>/plugin.json`.
 * `packages/` содержит `plugin-fixture/plugin.json`; остальные каталоги без
 * манифеста корректно пропускаются.
 */
export const FIXTURE_DISCOVERY_ROOT = path.resolve(import.meta.dirname, "../../packages");

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

export interface FixtureHarness {
  readonly dataDirectory: string;
  readonly provider: StorageProvider;
  readonly storage: ApplicationStorageRuntime | null;
  readonly composition: ApplicationPluginComposition;
  readonly runtime: PluginRuntime;
  readonly snapshot: PluginRuntimeSnapshot;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface FixtureHarnessOptions {
  readonly dataDirectory?: string;
  readonly provider?: StorageProvider;
  readonly migrate?: boolean;
  readonly removeOnClose?: boolean;
  readonly pluginDirectories?: readonly string[];
  /** Plugin ID, которые runtime должен оставить отключёнными. */
  readonly disabledPlugins?: readonly string[];
}

export function temporaryDirectory(prefix = "kanbaner-kan008-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function removeDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

async function prepareProvider(
  dataDirectory: string,
  options: FixtureHarnessOptions,
): Promise<{ provider: StorageProvider; storage: ApplicationStorageRuntime | null }> {
  if (options.provider !== undefined) {
    if (options.migrate === false) {
      await options.provider.open();

      return { provider: options.provider, storage: null };
    }

    // Даже готовый провайдер должен получить core-таблицы: без
    // инфраструктурных миграций SQLite не знает про documents/searchIndex.
    const storage = await createApplicationStorage({
      dataDirectory,
      provider: options.provider,
    });

    return { provider: storage.provider, storage };
  }

  const storage = await createApplicationStorage({ dataDirectory });

  return { provider: storage.provider, storage };
}

/**
 * Активирует fixture только через публичный lifecycle.
 *
 * Composition root передаёт общие сервисы; runtime сам привязывает их к
 * plugin ID. Тест не импортирует fixture-модуль и не вызывает activate
 * напрямую.
 */
export async function startFixtureHarness(
  options: FixtureHarnessOptions = {},
): Promise<FixtureHarness> {
  const dataDirectory = options.dataDirectory ?? temporaryDirectory();
  const { provider, storage } = await prepareProvider(dataDirectory, options);
  const composition = createApplicationPluginComposition({
    storage: provider,
    logger: NOOP_LOGGER,
  });
  const migrate = options.migrate !== false;

  const runtime = createPluginRuntime({
    pluginDirectories: options.pluginDirectories ?? [FIXTURE_DISCOVERY_ROOT],
    ...(options.disabledPlugins === undefined ? {} : { disabledPlugins: options.disabledPlugins }),
    hooks: {
      migrate: async (context) => {
        if (!migrate) {
          return;
        }

        await migratePluginWithSqlite(context, {
          provider,
          ...(storage === null ? {} : { health: storage.health }),
        });
      },
    },
    services: composition.services,
    logger: {
      log(): void {
        // Намеренно пусто.
      },
    },
  });

  const snapshot = await runtime.start();
  composition.bindPlugins(
    snapshot.plugins
      .filter((plugin) => plugin.activated && plugin.pluginId !== null)
      .map((plugin) => plugin.pluginId as string),
  );

  return {
    dataDirectory,
    provider,
    storage,
    composition,
    runtime,
    snapshot,
    async stop(): Promise<void> {
      await runtime.stop();
    },
    async close(): Promise<void> {
      await runtime.stop();
      composition.dispose();

      if (storage !== null) {
        await storage.registry.closeAll();
      } else {
        await provider.close();
      }

      if (options.removeOnClose !== false) {
        removeDirectory(dataDirectory);
      }
    },
  };
}

export async function startInMemoryHarness(
  delays: { readonly operationMs?: number; readonly transactionMs?: number } = {},
): Promise<FixtureHarness> {
  const provider = new InMemoryStorageProvider({
    backendId: `memory-fixture-${globalThis.crypto.randomUUID()}`,
    delays,
  });

  return startFixtureHarness({
    provider,
    migrate: false,
  });
}
