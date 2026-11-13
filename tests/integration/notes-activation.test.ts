// @vitest-environment node

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStorageProvider, createPluginRuntime, type PluginRuntime } from "@kanbaner/kernel";
import type {
  CommandMetadata,
  EventEnvelope,
  JsonValue,
  OperationResult,
  PluginLogger,
  StorageProvider,
} from "@kanbaner/plugin-sdk";

import {
  NOTE_COLLECTION,
  NOTES_COMMAND_IDS,
  NOTES_EVENT_TYPES,
  NOTES_IDEMPOTENCY_COLLECTION,
  NOTES_PLUGIN_ID,
  NOTES_QUERY_IDS,
  NOTES_RELATION,
  formatNoteRef,
  type Note,
  type NoteDeleteResult,
  type NoteDetails,
  type NoteMoveResult,
  type NoteView,
} from "../../packages/plugin-notes/src/contract.ts";
import {
  createApplicationPluginComposition,
  type ApplicationPluginComposition,
} from "../../apps/web/src/server/application-composition.ts";

const PACKAGES_DIRECTORY = path.resolve(import.meta.dirname, "../../packages");

/** Плагины вне объёма домена заметок: тест активирует только notes. */
const DISABLED_PLUGINS = ["kanbaner.fixture", "kanbaner.projects", "kanbaner.tasks"] as const;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

interface HarnessOptions {
  readonly provider?: InMemoryStorageProvider;
  readonly decorateProvider?: (provider: StorageProvider) => StorageProvider;
}

interface NotesHarness {
  readonly provider: InMemoryStorageProvider;
  readonly composition: ApplicationPluginComposition;
  readonly runtime: PluginRuntime;
  readonly events: EventEnvelope[];
  command<T = unknown>(
    operationId: string,
    input: unknown,
    options?: { readonly idempotencyKey?: string },
  ): Promise<OperationResult<T>>;
  query<T = unknown>(operationId: string, input: unknown): Promise<OperationResult<T>>;
  close(): Promise<void>;
}

const harnesses: NotesHarness[] = [];

