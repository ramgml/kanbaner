import {
  formatResourceRef,
  isPluginId,
  isResourceType,
  parseResourceRef,
  toSearchDocument,
  type CommandMetadata,
  type EventEnvelope,
  type ExecutionContext,
  type JsonValue,
  type OperationResult,
  type PluginActivationServices,
  type PluginDocument,
  type PluginDocumentStore,
  type QueryMetadata,
  type ResourceDescriptor,
  type ResourceRef,
  type SearchDocumentInput,
  type UiContribution,
} from "@kanbaner/plugin-sdk";

export const FIXTURE_PLUGIN_ID = "kanbaner.fixture";
export const FIXTURE_ITEM_TYPE = "item";
export const FIXTURE_COLLECTION = "items";
export const FIXTURE_AUDIT_COLLECTION = "audit";

export const FIXTURE_EVENT_CREATED = "kanbaner.fixture.item.created";
export const FIXTURE_EVENT_DELETED = "kanbaner.fixture.item.deleted";
export const FIXTURE_COMMAND_CREATE = "kanbaner.fixture.item.create";
export const FIXTURE_COMMAND_DELETE = "kanbaner.fixture.item.delete";
export const FIXTURE_COMMAND_REINDEX = "kanbaner.fixture.item.reindex";
export const FIXTURE_QUERY_LIST = "kanbaner.fixture.item.list";
export const FIXTURE_QUERY_SEARCH = "kanbaner.fixture.item.search";

const DEFAULT_TITLE = "Fixture item";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const itemInputSchema: CommandMetadata["inputSchema"] = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const deleteInputSchema: CommandMetadata["inputSchema"] = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
  },
  required: ["id"],
  additionalProperties: false,
};

const emptyInputSchema: QueryMetadata["inputSchema"] = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const listInputSchema: QueryMetadata["inputSchema"] = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    offset: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const searchInputSchema: QueryMetadata["inputSchema"] = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    offset: { type: "integer", minimum: 0 },
  },
  required: ["text"],
  additionalProperties: false,
};

const itemOutputSchema: CommandMetadata["outputSchema"] = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    resource: { type: "string" },
    eventId: { type: "string" },
  },
  required: ["id", "title", "resource", "eventId"],
  additionalProperties: false,
};

const deleteOutputSchema: CommandMetadata["outputSchema"] = {
  type: "object",
  properties: {
    deleted: { type: "boolean" },
  },
  required: ["deleted"],
  additionalProperties: false,
};

const reindexOutputSchema: CommandMetadata["outputSchema"] = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
  },
  required: ["count"],
  additionalProperties: false,
};

const listOutputSchema: QueryMetadata["outputSchema"] = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          createdAt: { type: "string" },
        },
        required: ["id", "title", "createdAt"],
        additionalProperties: false,
      },
    },
    total: { type: "integer", minimum: 0 },
    nextOffset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  },
  required: ["items", "total", "nextOffset"],
  additionalProperties: false,
};

const searchOutputSchema: QueryMetadata["outputSchema"] = {
  type: "object",
  properties: {
    hits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          title: { type: "string" },
          excerpt: { type: "string" },
          score: { type: "number" },
          strategy: { type: "string" },
        },
        required: ["ref", "title", "excerpt", "score", "strategy"],
        additionalProperties: false,
      },
    },
  },
  required: ["hits"],
  additionalProperties: false,
};

interface FixtureActivationContext extends PluginActivationServices {
  readonly pluginId: string;
}

interface ItemView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

function titleFrom(input: unknown): string {
  if (typeof input !== "object" || input === null || !("title" in input)) {
    return DEFAULT_TITLE;
  }

  const title = (input as { readonly title?: unknown }).title;

  return typeof title === "string" && title.trim().length > 0 ? title.trim() : DEFAULT_TITLE;
}

function idFrom(input: unknown): string {
  if (typeof input !== "object" || input === null || !("id" in input)) {
    throw new TypeError("Fixture delete требует id");
  }

  const id = (input as { readonly id?: unknown }).id;

  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Fixture delete требует непустой id");
  }

  return id;
}

