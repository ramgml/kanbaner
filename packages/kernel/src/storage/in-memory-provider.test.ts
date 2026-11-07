import { describe, expect, it } from "vitest";

import type { LinkStore as ResourceLinkStorePort } from "../resources/link-store.ts";
import type { StorageCapabilities } from "./contracts.ts";
import { InMemoryStorageProvider } from "./in-memory-provider.ts";

const NOW = () => new Date("2026-11-06T12:00:00.000Z");
const PLUGIN = "acme.widgets";
const COLLECTION = "widgets";
const DOC_ID = "01JDOC00000000000000000001";
const SOURCE = "acme.widgets:widget:01JWIDGET0000000000000001";
const TARGET = "acme.gadgets:gadget:01JGADGET0000000000000001";
const RELATION = "acme.links.relates";

function provider(
  options: {
    readonly backendId?: string;
    readonly capabilities?: Partial<StorageCapabilities>;
    readonly operationMs?: number;
    readonly transactionMs?: number;
  } = {},
): InMemoryStorageProvider {
  return new InMemoryStorageProvider({
    backendId: options.backendId ?? "memory-test",
    now: NOW,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.operationMs === undefined && options.transactionMs === undefined
      ? {}
      : {
          delays: {
            ...(options.operationMs === undefined ? {} : { operationMs: options.operationMs }),
            ...(options.transactionMs === undefined
              ? {}
              : { transactionMs: options.transactionMs }),
          },
        }),
  });
}

async function expectCode(work: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(code);

    return;
  }

  throw new Error(`Ожидалась ошибка ${code}`);
}

