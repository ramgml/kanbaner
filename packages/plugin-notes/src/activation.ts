import {
  type EventEnvelope,
  type ExecutionContext,
  type JsonValue,
  type PluginActivationServices,
  type PluginId,
  type PluginLogger,
  type PluginSearchService,
  type ResourceDescriptor,
  type ResourceRef,
  type ResourceService,
  type UtcTimestamp,
} from "@kanbaner/plugin-sdk";

import {
  NOTE_DEFAULT_LIST_LIMIT,
  NOTE_MAX_LIST_LIMIT,
  NOTE_RESOURCE_TYPE,
  NOTES_COMMAND_IDS,
  NOTES_PLUGIN_ID,
  NOTES_QUERY_IDS,
  NOTES_RELATION,
} from "./constants.ts";
import {
  noteCreatedEvent,
  noteDeletedEvent,
  noteMovedEvent,
  noteUpdatedEvent,
  publishDomainEvents,
  type DeletedNoteDescriptor,
} from "./activation/events.ts";
import { runMapped } from "./activation/errors.ts";
import {
  checkIdempotency,
  hashIdempotencyInput,
  saveIdempotency,
} from "./activation/idempotency.ts";
import {
  createNotesSearchProvider,
  deleteNoteSearchDocuments,
  upsertNoteSearchDocuments,
} from "./activation/search-index.ts";
import { createSerialQueue } from "./activation/serial-queue.ts";
import { NOTES_COMMAND_LIST, NOTES_QUERY_LIST } from "./operations.ts";
import type {
  Note,
  NoteAttachmentMimeType,
  NoteDeleteResult,
  NoteDetails,
  NoteSearchHit,
  ResolvedNoteLink,
} from "./model.ts";
import { notesUiContributions } from "./metadata.ts";
import { formatNoteRef, tryParseNoteRef } from "./resources.ts";
import type {
  NoteAttachmentCreateInput,
  NoteCreateInput,
  NoteDeleteInput,
  NoteFavoriteInput,
  NoteGetInput,
  NoteLinkInput,
  NoteLinksInput,
  NoteListInput,
  NoteMoveInput,
  NoteSearchInput,
  NoteSubtreeInput,
  NoteUnlinkInput,
  NoteUpdateInput,
  NoteVisitInput,
} from "./schemas.ts";
import {
  NotesNotFoundError,
  NotesValidationError,
  createNotesStore,
  descriptorOf,
  type NotesStore,
  type NotesStoreTransaction,
} from "./store.ts";

/** Структурный логгер runtime ядра без зависимости от его типа. */
interface RuntimeLoggerLike {
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ): void | Promise<void>;
}

/**
 * Публичный контекст активации.
 *
 * Runtime передаёт bound-сервисы `PluginActivationServices` и `pluginId`.
 * `logger` допускает как SDK `PluginLogger`, так и структурный runtime-логгер
 * ядра с методом `log`; активация приводит его к `PluginLogger`.
 */
export interface NotesActivationContext extends PluginActivationServices {
  readonly pluginId: PluginId;
  readonly logger?: PluginLogger | RuntimeLoggerLike;
}

/** Эффекты команды, применяемые только после успешного коммита. */
interface MutationEffects {
  readonly events: readonly EventEnvelope[];
  readonly searchUpserts: readonly Note[];
  readonly searchDeleteRefs: readonly ResourceRef[];
}

interface MutationOutcome<Result> {
  readonly result: Result;
  readonly effects: MutationEffects;
}

/** Результат команды: данные для ответа и события после коммита. */
interface CommandExecution<Result = unknown> {
  readonly result: Result;
  readonly events: readonly EventEnvelope[];
}

interface NotesIdFactory {
  nextNoteId(): string;
  nextAttachmentId(): string;
}

type CommandFn = (
  input: unknown,
  executionContext: ExecutionContext,
  operationId: string,
  dependencies: ActivationDependencies,
) => Promise<CommandExecution>;

type QueryFn = (
  input: unknown,
  executionContext: ExecutionContext,
  dependencies: ActivationDependencies,
) => Promise<unknown>;

interface ActivationDependencies {
  readonly store: NotesStore;
  readonly search: PluginSearchService;
  readonly now: () => UtcTimestamp;
  readonly idFactory: NotesIdFactory;
  readonly logger: PluginLogger;
}

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