function paginationFrom(input: unknown): { readonly limit: number; readonly offset: number } {
  if (typeof input !== "object" || input === null) {
    return { limit: DEFAULT_LIMIT, offset: 0 };
  }

  const record = input as { readonly limit?: unknown; readonly offset?: unknown };
  const limit =
    typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0
      ? Math.min(record.limit, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offset =
    typeof record.offset === "number" && Number.isInteger(record.offset) && record.offset >= 0
      ? record.offset
      : 0;

  return { limit, offset };
}

function searchTextFrom(input: unknown): string {
  if (typeof input !== "object" || input === null || !("text" in input)) {
    throw new TypeError("Fixture search требует text");
  }

  const text = (input as { readonly text?: unknown }).text;

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new TypeError("Fixture search требует непустой text");
  }

  return text.trim();
}

function itemView(document: PluginDocument): ItemView {
  const data = document.data;

  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as {
      readonly title?: unknown;
      readonly createdAt?: unknown;
    };

    return {
      id: document.id,
      title: typeof record.title === "string" ? record.title : DEFAULT_TITLE,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : document.createdAt,
    };
  }

  return { id: document.id, title: DEFAULT_TITLE, createdAt: document.createdAt };
}

function resourceOf(id: string): ResourceRef {
  return formatResourceRef({
    pluginId: FIXTURE_PLUGIN_ID,
    resourceType: FIXTURE_ITEM_TYPE,
    opaqueId: id,
  });
}

function searchDocumentOf(view: ItemView): SearchDocumentInput {
  return toSearchDocument(FIXTURE_PLUGIN_ID, {
    ref: resourceOf(view.id),
    title: view.title,
    text: view.title,
    kind: FIXTURE_ITEM_TYPE,
    updatedAt: view.createdAt,
  });
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
}

function isStorageErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function recordAudit(documents: PluginDocumentStore, envelope: EventEnvelope): Promise<void> {
  const id = `audit-${envelope.eventId}`;
  const existing = await documents.get(FIXTURE_PLUGIN_ID, FIXTURE_AUDIT_COLLECTION, id);

  if (existing !== null) {
    return;
  }

  try {
    await documents.put({
      pluginId: FIXTURE_PLUGIN_ID,
      collection: FIXTURE_AUDIT_COLLECTION,
      id,
      data: {
        eventId: envelope.eventId,
        resource: envelope.resource,
        occurredAt: envelope.occurredAt,
      },
      expectedVersion: 0,
    });
  } catch (error) {
    // Повторная обработка того же события не создаёт дубль.
    if (!isStorageErrorCode(error, "VERSION_CONFLICT")) {
      throw error;
    }
  }
}

/**
 * Метаданные fixture-операции.
 *
 * `exposure.ui` включается явно только у операций, которые реально вызывает
 * UI-вклад (`item.create` и `item.list`). Остальные операции остаются
 * default-off по всем каналам, как требует Plugin Contract.
 */
function commandMetadata(
  id: string,
  inputSchema: CommandMetadata["inputSchema"],
  outputSchema: CommandMetadata["outputSchema"],
  description: string,
  exposureUi = false,
): CommandMetadata {
  return {
    id,
    contract: "kanbaner.fixture.commands.v1",
    version: 1,
    kind: "mutation",
    risk: id === FIXTURE_COMMAND_DELETE ? "destructive" : "write",
    idempotency: "none",
    exposure: { ui: exposureUi, http: false, mcp: false },
    inputSchema,
    outputSchema,
    description,
  };
}

function queryMetadata(
  id: string,
  inputSchema: QueryMetadata["inputSchema"],
  outputSchema: QueryMetadata["outputSchema"],
  description: string,
  exposureUi = false,
): QueryMetadata {
  return {
    id,
    contract: "kanbaner.fixture.queries.v1",
    version: 1,
    kind: "query",
    risk: "read",
    exposure: { ui: exposureUi, http: false, mcp: false },
    inputSchema,
    outputSchema,
    description,
  };
}

export const fixtureUiContributions: readonly UiContribution[] = [
  {
    id: "kanbaner.fixture.panel",
    slot: "app.main",
    kind: "panel",
    priority: 40,
    title: "Contract fixture",
    description: "Команда fixture-плагина выполнена через общий OperationBus.",
    commandId: FIXTURE_COMMAND_CREATE,
  },
  {
    id: "kanbaner.fixture.list-panel",
    slot: "app.main",
    kind: "panel",
    priority: 30,
    title: "Fixture items",
    description: "Запрос fixture-плагина выполнены через общий OperationBus.",
    commandId: FIXTURE_QUERY_LIST,
  },
];

