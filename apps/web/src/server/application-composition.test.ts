// @vitest-environment node

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider, createPluginRuntime, type PluginRuntime } from "@kanbaner/kernel";
import {
  createJsonObjectSchema,
  type EventEnvelope,
  type OperationResult,
  type PluginLogger,
  type QueryMetadata,
} from "@kanbaner/plugin-sdk";

import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "./application-composition.ts";
import type { UiOperationInvokeOptions } from "../ui/operation-types.ts";

const PACKAGES_DIRECTORY = path.resolve(import.meta.dirname, "../../../../packages");

/**
 * Публичные ID контракта заметок.
 *
 * Тест проверяет транспорт приложения, поэтому не импортирует внутренности
 * плагина: OperationBus и runtime находят его по манифесту в packages.
 */
const NOTES_PLUGIN_ID = "kanbaner.notes";
const NOTES_COMMAND_CREATE = "kanbaner.notes.note.create";
const NOTES_QUERY_LIST = "kanbaner.notes.note.list";
const NOTES_EVENT_CREATED = "kanbaner.notes.note.created";

/** Соседние домены выключены: тест проверяет только transport и notes. */
const DISABLED_PLUGINS = ["kanbaner.fixture", "kanbaner.projects", "kanbaner.tasks"] as const;

const NOOP_LOGGER: PluginLogger = Object.freeze({
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

interface Harness {
  readonly provider: InMemoryStorageProvider;
  readonly composition: ApplicationPluginComposition;
  readonly runtime: PluginRuntime;
  readonly events: EventEnvelope[];
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const provider = new InMemoryStorageProvider({
    backendId: `ui-idempotency-${globalThis.crypto.randomUUID()}`,
  });

  await provider.open();

  const composition = createApplicationPluginComposition({
    storage: provider,
    logger: NOOP_LOGGER,
  });
  const events: EventEnvelope[] = [];
  const runtime = createPluginRuntime({
    pluginDirectories: [PACKAGES_DIRECTORY],
    disabledPlugins: [...DISABLED_PLUGINS],
    services: composition.services,
  });

  const snapshot = await runtime.start();
  const notes = snapshot.plugins.find((plugin) => plugin.pluginId === NOTES_PLUGIN_ID);

  if (notes === undefined || !notes.activated) {
    throw new Error(
      `Плагин ${NOTES_PLUGIN_ID} не активировался: ${JSON.stringify(snapshot.problems)}`,
    );
  }

  composition.bindPlugins(
    snapshot.plugins
      .filter((plugin) => plugin.activated && plugin.pluginId !== null)
      .map((plugin) => plugin.pluginId as string),
  );

  const unsubscribe = composition.events.subscribe(
    "kanbaner.notes.*",
    (envelope) => {
      events.push(envelope);
    },
    { pluginId: "kanbaner.notes-ui-test" },
  );

  let closed = false;

  const harness: Harness = {
    provider,
    composition,
    runtime,
    events,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      unsubscribe();
      await runtime.stop();
      composition.dispose();
      await provider.close();
    },
  };

  harnesses.push(harness);

  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.close();
  }
});

function expectData<Data>(result: OperationResult<unknown>): Data {
  if (!result.ok) {
    throw new Error(`Операция упала: ${result.error.code} (${result.error.message})`);
  }

  return result.data as Data;
}

function noteCount(harness: Harness): number {
  return harness.events.filter((event) => event.type === NOTES_EVENT_CREATED).length;
}

const NOTE_INPUT = { title: "Идемпотентная", contentMarkdown: "Текст" };

describe("Idempotency-Key в UI transport", () => {
  it(
    "передаёт ключ команде и повторяет результат без второй мутации",
    { timeout: 20_000 },
    async () => {
      const harness = await startHarness();

      const first = expectData<unknown>(
        await harness.composition.executeUiOperation(NOTES_COMMAND_CREATE, NOTE_INPUT, {
          idempotencyKey: "ui-key",
        }),
      );
      const eventsAfterFirst = noteCount(harness);

      const second = expectData<unknown>(
        await harness.composition.executeUiOperation(NOTES_COMMAND_CREATE, NOTE_INPUT, {
          idempotencyKey: "ui-key",
        }),
      );
      const eventsAfterSecond = noteCount(harness);

      expect(second).toEqual(first);
      expect(eventsAfterFirst).toBe(1);
      expect(eventsAfterSecond).toBe(1);
      expect(
        expectData<{ readonly total: number }>(
          await harness.composition.executeUiOperation(NOTES_QUERY_LIST, {}),
        ).total,
      ).toBe(1);
    },
  );

  it("не передаёт ключ запросу", { timeout: 20_000 }, async () => {
    const harness = await startHarness();
    const metadata: QueryMetadata = {
      id: "kanbaner.test.ui.query",
      contract: "kanbaner.test.queries.v1",
      version: 1,
      kind: "query",
      risk: "read",
      exposure: { ui: true, http: false, mcp: false },
      inputSchema: createJsonObjectSchema(),
      outputSchema: createJsonObjectSchema(),
    };
    let observedKey: unknown = "sentinel";

    harness.composition.operations.registerQuery({
      metadata,
      handler: (_input, context) => {
        observedKey = context.idempotencyKey;

        return { kind: "query" };
      },
    });

    const result = await harness.composition.executeUiOperation(
      metadata.id,
      {},
      { idempotencyKey: "query-key" },
    );

    expect(expectData(result)).toEqual({ kind: "query" });
    expect(observedKey).toBeUndefined();
  });

  it(
    "отбрасывает пустой и нестроковый ключ вместо VALIDATION_ERROR",
    { timeout: 20_000 },
    async () => {
      const harness = await startHarness();

      expectData(
        await harness.composition.executeUiOperation(NOTES_COMMAND_CREATE, NOTE_INPUT, {
          idempotencyKey: "",
        }),
      );

      const invalidOptions = { idempotencyKey: 42 } as unknown as UiOperationInvokeOptions;

      expectData(
        await harness.composition.executeUiOperation(
          NOTES_COMMAND_CREATE,
          { title: "Без ключа" },
          invalidOptions,
        ),
      );

      expect(
        expectData<{ readonly total: number }>(
          await harness.composition.executeUiOperation(NOTES_QUERY_LIST, {}),
        ).total,
      ).toBe(2);
    },
  );

  it(
    "без ключа сохраняет прежнее поведение и создаёт две заметки",
    { timeout: 20_000 },
    async () => {
      const harness = await startHarness();

      await harness.composition.executeUiOperation(NOTES_COMMAND_CREATE, NOTE_INPUT);
      await harness.composition.executeUiOperation(NOTES_COMMAND_CREATE, NOTE_INPUT);

      expect(noteCount(harness)).toBe(2);
      expect(
        expectData<{ readonly total: number }>(
          await harness.composition.executeUiOperation(NOTES_QUERY_LIST, {}),
        ).total,
      ).toBe(2);
    },
  );
});