function isPluginLogger(logger: PluginLogger | RuntimeLoggerLike): logger is PluginLogger {
  const candidate = logger as Partial<PluginLogger>;

  return (
    typeof candidate.debug === "function" &&
    typeof candidate.info === "function" &&
    typeof candidate.warn === "function" &&
    typeof candidate.error === "function"
  );
}

/** Приводит SDK-логгер или структурный runtime-логгер к `PluginLogger`. */
function normalizeLogger(logger: PluginLogger | RuntimeLoggerLike | undefined): PluginLogger {
  if (logger === undefined) {
    return NOOP_LOGGER;
  }

  if (isPluginLogger(logger)) {
    return logger;
  }

  const runtime = logger;
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    try {
      void Promise.resolve(
        runtime.log(level, message, fields as Readonly<Record<string, JsonValue>> | undefined),
      ).catch(() => {
        // Ошибка логгера не влияет на результат операции.
      });
    } catch {
      // Ошибка логгера не влияет на результат операции.
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

function newEventId(): string {
  return globalThis.crypto.randomUUID();
}

function noEffects(): MutationEffects {
  return { events: [], searchUpserts: [], searchDeleteRefs: [] };
}

function effects(input: Partial<MutationEffects>): MutationEffects {
  return {
    events: input.events ?? [],
    searchUpserts: input.searchUpserts ?? [],
    searchDeleteRefs: input.searchDeleteRefs ?? [],
  };
}

export function changedNoteFields(before: Note, after: Note): readonly string[] {
  const changed: string[] = [];

  if (before.title !== after.title) {
    changed.push("title");
  }

  if (before.contentMarkdown !== after.contentMarkdown) {
    changed.push("contentMarkdown");
  }

  if (before.parentId !== after.parentId) {
    changed.push("parentId");
  }

  if (before.position !== after.position) {
    changed.push("position");
  }

  return changed;
}

/**
 * Выполняет команду с Idempotency-Key и отложенными эффектами.
 *
 * Проверка ключа, доменная мутация и запись успешного результата выполняются
 * в одной транзакции домена. Поисковые эффекты применяются сразу после
 * коммита внутри вызывающей очереди, а события возвращаются вызывающей
 * стороне для публикации после выхода из очереди. Повтор с тем же ключом
 * возвращает сохранённый результат без мутации, событий и повторного
 * индексирования.
 */
async function executeMutation<Result>(
  dependencies: ActivationDependencies,
  executionContext: ExecutionContext,
  operationId: string,
  normalizedInput: unknown,
  work: (transaction: NotesStoreTransaction, now: UtcTimestamp) => Promise<MutationOutcome<Result>>,
): Promise<CommandExecution<Result>> {
  const idempotencyKey = executionContext.idempotencyKey;
  const inputHash = idempotencyKey === undefined ? null : hashIdempotencyInput(normalizedInput);
  const now = dependencies.now();

  const outcome = await dependencies.store.withTransaction(async (transaction) => {
    let expectedVersion = 0;

    if (idempotencyKey !== undefined && inputHash !== null) {
      const check = await checkIdempotency(transaction.documents, {
        operationId,
        idempotencyKey,
        inputHash,
        now,
      });

      if (check.status === "replay") {
        return { replay: true as const, result: check.result as Result };
      }

      expectedVersion = check.expectedVersion;
    }

    const executed = await work(transaction, now);

    if (idempotencyKey !== undefined && inputHash !== null) {
      await saveIdempotency(
        transaction.documents,
        {
          operationId,
          idempotencyKey,
          inputHash,
          result: executed.result as unknown as JsonValue,
          now,
        },
        expectedVersion,
      );
    }

    return { replay: false as const, executed };
  });

  if (outcome.replay) {
    return { result: outcome.result, events: [] };
  }

  await upsertNoteSearchDocuments(
    dependencies.search,
    outcome.executed.effects.searchUpserts,
    dependencies.logger,
  );
  await deleteNoteSearchDocuments(
    dependencies.search,
    outcome.executed.effects.searchDeleteRefs,
    dependencies.logger,
  );

  return {
    result: outcome.executed.result,
    events: outcome.executed.effects.events,
  };
}

/* ------------------------------------------------------------------------- */
/* Команды                                                                    */
/* ------------------------------------------------------------------------- */

const noteCreate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as NoteCreateInput;
  const normalized = {
    parentId: data.parentId ?? null,
    contentMarkdown: data.contentMarkdown ?? "",
    ...(data.title === undefined ? {} : { title: data.title }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const details = await transaction.createNote({
        id: dependencies.idFactory.nextNoteId(),
        parentId: normalized.parentId,
        ...(data.title === undefined ? {} : { title: data.title }),
        contentMarkdown: normalized.contentMarkdown,
        createdAt: now,
      });
      const note = details.view.note;

      return {
        result: details,
        effects: effects({
          events: [noteCreatedEvent(note, newEventId())],
          searchUpserts: [note],
        }),
      };
    },
  );
};

const noteUpdate: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as NoteUpdateInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.contentMarkdown === undefined ? {} : { contentMarkdown: data.contentMarkdown }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getNote(normalized.id);

      if (before === null) {
        throw new NotesNotFoundError("Заметка", normalized.id);
      }

      const details = await transaction.updateNote({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.contentMarkdown === undefined ? {} : { contentMarkdown: data.contentMarkdown }),
        updatedAt: now,
      });
      const changed = changedNoteFields(before.view.note, details.view.note);

      if (changed.length === 0) {
        return { result: details, effects: noEffects() };
      }

      return {
        result: details,
        effects: effects({
          events: [noteUpdatedEvent(details.view.note, changed, newEventId())],
          searchUpserts: [details.view.note],
        }),
      };
    },
  );
};