function doc(id = DOC_ID) {
  return {
    pluginId: PLUGIN,
    collection: COLLECTION,
    id,
    data: { title: "Widget" },
    expectedVersion: 0,
  } as const;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

describe("InMemoryStorageProvider", () => {
  it("совместим с портом LinkStore из KAN-005", () => {
    const memory = provider();
    const port: ResourceLinkStorePort = memory.links;

    expect(typeof port.add).toBe("function");
  });

  it("не разделяет состояние между экземплярами", async () => {
    const first = provider();
    const second = provider();

    await first.open();
    await second.open();

    try {
      await first.documents.put(doc());

      expect(await second.documents.get(PLUGIN, COLLECTION, DOC_ID)).toBeNull();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("требует открытия провайдера", async () => {
    const memory = provider();

    await expectCode(memory.documents.list(PLUGIN), "PROVIDER_CLOSED");
    await expectCode(
      memory.withTransaction(async () => undefined),
      "PROVIDER_CLOSED",
    );

    await memory.open();
    await memory.open();
    expect((await memory.healthCheck()).ok).toBe(true);
    await memory.close();
    await memory.close();
  });

  it("сохраняет документ с версией, app ID и UTC временем", async () => {
    const memory = provider();

    await memory.open();

    try {
      const created = await memory.documents.put({
        ...doc(),
        indexedFields: { status: "open" },
      });

      expect(created).toEqual({
        pluginId: PLUGIN,
        collection: COLLECTION,
        id: DOC_ID,
        version: 1,
        data: { title: "Widget" },
        indexedFields: { status: "open" },
        createdAt: "2026-11-06T12:00:00.000Z",
        updatedAt: "2026-11-06T12:00:00.000Z",
      });

      const updated = await memory.documents.put({
        pluginId: PLUGIN,
        collection: COLLECTION,
        id: DOC_ID,
        data: { title: "Updated" },
        expectedVersion: 1,
      });

      expect(updated.version).toBe(2);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBe("2026-11-06T12:00:00.000Z");
      expect(updated.data).toEqual({ title: "Updated" });
    } finally {
      await memory.close();
    }
  });

  it("не перезаписывает документ при конфликте версий", async () => {
    const memory = provider();

    await memory.open();

    try {
      await memory.documents.put(doc());

      await expectCode(
        memory.documents.put({
          pluginId: PLUGIN,
          collection: COLLECTION,
          id: DOC_ID,
          data: { title: "Broken" },
        }),
        "VERSION_CONFLICT",
      );
      await expectCode(
        memory.documents.put({
          pluginId: PLUGIN,
          collection: COLLECTION,
          id: DOC_ID,
          data: { title: "Broken" },
          expectedVersion: 99,
        }),
        "VERSION_CONFLICT",
      );
      await expectCode(
        memory.documents.put({
          pluginId: PLUGIN,
          collection: COLLECTION,
          id: "01JDOC00000000000000000002",
          data: { title: "Missing" },
          expectedVersion: 4,
        }),
        "VERSION_CONFLICT",
      );

      expect((await memory.documents.get(PLUGIN, COLLECTION, DOC_ID))?.data).toEqual({
        title: "Widget",
      });
    } finally {
      await memory.close();
    }
  });

  it("изолирует JSON-данные от внешней мутации", async () => {
    const memory = provider();
    const data = { nested: { value: 1 } };

    await memory.open();

    try {
      const created = await memory.documents.put({
        pluginId: PLUGIN,
        collection: COLLECTION,
        id: DOC_ID,
        data,
        expectedVersion: 0,
      });

      data.nested.value = 2;
      (created.data as { nested: { value: number } }).nested.value = 3;

      expect((await memory.documents.get(PLUGIN, COLLECTION, DOC_ID))?.data).toEqual({
        nested: { value: 1 },
      });
    } finally {
      await memory.close();
    }
  });

  it("фильтрует и сортирует query, проверяет app-generated ID", async () => {
    const memory = provider();

    await memory.open();

    try {
      for (const id of ["01JDOC00000000000000000003", "01JDOC00000000000000000001"]) {
        await memory.documents.put({
          pluginId: PLUGIN,
          collection: COLLECTION,
          id,
          data: { title: id },
          indexedFields: { status: id.endsWith("1") ? "open" : "closed" },
          expectedVersion: 0,
        });
      }

      const page = await memory.documents.query({
        pluginId: PLUGIN,
        indexedFields: { status: "open" },
        sort: { field: "id", direction: "desc" },
        limit: 1,
      });

      expect(page.map((document) => document.id)).toEqual(["01JDOC00000000000000000001"]);
      await expectCode(
        memory.documents.put({
          pluginId: PLUGIN,
          collection: COLLECTION,
          id: "",
          data: null,
          expectedVersion: 0,
        }),
        "INVALID_ARGUMENT",
      );
    } finally {
      await memory.close();
    }
  });

  it("создаёт одну связь при конкурентном add и очищает обе стороны", async () => {
    const memory = provider();

    await memory.open();

    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          memory.links.add({
            sourceRef: SOURCE,
            targetRef: TARGET,
            relation: RELATION,
            createdAt: "2026-11-06T12:00:00.000Z",
          }),
        ),
      );

      expect(results.filter((result) => result.inserted)).toHaveLength(1);
      expect((await memory.links.listByRef(SOURCE)).length).toBe(1);
      expect((await memory.links.listByRef(TARGET)).length).toBe(1);

      expect(await memory.links.deleteByRef(SOURCE)).toBe(1);
      expect(await memory.links.listByRef(TARGET)).toEqual([]);
    } finally {
      await memory.close();
    }
  });

  it("сохраняет состояние плагина независимо от отключения", async () => {
    const memory = provider();

    await memory.open();

    try {
      await memory.pluginStates.put({
        pluginId: PLUGIN,
        version: "1.0.0",
        enabled: true,
        state: { settings: { theme: "dark" } },
      });
      await memory.pluginStates.put({
        pluginId: PLUGIN,
        version: "1.0.0",
        enabled: false,
        state: { settings: { theme: "dark" } },
      });

      const record = await memory.pluginStates.get(PLUGIN);

      expect(record?.enabled).toBe(false);
      expect(record?.updatedAt).toBe("2026-11-06T12:00:00.000Z");
    } finally {
      await memory.close();
    }
  });

  it("использует substring fallback без fullTextSearch", async () => {
    const memory = provider();
    const fullText = provider({
      backendId: "memory-full-text",
      capabilities: { fullTextSearch: true },
    });

    await memory.open();
    await fullText.open();

    try {
      expect(memory.capabilities.fullTextSearch).toBe(false);
      expect(memory.searchIndex.strategy).toBe("substring");
      expect(fullText.searchIndex.strategy).toBe("full-text");

      await memory.searchIndex.upsert([
        {
          ref: SOURCE,
          pluginId: PLUGIN,
          title: "Widget",
          text: "Текст для поиска",
        },
      ]);

      expect((await memory.searchIndex.search({ text: "поиска" })).length).toBe(1);
      expect((await memory.searchIndex.search({ text: "отсутствует" })).length).toBe(0);
      expect((await memory.searchIndex.search({ text: "текст" })).length).toBe(1);
    } finally {
      await memory.close();
      await fullText.close();
    }
  });

  it("коммитит после async callback и откатывает rejected Promise", async () => {
    const memory = provider();

    await memory.open();

    try {
      await memory.withTransaction(async (transaction) => {
        await transaction.documents.put(doc());
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      });

      expect(await memory.documents.get(PLUGIN, COLLECTION, DOC_ID)).not.toBeNull();

      await expect(
        memory.withTransaction(async (transaction) => {
          await transaction.documents.put(doc("01JDOC00000000000000000002"));
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(
        await memory.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000002"),
      ).toBeNull();
    } finally {
      await memory.close();
    }
  });

  it("не пишет после rollback, если операция задержалась дольше callback", async () => {
    const memory = provider({ backendId: "memory-late-tx", operationMs: 5 });

    await memory.open();

    try {
      const original = await memory.documents.put(doc());
      let pending: Promise<unknown> | undefined;

      await expect(
        memory.withTransaction(async (transaction) => {
          pending = transaction.documents.put({
            pluginId: PLUGIN,
            collection: COLLECTION,
            id: DOC_ID,
            data: { title: "Late" },
            expectedVersion: 1,
          });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      const settled = await Promise.allSettled([pending]);

      expect(settled[0]?.status).toBe("rejected");

      if (settled[0]?.status === "rejected") {
        expect((settled[0].reason as { readonly code?: string }).code).toBe("TRANSACTION_CLOSED");
      }

      const document = await memory.documents.get(PLUGIN, COLLECTION, DOC_ID);

      expect(document?.version).toBe(original.version);
      expect(document?.data).toEqual(original.data);
    } finally {
      await memory.close();
    }
  });

  it("не пишет после rollback savepoint, если операция задержалась дольше callback", async () => {
    const memory = provider({ backendId: "memory-late-savepoint", operationMs: 5 });
    const nestedId = "01JDOC00000000000000000002";

    await memory.open();

    try {
      await memory.documents.put(doc());

      await memory.withTransaction(async (transaction) => {
        let pending: Promise<unknown> | undefined;

        await expect(
          transaction.withSavepoint(async (nested) => {
            pending = nested.documents.put(doc(nestedId));
            throw new Error("nested rollback");
          }),
        ).rejects.toThrow("nested rollback");

        const settled = await Promise.allSettled([pending]);

        expect(settled[0]?.status).toBe("rejected");

        if (settled[0]?.status === "rejected") {
          expect((settled[0].reason as { readonly code?: string }).code).toBe("TRANSACTION_CLOSED");
        }

        expect(await transaction.documents.get(PLUGIN, COLLECTION, nestedId)).toBeNull();
      });

      expect(await memory.documents.get(PLUGIN, COLLECTION, nestedId)).toBeNull();
      expect(await memory.documents.get(PLUGIN, COLLECTION, DOC_ID)).not.toBeNull();
    } finally {
      await memory.close();
    }
  });

  it("использует savepoint только при capability", async () => {
    const memory = provider({ backendId: "memory-savepoints" });
    const noSavepoints = provider({
      backendId: "memory-no-savepoints",
      capabilities: { savepoints: false },
    });

    await memory.open();
    await noSavepoints.open();

    try {
      await memory.withTransaction(async (transaction) => {
        await transaction.documents.put(doc());

        await expect(
          transaction.withSavepoint(async (nested) => {
            await nested.documents.put(doc("01JDOC00000000000000000002"));
            throw new Error("nested");
          }),
        ).rejects.toThrow("nested");

        expect(await transaction.documents.get(PLUGIN, COLLECTION, DOC_ID)).not.toBeNull();
        expect(
          await transaction.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000002"),
        ).toBeNull();
      });

      await expectCode(
        noSavepoints.withTransaction(async (transaction) =>
          transaction.withSavepoint(async () => undefined),
        ),
        "SAVEPOINTS_UNSUPPORTED",
      );
    } finally {
      await memory.close();
      await noSavepoints.close();
    }
  });

  it("сериализует операции и транзакции с искусственными задержками", async () => {
    const memory = provider({ backendId: "memory-delayed", operationMs: 2, transactionMs: 3 });

    await memory.open();

    try {
      await memory.documents.put(doc());

      const transactionStarted = deferred();
      const gate = deferred();
      let outsideDone = false;
      const transaction = memory.withTransaction(async (tx) => {
        await tx.documents.put(doc("01JDOC00000000000000000002"));
        transactionStarted.resolve();
        await gate.promise;
      });

      await transactionStarted.promise;

      const outside = memory.documents.list(PLUGIN).then((documents) => {
        outsideDone = true;

        return documents;
      });

      // Пока gate закрыт, операция снаружи не должна начать выполнение.
      await Promise.resolve();
      await Promise.resolve();
      expect(outsideDone).toBe(false);

      gate.resolve();
      await transaction;
      expect((await outside).length).toBe(2);
    } finally {
      await memory.close();
    }
  });
});