/**
 * Реальная активация fixture-плагина.
 *
 * Использует только публичный SDK: bound storage/search, регистраторы и
 * события приходят из composition root. SQL, драйвер БД и kernel-модули не
 * импортируются; все операции хранилища асинхронны.
 */
export async function activate(context: FixtureActivationContext): Promise<void> {
  if (context.pluginId !== FIXTURE_PLUGIN_ID) {
    throw new Error("Fixture activation context получил другой Plugin ID");
  }

  const storage = context.storage;

  context.commands.register({
    metadata: commandMetadata(
      FIXTURE_COMMAND_CREATE,
      itemInputSchema,
      itemOutputSchema,
      "Создаёт fixture-элемент в транзакции и публикует событие после коммита",
      true,
    ),
    async handler(input, executionContext: ExecutionContext) {
      const title = titleFrom(input);
      const id = `item-${globalThis.crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      const resource = resourceOf(id);

      // Документ и audit пишутся в одной транзакции плагина. Событие не
      // публикуется, пока транзакция не завершилась успешно.
      await storage.withTransaction(async (transaction) => {
        await transaction.documents.put({
          pluginId: FIXTURE_PLUGIN_ID,
          collection: FIXTURE_COLLECTION,
          id,
          data: { title, createdAt },
          indexedFields: { title },
          expectedVersion: 0,
        });
      });

      try {
        await context.search.upsert([searchDocumentOf({ id, title, createdAt })]);
      } catch (error) {
        executionContext.logger.warn("fixture.search_upsert_failed", {
          eventId: null,
          errorName: safeErrorName(error),
        });
      }

      // Публикация best-effort: ошибка шины не откатывает уже зафиксированные
      // данные и не превращает успешную команду в INTERNAL_ERROR.
      const eventId = globalThis.crypto.randomUUID();

      try {
        const publish = await executionContext.events.publishAfterCommit(
          {
            eventId,
            type: FIXTURE_EVENT_CREATED,
            contractVersion: 1,
            source: FIXTURE_PLUGIN_ID,
            occurredAt: new Date().toISOString(),
            resource,
            resourceVersion: 1,
            payload: { itemId: id, title },
          },
          { traceId: executionContext.traceId },
        );

        if (publish.status === "invalid") {
          executionContext.logger.warn("fixture.event_rejected", { eventId });
        }
      } catch (error) {
        executionContext.logger.warn("fixture.event_publish_failed", {
          eventId,
          errorName: safeErrorName(error),
        });
      }

      return { id, title, resource, eventId };
    },
  });

  context.commands.register({
    metadata: commandMetadata(
      FIXTURE_COMMAND_DELETE,
      deleteInputSchema,
      deleteOutputSchema,
      "Удаляет fixture-элемент и публикует deleted после коммита",
    ),
    async handler(input, executionContext: ExecutionContext) {
      const id = idFrom(input);
      const resource = resourceOf(id);

      const deleted = await storage.withTransaction(async (transaction) => {
        const current = await transaction.documents.get(FIXTURE_PLUGIN_ID, FIXTURE_COLLECTION, id);

        if (current === null) {
          return null;
        }

        const removed = await transaction.documents.delete(
          FIXTURE_PLUGIN_ID,
          FIXTURE_COLLECTION,
          id,
          { expectedVersion: current.version },
        );

        if (!removed) {
          throw new Error("Fixture delete не изменил документ");
        }

        return current;
      });

      if (deleted === null) {
        return { deleted: false };
      }

      // Поисковый индекс удаляется host-сервисом по владельцу ResourceRef.
      // Cleanup события идемпотентно повторит удаление.
      try {
        await context.search.delete(resource);
      } catch (error) {
        executionContext.logger.warn("fixture.search_delete_failed", {
          errorName: safeErrorName(error),
        });
      }

      const eventId = globalThis.crypto.randomUUID();

      try {
        const publish = await executionContext.events.publishAfterCommit(
          {
            eventId,
            type: FIXTURE_EVENT_DELETED,
            contractVersion: 1,
            source: FIXTURE_PLUGIN_ID,
            occurredAt: new Date().toISOString(),
            resource,
            resourceVersion: deleted.version + 1,
            payload: { itemId: id },
          },
          { traceId: executionContext.traceId },
        );

        if (publish.status === "invalid") {
          executionContext.logger.warn("fixture.event_rejected", { eventId });
        }
      } catch (error) {
        executionContext.logger.warn("fixture.event_publish_failed", {
          eventId,
          errorName: safeErrorName(error),
        });
      }

      return { deleted: true };
    },
  });

  context.commands.register({
    metadata: commandMetadata(
      FIXTURE_COMMAND_REINDEX,
      emptyInputSchema,
      reindexOutputSchema,
      "Полностью переиндексирует документы fixture-плагина",
    ),
    async handler() {
      const documents = await storage.documents.list(FIXTURE_PLUGIN_ID, FIXTURE_COLLECTION);
      const count = await context.search.reindex(documents.map(itemView).map(searchDocumentOf));

      return { count };
    },
  });

  context.queries.register({
    metadata: queryMetadata(
      FIXTURE_QUERY_LIST,
      listInputSchema,
      listOutputSchema,
      "Возвращает fixture-элементы стабильными страницами",
      true,
    ),
    async handler(input) {
      const { limit, offset } = paginationFrom(input);
      const documents = await storage.documents.query({
        pluginId: FIXTURE_PLUGIN_ID,
        collection: FIXTURE_COLLECTION,
      });
      const sorted = [...documents].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
      const page = sorted.slice(offset, offset + limit);
      const nextOffset = offset + page.length < sorted.length ? offset + page.length : null;

      return { items: page.map(itemView), total: sorted.length, nextOffset };
    },
  });

  context.queries.register({
    metadata: queryMetadata(
      FIXTURE_QUERY_SEARCH,
      searchInputSchema,
      searchOutputSchema,
      "Ищет только документы fixture-плагина в публичном индексе",
    ),
    async handler(input) {
      const text = searchTextFrom(input);
      const { limit, offset } = paginationFrom(input);
      const hits = await context.search.search({ text, limit, offset });

      return {
        hits: hits.map((hit) => ({
          ref: hit.ref,
          title: hit.title,
          excerpt: hit.excerpt,
          score: hit.score,
          strategy: hit.strategy,
        })),
      };
    },
  });

  context.resourceTypes.register({
    resourceTypes: [FIXTURE_ITEM_TYPE],
    adapter: {
      async resolve(ref: ResourceRef): Promise<ResourceDescriptor | null> {
        const parts = parseResourceRef(ref);

        if (
          parts.pluginId !== FIXTURE_PLUGIN_ID ||
          parts.resourceType !== FIXTURE_ITEM_TYPE ||
          !isPluginId(parts.pluginId) ||
          !isResourceType(parts.resourceType)
        ) {
          return null;
        }

        const document = await storage.documents.get(
          FIXTURE_PLUGIN_ID,
          FIXTURE_COLLECTION,
          parts.opaqueId,
        );

        return document === null
          ? null
          : {
              ref,
              resourceType: FIXTURE_ITEM_TYPE,
              title: itemView(document).title,
              state: "open",
              metadata: { collection: FIXTURE_COLLECTION },
            };
      },
      canOpen(): boolean {
        return true;
      },
      open(): void {
        // Открытие выполняет UI-shell по ResourceRef; DOM плагина не нужен.
      },
    },
  });

  // Подписка принадлежит activation tracker и снимается runtime-ом при stop.
  context.events.subscribe(FIXTURE_EVENT_CREATED, async (envelope) => {
    await recordAudit(storage.documents, envelope);
  });

  context.ui.register(fixtureUiContributions);
}

/** Данные не удаляются при деактивации; runtime снимает регистрации сам. */
export async function deactivate(): Promise<void> {
  // Намеренно пусто: отключение плагина сохраняет данные.
}

/** Типизированный результат list для внешних проверок. */
export interface FixtureListResult {
  readonly items: readonly ItemView[];
}

export type FixtureOperationResult<T> = OperationResult<T>;

export function isFixtureDocumentJson(value: JsonValue): boolean {
  return typeof value === "object" && value !== null;
}