const noteMove: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as NoteMoveInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    parentId: data.parentId,
    ...(data.position === undefined ? {} : { position: data.position }),
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const before = await transaction.getNote(normalized.id);

      if (before === null) {
        throw new NotesNotFoundError("Заметка", normalized.id);
      }

      const moved = await transaction.moveNote({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        parentId: normalized.parentId,
        ...(data.position === undefined ? {} : { position: data.position }),
        updatedAt: now,
      });

      if (moved.affectedNotes.length === 0) {
        return {
          result: { note: moved.note, affectedNotes: [] },
          effects: noEffects(),
        };
      }

      const eventId = newEventId();
      const events = [
        noteMovedEvent(
          moved.note,
          {
            parentId: before.view.note.parentId,
            position: before.view.note.position,
          },
          eventId,
        ),
        ...moved.affectedNotes
          .filter((note) => note.id !== moved.note.id)
          .map((note) => noteUpdatedEvent(note, ["position"], newEventId())),
      ];

      return {
        result: { note: moved.note, affectedNotes: moved.affectedNotes },
        effects: effects({ events, searchUpserts: moved.affectedNotes }),
      };
    },
  );
};

const noteDelete: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as NoteDeleteInput;
  const normalized = {
    id: data.id,
    expectedVersion: data.expectedVersion,
    ...(data.expectedDescendants === undefined
      ? {}
      : { expectedDescendants: data.expectedDescendants }),
    confirm: true as const,
  };

  return executeMutation<NoteDeleteResult>(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction) => {
      const deletion = await transaction.deleteNote({
        id: normalized.id,
        expectedVersion: normalized.expectedVersion,
        ...(normalized.expectedDescendants === undefined
          ? {}
          : { expectedDescendants: normalized.expectedDescendants }),
        confirm: true,
      });

      if (!deletion.deleted) {
        return { result: { deleted: false as const }, effects: noEffects() };
      }

      const descriptors: DeletedNoteDescriptor[] = deletion.deletedNotes.map((note) => ({
        id: note.id,
        parentId: note.parentId,
        version: note.version,
        eventVersion: note.version + 1,
      }));
      const root =
        descriptors.find((descriptor) => descriptor.id === normalized.id) ?? descriptors[0];

      if (root === undefined) {
        throw new NotesValidationError("Удаление не вернуло заметки", "STORE_VALIDATION");
      }

      const events = [
        noteDeletedEvent(root, descriptors),
        ...descriptors
          .filter((descriptor) => descriptor.id !== root.id)
          .map((descriptor) => noteDeletedEvent(descriptor, [descriptor])),
      ];

      return {
        result: deletion,
        effects: effects({
          events,
          searchDeleteRefs: deletion.deletedResourceRefs,
        }),
      };
    },
  );
};

