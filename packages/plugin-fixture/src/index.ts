import {
  formatResourceRef,
  isPluginId,
  isResourceType,
  parseResourceRef,
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
  type UiContribution,
} from "@kanbaner/plugin-sdk";

export const FIXTURE_PLUGIN_ID = "kanbaner.fixture";
export const FIXTURE_ITEM_TYPE = "item";
export const FIXTURE_COLLECTION = "items";
export const FIXTURE_AUDIT_COLLECTION = "audit";

export const FIXTURE_EVENT_CREATED = "kanbaner.fixture.item.created";
export const FIXTURE_COMMAND_CREATE = "kanbaner.fixture.item.create";
export const FIXTURE_QUERY_LIST = "kanbaner.fixture.item.list";

const DEFAULT_TITLE = "Fixture item";

const itemInputSchema: CommandMetadata["inputSchema"] = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const emptyInputSchema: QueryMetadata["inputSchema"] = {
  type: "object",
  properties: {},
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
  },
  required: ["items"],
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

function commandMetadata(): CommandMetadata {
  return {
    id: FIXTURE_COMMAND_CREATE,
    contract: "kanbaner.fixture.commands.v1",
    version: 1,
    kind: "mutation",
    risk: "write",
    idempotency: "none",
    exposure: { ui: true, http: false, mcp: false },
    inputSchema: itemInputSchema,
    outputSchema: itemOutputSchema,
    description: "Создаёт fixture-элемент через PluginDocumentStore",
  };
}

function queryMetadata(): QueryMetadata {
  return {
    id: FIXTURE_QUERY_LIST,
    contract: "kanbaner.fixture.queries.v1",
    version: 1,
    kind: "query",
    risk: "read",
    exposure: { ui: true, http: false, mcp: false },
    inputSchema: emptyInputSchema,
    outputSchema: listOutputSchema,
    description: "Возвращает fixture-элементы",
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
 * Использует только публичный SDK: регистраторы, Storage Provider и события
 * приходят из composition root. SQL, драйвер БД и kernel-модули не
 * импортируются; все операции хранилища асинхронны.
 */
export async function activate(context: FixtureActivationContext): Promise<void> {
  if (context.pluginId !== FIXTURE_PLUGIN_ID) {
    throw new Error("Fixture activation context получил другой Plugin ID");
  }

  const documents = context.storage.documents;

  context.commands.register({
    metadata: commandMetadata(),
    async handler(input, executionContext: ExecutionContext) {
      const title = titleFrom(input);
      const id = `item-${globalThis.crypto.randomUUID()}`;
      const createdAt = new Date().toISOString();
      const resource = resourceOf(id);

      await documents.put({
        pluginId: FIXTURE_PLUGIN_ID,
        collection: FIXTURE_COLLECTION,
        id,
        data: { title, createdAt },
        indexedFields: { title },
        expectedVersion: 0,
      });

      // Событие публикуется только после успешного завершения put. Шина
      // считается best-effort и не откатывает уже зафиксированные данные.
      const eventId = globalThis.crypto.randomUUID();
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
        throw new Error("Fixture event не прошёл валидацию контракта");
      }

      return { id, title, resource, eventId };
    },
  });

  context.queries.register({
    metadata: queryMetadata(),
    async handler() {
      const documentsList = await documents.query({
        pluginId: FIXTURE_PLUGIN_ID,
        collection: FIXTURE_COLLECTION,
        sort: { field: "createdAt", direction: "desc" },
      });

      return { items: documentsList.map(itemView) };
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

        const document = await documents.get(FIXTURE_PLUGIN_ID, FIXTURE_COLLECTION, parts.opaqueId);

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

  context.events.subscribe(FIXTURE_EVENT_CREATED, async (envelope) => {
    await recordAudit(documents, envelope);
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