async function startHarness(options: HarnessOptions = {}): Promise<NotesHarness> {
  const provider =
    options.provider ??
    new InMemoryStorageProvider({
      backendId: `notes-activation-${globalThis.crypto.randomUUID()}`,
    });

  if (options.provider === undefined) {
    await provider.open();
  }

  const decorated =
    options.decorateProvider === undefined ? provider : options.decorateProvider(provider);
  const composition = createApplicationPluginComposition({
    storage: decorated,
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
      `Плагин ${NOTES_PLUGIN_ID} не активировался: ${JSON.stringify(snapshot.problems)} ${JSON.stringify(snapshot.diagnostics)}`,
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
    { pluginId: "kanbaner.notes-test" },
  );

  let closed = false;

  const harness: NotesHarness = {
    provider,
    composition,
    runtime,
    events,
    command<T = unknown>(
      operationId: string,
      input: unknown,
      invocationOptions: { readonly idempotencyKey?: string } = {},
    ) {
      return composition.operations.executeCommand<unknown, T>(
        operationId,
        input,
        invocationOptions.idempotencyKey === undefined
          ? { source: { type: "system", id: "notes-activation-test" } }
          : {
              source: { type: "system", id: "notes-activation-test" },
              idempotencyKey: invocationOptions.idempotencyKey,
            },
      );
    },
    query<T = unknown>(operationId: string, input: unknown) {
      return composition.operations.executeQuery<unknown, T>(operationId, input, {
        source: { type: "system", id: "notes-activation-test" },
      });
    },
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

function expectOk<Data>(result: OperationResult<Data>): Data {
  if (!result.ok) {
    throw new Error(`Операция упала: ${result.error.code} (${result.error.message})`);
  }

  return result.data;
}

async function createNote(
  harness: NotesHarness,
  input: Record<string, unknown> = {},
  options: { readonly idempotencyKey?: string } = {},
): Promise<NoteDetails> {
  return expectOk<NoteDetails>(
    await harness.command(NOTES_COMMAND_IDS.create, { title: "Заметка", ...input }, options),
  );
}

function moveData(result: OperationResult<unknown>): NoteMoveResult {
  return expectOk<unknown>(result) as NoteMoveResult;
}

function mutationMetadata(harness: NotesHarness, operationId: string): CommandMetadata {
  const descriptor = harness.composition.operations.registry.get(operationId);

  if (descriptor === undefined || descriptor.metadata.kind !== "mutation") {
    throw new Error(`Команда ${operationId} не зарегистрирована`);
  }

  return descriptor.metadata;
}

async function waitFor<Value>(
  check: () => Promise<Value | null>,
  timeoutMs = 5_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await check();

    if (value !== null) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error("Не дождались ожидаемого состояния");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function outputProperties(schema: JsonValue | undefined): readonly string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return [];
  }

  const properties = (schema as Record<string, unknown>).properties;

  return typeof properties === "object" && properties !== null
    ? Object.keys(properties).sort()
    : [];
}

describe("активация kanbaner.notes", () => {
  it("регистрирует команды, запросы, UI-метаданные и контракт результата", async () => {
    const harness = await startHarness();

    const commands = harness.composition.operations.registry.commands
      .list()
      .filter((descriptor) => descriptor.pluginId === NOTES_PLUGIN_ID);
    const queries = harness.composition.operations.registry.queries
      .list()
      .filter((descriptor) => descriptor.pluginId === NOTES_PLUGIN_ID);

    expect(commands.map((descriptor) => descriptor.id).sort()).toEqual(
      Object.values(NOTES_COMMAND_IDS).sort(),
    );
    expect(queries.map((descriptor) => descriptor.id).sort()).toEqual(
      Object.values(NOTES_QUERY_IDS).sort(),
    );

    const deleteCommand = mutationMetadata(harness, NOTES_COMMAND_IDS.delete);
    const visitCommand = mutationMetadata(harness, NOTES_COMMAND_IDS.recordVisit);
    const linkCommand = mutationMetadata(harness, NOTES_COMMAND_IDS.link);

    expect(deleteCommand.risk).toBe("destructive");
    expect(deleteCommand.exposure?.mcp).toBe(false);
    expect(visitCommand.exposure?.mcp).toBe(false);
    expect(linkCommand.idempotency).toBe("none");
    expect(linkCommand.exposure).toEqual({ ui: true, http: true, mcp: true });

    const createCommand = harness.composition.operations.registry.get(NOTES_COMMAND_IDS.create);
    const updateCommand = harness.composition.operations.registry.get(NOTES_COMMAND_IDS.update);
    const favoriteCommand = harness.composition.operations.registry.get(
      NOTES_COMMAND_IDS.favoriteSet,
    );
    const moveCommand = harness.composition.operations.registry.get(NOTES_COMMAND_IDS.move);
    const getQuery = harness.composition.operations.registry.get(NOTES_QUERY_IDS.get);

    expect(outputProperties(createCommand?.metadata.outputSchema)).toEqual([
      "ancestors",
      "attachments",
      "view",
    ]);
    expect(outputProperties(updateCommand?.metadata.outputSchema)).toEqual([
      "ancestors",
      "attachments",
      "view",
    ]);
    expect(outputProperties(getQuery?.metadata.outputSchema)).toEqual([
      "ancestors",
      "attachments",
      "view",
    ]);
    expect(outputProperties(favoriteCommand?.metadata.outputSchema)).toEqual(["view"]);
    expect(outputProperties(moveCommand?.metadata.outputSchema)).toEqual(["affectedNotes", "note"]);

    const contributions = harness.composition
      .listUiContributions()
      .filter((record) => record.pluginId === NOTES_PLUGIN_ID);

    expect(contributions.map((record) => record.contribution.id).sort()).toEqual([
      "kanbaner.notes.navigation",
      "kanbaner.notes.open",
      "kanbaner.notes.task-related",
      "kanbaner.notes.view",
    ]);
    expect(
      contributions.find((record) => record.contribution.id === "kanbaner.notes.open")?.contribution
        .kind,
    ).toBe("resource-opener");
  });

  it("возвращает согласованные NoteDetails, NoteView и NoteDeleteResult", async () => {
    const harness = await startHarness();
    const created = await createNote(harness, {
      title: "  Первая  ",
      contentMarkdown: "# Текст",
    });

    expect(created.view).toMatchObject({
      favorite: false,
      lastOpenedAt: null,
      childCount: 0,
      note: { title: "Первая", contentMarkdown: "# Текст", version: 1, parentId: null },
    });
    expect(created.ancestors).toEqual([]);
    expect(created.attachments).toEqual([]);

    const noteId = created.view.note.id;
    const updated = expectOk<NoteDetails>(
      await harness.command(NOTES_COMMAND_IDS.update, {
        id: noteId,
        expectedVersion: 1,
        title: "Обновлённая",
        contentMarkdown: "Новый текст",
      }),
    );

    expect(updated.view.note).toMatchObject({ title: "Обновлённая", version: 2 });

    const fetched = expectOk<NoteDetails>(await harness.query(NOTES_QUERY_IDS.get, { id: noteId }));

    expect(fetched.view.note).toMatchObject({ title: "Обновлённая", version: 2 });

    const favorite = expectOk<{ readonly view: NoteView }>(
      await harness.command(NOTES_COMMAND_IDS.favoriteSet, { id: noteId, favorite: true }),
    );

    expect(favorite.view.favorite).toBe(true);
    expect(favorite.view.note.version).toBe(2);

    const visited = expectOk<{ readonly view: NoteView }>(
      await harness.command(NOTES_COMMAND_IDS.recordVisit, { id: noteId }),
    );

    expect(visited.view.lastOpenedAt).not.toBeNull();
    expect(visited.view.note.version).toBe(2);

    const deleted = expectOk<NoteDeleteResult>(
      await harness.command(NOTES_COMMAND_IDS.delete, {
        id: noteId,
        expectedVersion: 2,
        confirm: true,
      }),
    );

    expect(deleted.deleted).toBe(true);

    if (deleted.deleted) {
      expect(deleted.deletedNotes.map((note) => note.id)).toEqual([noteId]);
    }

    expect((await harness.query(NOTES_QUERY_IDS.get, { id: noteId })).ok).toBe(false);
  });

  it("перемещает ветку и возвращает note вместо view", async () => {
    const harness = await startHarness();
    const root = await createNote(harness, { title: "Корень" });
    const child = await createNote(harness, { title: "Ветка" });
    const moving = await createNote(harness, { title: "Лист" });
    const rootId = root.view.note.id;
    const childId = child.view.note.id;
    const movingId = moving.view.note.id;

    const underChild = moveData(
      await harness.command(NOTES_COMMAND_IDS.move, {
        id: movingId,
        expectedVersion: 1,
        parentId: childId,
      }),
    );

    expect(underChild.note).toMatchObject({ id: movingId, parentId: childId, position: 0 });
    expect(underChild.affectedNotes.map((note: Note) => note.id)).toEqual([movingId]);

    const underRoot = moveData(
      await harness.command(NOTES_COMMAND_IDS.move, {
        id: childId,
        expectedVersion: 1,
        parentId: rootId,
      }),
    );

    expect(underRoot.note).toMatchObject({ id: childId, parentId: rootId, position: 0 });

    const cycle = await harness.command(NOTES_COMMAND_IDS.move, {
      id: rootId,
      expectedVersion: 1,
      parentId: movingId,
    });

    expect(cycle.ok).toBe(false);
    if (!cycle.ok) {
      expect(cycle.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("повторяет результат по Idempotency-Key без мутации, события и индекса", async () => {
    const harness = await startHarness();
    const input = { title: "Идемпотентная", contentMarkdown: "Текст" };

    const first = await createNote(harness, input, { idempotencyKey: "notes-key" });
    const eventsAfterFirst = harness.events.filter(
      (event) => event.type === NOTES_EVENT_TYPES.created,
    ).length;

    const second = await createNote(harness, input, { idempotencyKey: "notes-key" });
    const eventsAfterSecond = harness.events.filter(
      (event) => event.type === NOTES_EVENT_TYPES.created,
    ).length;

    expect(second).toEqual(first);
    expect(eventsAfterFirst).toBe(1);
    expect(eventsAfterSecond).toBe(1);
    expect(
      expectOk<{ readonly total: number }>(await harness.query(NOTES_QUERY_IDS.list, {})).total,
    ).toBe(1);

    const conflict = await harness.command(
      NOTES_COMMAND_IDS.create,
      { title: "Другой ввод" },
      { idempotencyKey: "notes-key" },
    );

    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }

    const otherOperation = await harness.command(
      NOTES_COMMAND_IDS.favoriteSet,
      { id: first.view.note.id, favorite: true },
      { idempotencyKey: "notes-key" },
    );

    expect(otherOperation.ok).toBe(false);
    if (!otherOperation.ok) {
      expect(otherOperation.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("откатывает доменную мутацию, если запись idempotency не удалась", async () => {
    const harness = await startHarness({ decorateProvider: failIdempotencyWrites });
    const result = await harness.command(
      NOTES_COMMAND_IDS.create,
      { title: "Откат" },
      { idempotencyKey: "rollback-key" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }

    expect(
      expectOk<{ readonly total: number }>(await harness.query(NOTES_QUERY_IDS.list, {})).total,
    ).toBe(0);
    expect(
      await harness.provider.documents.list(NOTES_PLUGIN_ID, NOTES_IDEMPOTENCY_COLLECTION),
    ).toEqual([]);
  });

  it("публикует событие после коммита и не ломает команду сбоем подписчика", async () => {
    const harness = await startHarness();
    const observations: Array<{ readonly found: boolean; readonly version: number | null }> = [];

    const unsubscribe = harness.composition.events.subscribe(
      NOTES_EVENT_TYPES.created,
      async (envelope) => {
        const noteId = (envelope.payload as { readonly noteId?: unknown }).noteId;
        const result = await harness.query<NoteDetails>(NOTES_QUERY_IDS.get, { id: noteId });

        observations.push({
          found: result.ok,
          version: result.ok ? result.data.view.note.version : null,
        });
      },
      { pluginId: "kanbaner.notes-test" },
    );

    try {
      await createNote(harness, { title: "После коммита" });
    } finally {
      unsubscribe();
    }

    expect(observations).toEqual([{ found: true, version: 1 }]);

    harness.composition.events.publishAfterCommit = async () => {
      throw new Error("injected event publish failure");
    };

    const stillCreated = await createNote(harness, { title: "Сбой шины" });

    expect(stillCreated.view.note.version).toBe(1);
  });

  it("индексирует кириллицу и находит заметку через query search", async () => {
    const harness = await startHarness();

    await createNote(harness, {
      title: "Ёлка и задача",
      contentMarkdown: "Полнотекстовый поиск работает на кириллице",
    });

    const found = await waitFor(async () => {
      const result = await harness.query<{
        readonly items: readonly { readonly noteId: string }[];
      }>(NOTES_QUERY_IDS.search, { text: "кириллице" });

      return result.ok && result.data.items.length > 0 ? result.data : null;
    });

    expect(found.items).toHaveLength(1);

    const byTitle = expectOk<{ readonly items: readonly { readonly noteId: string }[] }>(
      await harness.query(NOTES_QUERY_IDS.search, { text: "Ёлка" }),
    );

    expect(byTitle.items).toHaveLength(1);
  });

  it("строит полную переиндексацию заметок при активации", async () => {
    const provider = new InMemoryStorageProvider({
      backendId: `notes-reindex-${globalThis.crypto.randomUUID()}`,
    });

    await provider.open();
    await provider.documents.put({
      pluginId: NOTES_PLUGIN_ID,
      collection: NOTE_COLLECTION,
      id: "note-seeded",
      data: {
        id: "note-seeded",
        title: "Старая заметка",
        contentMarkdown: "Материал для переиндексации",
        parentId: null,
        position: 0,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      indexedFields: { parentId: null, updatedAt: "2026-01-01T00:00:00.000Z" },
      expectedVersion: 0,
    });

    const harness = await startHarness({ provider });
    const found = expectOk<{ readonly items: readonly { readonly noteId: string }[] }>(
      await harness.query(NOTES_QUERY_IDS.search, { text: "переиндексации" }),
    );

    expect(found.items.map((item) => item.noteId)).toEqual(["note-seeded"]);
  });

  it("связывает заметку с любым ResourceRef и очищает связи при удалении", async () => {
    const harness = await startHarness();
    const created = await createNote(harness, { title: "Связи" });
    const noteId = created.view.note.id;
    const noteRef = formatNoteRef(noteId);
    const targetRef = "kanbaner.tasks:task:task-1";

    const linked = expectOk<{
      readonly link: { readonly sourceRef: string; readonly targetRef: string };
      readonly source: { readonly title?: string } | null;
      readonly target: unknown;
    }>(
      await harness.command(NOTES_COMMAND_IDS.link, {
        noteId,
        targetRef,
      }),
    );

    expect(linked.link).toMatchObject({ sourceRef: noteRef, targetRef });
    expect(linked.source).not.toBeNull();
    expect(linked.target).toBeNull();

    const links = expectOk<{ readonly items: readonly unknown[] }>(
      await harness.query(NOTES_QUERY_IDS.links, { ref: noteRef }),
    );

    expect(links.items).toHaveLength(1);
    expect(await harness.composition.links.list(noteRef, NOTES_RELATION)).toHaveLength(1);

    const deleted = expectOk<NoteDeleteResult>(
      await harness.command(NOTES_COMMAND_IDS.delete, {
        id: noteId,
        expectedVersion: 1,
        confirm: true,
      }),
    );

    expect(deleted.deleted).toBe(true);

    await waitFor(async () => {
      const remaining = await harness.composition.links.list(noteRef, NOTES_RELATION);
      const documents = await harness.composition.search.list(NOTES_PLUGIN_ID);

      return remaining.length === 0 && documents.length === 0 ? true : null;
    });
  });

  it("сохраняет вложение и возвращает самодостаточный Markdown", async () => {
    const harness = await startHarness();
    const created = await createNote(harness, { title: "Экспорт" });
    const noteId = created.view.note.id;

    const attachment = expectOk<{
      readonly attachment: { readonly id: string; readonly mimeType: string };
    }>(
      await harness.command(NOTES_COMMAND_IDS.attachmentCreate, {
        noteId,
        mimeType: "image/png",
        contentBase64: PNG_BASE64,
      }),
    );

    const attachmentId = attachment.attachment.id;

    const withImage = expectOk<NoteDetails>(
      await harness.command(NOTES_COMMAND_IDS.update, {
        id: noteId,
        expectedVersion: 1,
        contentMarkdown: `![Точка](attachment://${attachmentId})`,
      }),
    );

    expect(withImage.attachments.map((descriptor) => descriptor.id)).toEqual([attachmentId]);

    const stored = expectOk<{
      readonly attachment: { readonly contentBase64: string; readonly mimeType: string };
    }>(await harness.query(NOTES_QUERY_IDS.attachmentGet, { id: attachmentId }));

    expect(stored.attachment.contentBase64).toBe(PNG_BASE64);

    const exported = expectOk<{
      readonly fileName: string;
      readonly mediaType: string;
      readonly content: string;
    }>(await harness.query(NOTES_QUERY_IDS.export, { id: noteId }));

    expect(exported.fileName).toBe("Экспорт.md");
    expect(exported.mediaType).toBe("text/markdown");
    expect(exported.content).toContain(`data:image/png;base64,${PNG_BASE64}`);

    const inUse = await harness.command(NOTES_COMMAND_IDS.attachmentDelete, {
      id: attachmentId,
      confirm: true,
    });

    expect(inUse.ok).toBe(false);
    if (!inUse.ok) {
      expect(inUse.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

/**
 * Провайдер-обёртка, который падает на записи коллекции `idempotency`.
 *
 * Доменная мутация успевает выполниться внутри транзакции, но rejected
 * Promise откатывает её, а запись идемпотентности не остаётся.
 */
function failIdempotencyWrites(provider: StorageProvider): StorageProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "withTransaction") {
        return async (callback: Parameters<StorageProvider["withTransaction"]>[0]) =>
          target.withTransaction(async (transaction) =>
            callback({
              ...transaction,
              documents: new Proxy(transaction.documents, {
                get(documents, documentProperty, documentsReceiver) {
                  if (documentProperty === "put") {
                    return async (input: Parameters<typeof transaction.documents.put>[0]) => {
                      if (input.collection === NOTES_IDEMPOTENCY_COLLECTION) {
                        throw new Error("injected idempotency write failure");
                      }

                      return transaction.documents.put(input);
                    };
                  }

                  const value = Reflect.get(documents, documentProperty, documentsReceiver);

                  return typeof value === "function" ? value.bind(documents) : value;
                },
              }),
            }),
          );
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