const noteFavoriteSet: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as NoteFavoriteInput;
  const normalized = { id: data.id, favorite: data.favorite };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const view = await transaction.setFavorite({
        id: normalized.id,
        favorite: normalized.favorite,
        updatedAt: now,
      });

      return { result: { view }, effects: noEffects() };
    },
  );
};

const noteRecordVisit: CommandFn = async (input, executionContext, operationId, dependencies) => {
  const data = input as NoteVisitInput;
  const normalized = { id: data.id };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const view = await transaction.recordVisit({ id: normalized.id, visitedAt: now });

      return { result: { view }, effects: noEffects() };
    },
  );
};

const noteAttachmentCreate: CommandFn = async (
  input,
  executionContext,
  operationId,
  dependencies,
) => {
  const data = input as NoteAttachmentCreateInput;
  const normalized = {
    noteId: data.noteId,
    mimeType: data.mimeType,
    contentBase64: data.contentBase64,
  };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction, now) => {
      const attachment = await transaction.createAttachment({
        id: dependencies.idFactory.nextAttachmentId(),
        noteId: normalized.noteId,
        mimeType: normalized.mimeType as NoteAttachmentMimeType,
        contentBase64: normalized.contentBase64,
        createdAt: now,
      });

      return {
        result: { attachment: descriptorOf(attachment) },
        effects: noEffects(),
      };
    },
  );
};

const noteAttachmentDelete: CommandFn = async (
  input,
  executionContext,
  operationId,
  dependencies,
) => {
  const data = input as { readonly id: string };
  const normalized = { id: data.id, confirm: true as const };

  return executeMutation(
    dependencies,
    executionContext,
    operationId,
    normalized,
    async (transaction) => {
      const deleted = await transaction.deleteAttachment({ id: normalized.id, confirm: true });

      return { result: { deleted }, effects: noEffects() };
    },
  );
};

async function resolveDescriptor(
  resources: ResourceService,
  ref: ResourceRef,
): Promise<ResourceDescriptor | null> {
  try {
    const result = await resources.resolve(ref);

    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

const noteLink: CommandFn = async (input, executionContext, _operationId, dependencies) => {
  const data = input as NoteLinkInput;
  const sourceRef = formatNoteRef(data.noteId);

  return runMapped(async () => {
    const details = await dependencies.store.getNote(data.noteId);

    if (details === null) {
      throw new NotesNotFoundError("Заметка", data.noteId);
    }

    const link = await executionContext.resources.link(sourceRef, data.targetRef, NOTES_RELATION);
    const [source, target] = await Promise.all([
      resolveDescriptor(executionContext.resources, link.sourceRef),
      resolveDescriptor(executionContext.resources, link.targetRef),
    ]);
    const result: ResolvedNoteLink = { link, source, target };

    return { result, events: [] };
  });
};

const noteUnlink: CommandFn = async (input, executionContext, _operationId, dependencies) => {
  const data = input as NoteUnlinkInput;
  const noteRef = formatNoteRef(data.noteId);

  return runMapped(async () => {
    const details = await dependencies.store.getNote(data.noteId);

    if (details === null) {
      throw new NotesNotFoundError("Заметка", data.noteId);
    }

    if (data.sourceRef !== noteRef && data.targetRef !== noteRef) {
      throw new NotesValidationError(
        "Заметка не участвует в указанной связи",
        "NOTE_LINK_PARTICIPANT_REQUIRED",
      );
    }

    const links = await executionContext.resources.list(noteRef, NOTES_RELATION);
    const existed = links.some(
      (link) => link.sourceRef === data.sourceRef && link.targetRef === data.targetRef,
    );
    await executionContext.resources.unlink(data.sourceRef, data.targetRef, NOTES_RELATION);

    return { result: { unlinked: existed }, events: [] };
  });
};

/* ------------------------------------------------------------------------- */
/* Запросы                                                                    */
/* ------------------------------------------------------------------------- */

const noteGet: QueryFn = async (input, _executionContext, dependencies) => {
  const data = input as NoteGetInput;
  const details = await dependencies.store.getNote(data.id);

  if (details === null) {
    throw new NotesNotFoundError("Заметка", data.id);
  }

  return details;
};

const noteSubtree: QueryFn = async (input, _executionContext, dependencies) => {
  const data = input as NoteSubtreeInput;
  const subtree = await dependencies.store.getSubtree(data.id);

  if (subtree === null) {
    throw new NotesNotFoundError("Заметка", data.id);
  }

  return subtree;
};

const noteList: QueryFn = async (input, _executionContext, dependencies) => {
  const data = input as NoteListInput;

  return dependencies.store.listNotes({
    ...(data.parentId === undefined ? {} : { parentId: data.parentId }),
    ...(data.favorite === undefined ? {} : { favorite: data.favorite }),
    ...(data.recent === undefined ? {} : { recent: data.recent }),
    limit: data.limit ?? NOTE_DEFAULT_LIST_LIMIT,
    offset: data.offset ?? 0,
  });
};

const noteSearch: QueryFn = async (input, _executionContext, dependencies) => {
  const data = input as NoteSearchInput;
  const limit = data.limit ?? NOTE_DEFAULT_LIST_LIMIT;
  const offset = data.offset ?? 0;

  if (limit < 1 || limit > NOTE_MAX_LIST_LIMIT || offset < 0) {
    throw new NotesValidationError("Некорректная пагинация", "INVALID_PAGINATION");
  }

  const hits = await dependencies.search.search({ text: data.text, limit, offset });
  const notes = await dependencies.store.listAllNotes();
  const byId = new Map(notes.map((note) => [note.id, note]));
  const items: NoteSearchHit[] = [];

  for (const hit of hits) {
    const noteId = tryParseNoteRef(hit.ref);
    const note = noteId === null ? undefined : byId.get(noteId);

    if (note === undefined) {
      continue;
    }

    items.push({
      ref: hit.ref,
      noteId: note.id,
      title: note.title,
      excerpt: hit.excerpt,
      score: hit.score,
      strategy: hit.strategy,
      parentId: note.parentId,
    });
  }

  return {
    items,
    nextOffset: hits.length === limit ? offset + limit : null,
  };
};

const noteLinks: QueryFn = async (input, executionContext) => {
  const data = input as NoteLinksInput;
  const links = await executionContext.resources.list(data.ref, NOTES_RELATION);
  const items: ResolvedNoteLink[] = await Promise.all(
    [...links]
      .sort(
        (left, right) =>
          left.sourceRef.localeCompare(right.sourceRef) ||
          left.targetRef.localeCompare(right.targetRef),
      )
      .map(async (link) => {
        const [source, target] = await Promise.all([
          resolveDescriptor(executionContext.resources, link.sourceRef),
          resolveDescriptor(executionContext.resources, link.targetRef),
        ]);

        return { link, source, target };
      }),
  );

  return { items };
};

const noteAttachmentGet: QueryFn = async (input, _executionContext, dependencies) => {
  const data = input as { readonly id: string };
  const attachment = await dependencies.store.getAttachment(data.id);

  if (attachment === null) {
    throw new NotesNotFoundError("Вложение", data.id);
  }

  return { attachment };
};

const noteExport: QueryFn = async (input, _executionContext, dependencies) => {
  const data = input as { readonly id: string };
  const exported = await dependencies.store.exportNote(data.id);

  if (exported === null) {
    throw new NotesNotFoundError("Заметка", data.id);
  }

  return exported;
};

/* ------------------------------------------------------------------------- */
/* Активация                                                                  */
/* ------------------------------------------------------------------------- */

const COMMAND_HANDLERS: Readonly<Record<string, CommandFn>> = Object.freeze({
  [NOTES_COMMAND_IDS.create]: noteCreate,
  [NOTES_COMMAND_IDS.update]: noteUpdate,
  [NOTES_COMMAND_IDS.move]: noteMove,
  [NOTES_COMMAND_IDS.delete]: noteDelete,
  [NOTES_COMMAND_IDS.favoriteSet]: noteFavoriteSet,
  [NOTES_COMMAND_IDS.recordVisit]: noteRecordVisit,
  [NOTES_COMMAND_IDS.link]: noteLink,
  [NOTES_COMMAND_IDS.unlink]: noteUnlink,
  [NOTES_COMMAND_IDS.attachmentCreate]: noteAttachmentCreate,
  [NOTES_COMMAND_IDS.attachmentDelete]: noteAttachmentDelete,
});

const QUERY_HANDLERS: Readonly<Record<string, QueryFn>> = Object.freeze({
  [NOTES_QUERY_IDS.get]: noteGet,
  [NOTES_QUERY_IDS.subtree]: noteSubtree,
  [NOTES_QUERY_IDS.list]: noteList,
  [NOTES_QUERY_IDS.search]: noteSearch,
  [NOTES_QUERY_IDS.links]: noteLinks,
  [NOTES_QUERY_IDS.attachmentGet]: noteAttachmentGet,
  [NOTES_QUERY_IDS.export]: noteExport,
});

function noteDescriptor(note: Note, ref: ResourceRef): ResourceDescriptor {
  return {
    ref,
    resourceType: NOTE_RESOURCE_TYPE,
    title: note.title,
    state: "open",
    metadata: {
      version: note.version,
      parentId: note.parentId,
      updatedAt: note.updatedAt,
    },
  };
}

/**
 * Активирует headless-плагин заметок.
 *
 * Использует только публичный контекст активации: bound registrars, storage,
 * search, resources и events. Регистрирует все команды и запросы, тип ресурса
 * `note`, UI-метаданные и запускает best-effort полную переиндексацию.
 */
export async function activate(context: NotesActivationContext): Promise<void> {
  if (context.pluginId !== NOTES_PLUGIN_ID) {
    throw new Error("Активация kanbaner.notes получила другой Plugin ID");
  }

  const logger = normalizeLogger(context.logger);
  const now = (): UtcTimestamp => new Date().toISOString();
  const idFactory: NotesIdFactory = {
    nextNoteId: () => `note-${globalThis.crypto.randomUUID()}`,
    nextAttachmentId: () => `attachment-${globalThis.crypto.randomUUID()}`,
  };
  const store = createNotesStore({ storage: context.storage });
  const serialize = createSerialQueue();
  const dependencies: ActivationDependencies = {
    store,
    search: context.search,
    now,
    idFactory,
    logger,
  };
  const searchProvider = createNotesSearchProvider(store, context.search, logger);
  context.search.registerProvider(searchProvider);

  for (const metadata of NOTES_COMMAND_LIST) {
    const handler = COMMAND_HANDLERS[metadata.id];

    if (handler === undefined) {
      throw new Error(`Нет обработчика команды ${metadata.id}`);
    }

    context.commands.register({
      metadata,
      handler: async (input, executionContext) => {
        // В очереди остаются только доменная транзакция и поисковые эффекты.
        // События публикуются после освобождения очереди, чтобы подписчик мог
        // вызвать следующую команду через общий OperationBus без deadlock.
        const execution = await serialize(() =>
          runMapped(() => handler(input, executionContext, metadata.id, dependencies)),
        );

        await publishDomainEvents(executionContext, execution.events, dependencies.logger);

        return execution.result;
      },
    });
  }

  for (const metadata of NOTES_QUERY_LIST) {
    const handler = QUERY_HANDLERS[metadata.id];

    if (handler === undefined) {
      throw new Error(`Нет обработчика запроса ${metadata.id}`);
    }

    context.queries.register({
      metadata,
      handler: (input, executionContext) =>
        runMapped(() => handler(input, executionContext, dependencies)),
    });
  }

  context.resourceTypes.register({
    resourceTypes: [NOTE_RESOURCE_TYPE],
    adapter: {
      async resolve(ref): Promise<ResourceDescriptor | null> {
        const noteId = tryParseNoteRef(ref);

        if (noteId === null) {
          return null;
        }

        const details: NoteDetails | null = await store.getNote(noteId);

        return details === null ? null : noteDescriptor(details.view.note, ref);
      },
      async canOpen(ref): Promise<boolean> {
        const noteId = tryParseNoteRef(ref);

        return noteId === null ? false : (await store.getNote(noteId)) !== null;
      },
    },
  });

  context.ui.register(notesUiContributions);

  // Полная переиндексация awaited до завершения активации: сразу после
  // старта поиск не должен зависеть от гонки с фоновой задачей. Ошибка
  // индекса логируется и не отменяет активацию.
  try {
    await serialize(() => searchProvider.reindex());
  } catch (error) {
    logger.warn("notes.search_reindex_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function deactivate(): Promise<void> {
  // Намеренно пусто: runtime снимает регистрации и подписки сам.
}
