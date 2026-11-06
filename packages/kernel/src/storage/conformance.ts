import assert from "node:assert/strict";

import { isUtcTimestamp } from "@kanbaner/plugin-sdk";

import { bootstrapStorage } from "./bootstrap.ts";
import type {
  LinkStoreAddResult,
  PluginDocument,
  ResourceLink,
  StorageMigration,
  StorageProvider,
  StorageStoreScope,
} from "./contracts.ts";
import { StorageMigrationRunner } from "./migrations.ts";
import { StorageProviderRegistry } from "./registry.ts";

const PLUGIN = "acme.widgets";
const OTHER_PLUGIN = "acme.gadgets";
const COLLECTION = "widgets";
const DOC_ID = "01JDOC00000000000000000001";
const SOURCE = "acme.widgets:widget:01JWIDGET0000000000000001";
const TARGET = "acme.gadgets:gadget:01JGADGET0000000000000001";
const OTHER = "acme.widgets:widget:01JWIDGET0000000000000002";
const RELATION = "acme.links.relates";
const OTHER_RELATION = "acme.links.mentions";

export interface StorageProviderConformanceOptions {
  /** Создаёт новый провайдер для каждого case; провайдер открывает harness. */
  createProvider(): StorageProvider | Promise<StorageProvider>;
  /** Дополнительный провайдер без capability savepoints. */
  createProviderWithoutSavepoints?(): StorageProvider | Promise<StorageProvider>;
}

export interface StorageProviderConformanceCase {
  readonly name: string;
  run(provider: StorageProvider): Promise<void>;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { readonly code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

async function assertRejectsCode(
  operation: Promise<unknown>,
  expectedCode: string,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert.equal(errorCode(error), expectedCode, message);

    return;
  }

  assert.fail(`${message}: операция не завершилась ошибкой ${expectedCode}`);
}

async function assertRejectsError(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert.equal(error instanceof Error, true, message);

    return;
  }

  assert.fail(`${message}: операция не завершилась ошибкой`);
}

function assertUtc(value: string): void {
  assert.equal(isUtcTimestamp(value), true, `Ожидался UTC timestamp, получено ${value}`);
}

function documentInput(
  id = DOC_ID,
  data: PluginDocument["data"] = { title: "Widget", status: "open" },
) {
  return {
    pluginId: PLUGIN,
    collection: COLLECTION,
    id,
    data,
    indexedFields: { status: "open" },
    expectedVersion: 0,
  } as const;
}

function link(sourceRef = SOURCE, targetRef = TARGET, relation = RELATION): ResourceLink {
  return {
    sourceRef,
    targetRef,
    relation,
    createdAt: "2026-11-06T12:00:00.000Z",
  };
}

export function createStorageProviderConformanceSuite(
  options: StorageProviderConformanceOptions,
): readonly StorageProviderConformanceCase[] {
  const cases: StorageProviderConformanceCase[] = [
    {
      name: "объявляет backendId и capabilities до операции",
      async run(provider) {
        assert.equal(typeof provider.backendId, "string");
        assert.equal(provider.capabilities.transactions, true);
        assert.equal(typeof provider.documents.get, "function");
        assert.equal(typeof provider.links.add, "function");
        assert.equal(typeof provider.pluginStates.get, "function");
        assert.equal(typeof provider.migrations.list, "function");
        assert.equal(typeof provider.searchIndex.search, "function");
      },
    },
    {
      name: "открытие и health check идемпотентны",
      async run(provider) {
        await provider.open();
        const health = await provider.healthCheck();
        assert.equal(health.ok, true);
        assert.equal(health.backendId, provider.backendId);
        assertUtc(health.checkedAt);
      },
    },
    {
      name: "закрытый провайдер отклоняет операции и открывается снова",
      async run(provider) {
        await provider.close();
        await assertRejectsCode(
          provider.documents.list(PLUGIN),
          "PROVIDER_CLOSED",
          "операция закрытого провайдера",
        );
        await provider.close();
        await provider.open();

        const health = await provider.healthCheck();
        assert.equal(health.ok, true);
      },
    },
    {
      name: "публичные операции Store возвращают Promise",
      async run(provider) {
        const operations = [
          provider.documents.list(PLUGIN),
          provider.links.listByRef(SOURCE),
          provider.pluginStates.list(),
          provider.migrations.list(),
          provider.searchIndex.list(),
        ];

        for (const operation of operations) {
          assert.equal(operation instanceof Promise, true);
        }

        await Promise.all(operations);
      },
    },
    {
      name: "документы: create/get/list/query/delete с app-generated ID",
      async run(provider) {
        const created = await provider.documents.put(documentInput());

        assert.equal(created.id, DOC_ID);
        assert.equal(created.version, 1);
        assertUtc(created.createdAt);
        assertUtc(created.updatedAt);
        assert.deepEqual(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), created);
        assert.equal((await provider.documents.list(PLUGIN)).length, 1);
        assert.equal((await provider.documents.list(PLUGIN, COLLECTION)).length, 1);
        assert.equal((await provider.documents.query({ pluginId: PLUGIN })).length, 1);
        assert.equal(
          (
            await provider.documents.query({
              pluginId: PLUGIN,
              indexedFields: { status: "open" },
            })
          ).length,
          1,
        );
        assert.equal(
          (
            await provider.documents.query({
              pluginId: PLUGIN,
              indexedFields: { status: "closed" },
            })
          ).length,
          0,
        );
        assert.equal(await provider.documents.delete(PLUGIN, COLLECTION, DOC_ID), true);
        assert.equal(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
        assert.equal(await provider.documents.delete(PLUGIN, COLLECTION, DOC_ID), false);
      },
    },
    {
      name: "документы: конфликт версий не перезаписывает данные",
      async run(provider) {
        const first = await provider.documents.put(documentInput());

        await assertRejectsCode(
          provider.documents.put({
            pluginId: PLUGIN,
            collection: COLLECTION,
            id: DOC_ID,
            data: { title: "Broken" },
          }),
          "VERSION_CONFLICT",
          "обновление без expectedVersion",
        );
        await assertRejectsCode(
          provider.documents.put({
            pluginId: PLUGIN,
            collection: COLLECTION,
            id: DOC_ID,
            data: { title: "Broken" },
            expectedVersion: 7,
          }),
          "VERSION_CONFLICT",
          "обновление с неверной версией",
        );

        const unchanged = await provider.documents.get(PLUGIN, COLLECTION, DOC_ID);
        assert.deepEqual(unchanged?.data, first.data);
        assert.equal(unchanged?.version, 1);

        const updated = await provider.documents.put({
          pluginId: PLUGIN,
          collection: COLLECTION,
          id: DOC_ID,
          data: { title: "Updated" },
          expectedVersion: 1,
        });

        assert.equal(updated.version, 2);
        assert.equal(updated.createdAt, first.createdAt);
        assert.deepEqual(updated.data, { title: "Updated" });
      },
    },
    {
      name: "документы: expectedVersion проверяется при удалении",
      async run(provider) {
        await provider.documents.put(documentInput());

        await assertRejectsCode(
          provider.documents.delete(PLUGIN, COLLECTION, DOC_ID, { expectedVersion: 2 }),
          "VERSION_CONFLICT",
          "удаление с неверной версией",
        );
        assert.notEqual(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
        assert.equal(
          await provider.documents.delete(PLUGIN, COLLECTION, DOC_ID, { expectedVersion: 1 }),
          true,
        );
      },
    },
    {
      name: "документы: query поддерживает сортировку, offset и limit",
      async run(provider) {
        for (const id of [
          "01JDOC00000000000000000003",
          "01JDOC00000000000000000001",
          "01JDOC00000000000000000002",
        ]) {
          await provider.documents.put(documentInput(id));
        }

        const page = await provider.documents.query({
          pluginId: PLUGIN,
          sort: { field: "id", direction: "desc" },
          offset: 1,
          limit: 2,
        });

        assert.deepEqual(
          page.map((document) => document.id),
          ["01JDOC00000000000000000002", "01JDOC00000000000000000001"],
        );
      },
    },
    {
      name: "документы изолированы по pluginId и collection",
      async run(provider) {
        await provider.documents.put(documentInput());

        assert.equal(await provider.documents.get(OTHER_PLUGIN, COLLECTION, DOC_ID), null);
        assert.equal(await provider.documents.get(PLUGIN, "gadgets", DOC_ID), null);
        assert.equal((await provider.documents.list(OTHER_PLUGIN)).length, 0);
      },
    },
    {
      name: "ссылки: add атомарен и идемпотентен",
      async run(provider) {
        const results: LinkStoreAddResult[] = await Promise.all(
          Array.from({ length: 5 }, () => provider.links.add(link())),
        );
        const inserted = results.filter((result) => result.inserted);

        assert.equal(inserted.length, 1);
        assert.deepEqual(new Set(results.map((result) => result.link.createdAt)).size, 1);
        assert.equal((await provider.links.listByRef(SOURCE)).length, 1);
        assert.equal((await provider.links.listByRef(TARGET)).length, 1);

        await provider.links.add(link(SOURCE, TARGET, OTHER_RELATION));
        await provider.links.add(link(TARGET, SOURCE, RELATION));
        assert.equal((await provider.links.listByRef(SOURCE)).length, 3);

        assert.equal(await provider.links.remove(SOURCE, TARGET, RELATION), true);
        assert.equal(await provider.links.remove(SOURCE, TARGET, RELATION), false);
      },
    },
    {
      name: "ссылки: удаление ref очищает связи с обеих сторон",
      async run(provider) {
        await provider.links.add(link(SOURCE, TARGET, RELATION));
        await provider.links.add(link(TARGET, OTHER, OTHER_RELATION));
        await provider.links.add(link(OTHER, TARGET, RELATION));
        await provider.links.add(link(SOURCE, OTHER, RELATION));

        assert.equal(await provider.links.deleteByRef(TARGET), 3);
        assert.deepEqual(await provider.links.listByRef(TARGET), []);
        assert.equal((await provider.links.listByRef(SOURCE)).length, 1);
        assert.equal(await provider.links.deleteByRef(TARGET), 0);
      },
    },
    {
      name: "состояние плагина сохраняется и читается",
      async run(provider) {
        const created = await provider.pluginStates.put({
          pluginId: PLUGIN,
          version: "1.2.3",
          enabled: true,
          state: { view: "board", nested: { value: 1 } },
        });

        assertUtc(created.updatedAt);
        assert.deepEqual(await provider.pluginStates.get(PLUGIN), created);
        assert.equal((await provider.pluginStates.list()).length, 1);

        const mutated = await provider.pluginStates.get(PLUGIN);
        assert.notEqual(mutated, null);

        if (mutated !== null) {
          (mutated.state as { view?: string }).view = "list";
        }

        assert.equal(
          ((await provider.pluginStates.get(PLUGIN))?.state as { view?: string }).view,
          "board",
        );

        const disabled = await provider.pluginStates.put({
          pluginId: PLUGIN,
          version: "1.2.3",
          enabled: false,
          state: { view: "list" },
        });

        assert.equal(disabled.enabled, false);
        assert.equal(await provider.pluginStates.delete(PLUGIN), true);
        assert.equal(await provider.pluginStates.get(PLUGIN), null);
        assert.equal(await provider.pluginStates.delete(PLUGIN), false);
      },
    },
    {
      name: "миграции: порядок, однократное применение и повторный skip",
      async run(provider) {
        const runner = new StorageMigrationRunner(provider);
        const order: number[] = [];
        const migrations: readonly StorageMigration[] = [
          {
            pluginId: PLUGIN,
            version: 2,
            name: "second",
            source: "second migration",
            async up() {
              order.push(2);
            },
          },
          {
            pluginId: PLUGIN,
            version: 1,
            name: "first",
            source: "first migration",
            async up() {
              order.push(1);
            },
          },
        ];

        const firstRun = await runner.run(migrations);

        assert.deepEqual(order, [1, 2]);
        assert.equal(firstRun.applied.length, 2);
        assert.equal(firstRun.skipped.length, 0);
        assert.equal((await provider.migrations.list(provider.backendId)).length, 2);

        const secondRun = await runner.run(migrations);
        assert.equal(secondRun.applied.length, 0);
        assert.equal(secondRun.skipped.length, 2);
        assert.deepEqual(order, [1, 2]);
      },
    },
    {
      name: "миграции: несовпадение checksum блокирует повтор",
      async run(provider) {
        const runner = new StorageMigrationRunner(provider);
        await runner.run([
          {
            pluginId: PLUGIN,
            version: 1,
            name: "init",
            source: "content A",
            async up() {
              return undefined;
            },
          },
        ]);

        await assertRejectsCode(
          runner.run([
            {
              pluginId: PLUGIN,
              version: 1,
              name: "init",
              source: "content B",
              async up() {
                return undefined;
              },
            },
          ]),
          "MIGRATION_CHECKSUM_MISMATCH",
          "изменённый checksum",
        );

        assert.equal((await provider.migrations.list(provider.backendId)).length, 1);
      },
    },
    {
      name: "миграции: rejected Promise откатывает изменения и журнал",
      async run(provider) {
        const runner = new StorageMigrationRunner(provider);

        await assertRejectsCode(
          runner.run([
            {
              pluginId: PLUGIN,
              version: 1,
              name: "failing",
              source: "failing migration",
              async up({ transaction }) {
                await transaction.documents.put(documentInput());
                throw new Error("migration failed");
              },
            },
          ]),
          "MIGRATION_FAILED",
          "ошибка миграции",
        );

        assert.equal(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
        assert.equal((await provider.migrations.list(provider.backendId)).length, 0);
      },
    },
    {
      name: "миграции: backend isolation и ключ backendId",
      async run(provider) {
        const runner = new StorageMigrationRunner(provider);
        const migrations: readonly StorageMigration[] = [
          {
            pluginId: PLUGIN,
            version: 1,
            name: "init",
            source: "backend scoped",
            async up() {
              return undefined;
            },
          },
        ];

        await runner.run(migrations);

        const other = await options.createProvider();

        try {
          await other.open();
          assert.equal((await other.migrations.list(other.backendId)).length, 0);

          const otherRunner = new StorageMigrationRunner(other);
          const result = await otherRunner.run(migrations);

          assert.equal(result.applied.length, 1);
          assert.equal((await provider.migrations.list(provider.backendId)).length, 1);
        } finally {
          await other.close();
        }
      },
    },
    {
      name: "миграции: неверный Plugin ID не создаёт namespace",
      async run(provider) {
        const runner = new StorageMigrationRunner(provider);

        await assertRejectsCode(
          runner.run([
            {
              pluginId: "Invalid:Plugin",
              version: 1,
              name: "bad",
              source: "bad plugin id",
              async up() {
                return undefined;
              },
            },
          ]),
          "INVALID_PLUGIN_ID",
          "неверный Plugin ID",
        );

        assert.equal((await provider.migrations.list()).length, 0);
        assert.equal((await provider.pluginStates.list()).length, 0);
      },
    },
    {
      name: "транзакция коммитится после завершения async callback",
      async run(provider) {
        await provider.withTransaction(async (transaction) => {
          await transaction.documents.put(documentInput());
          await wait(10);
          await transaction.documents.put(
            documentInput("01JDOC00000000000000000002", { title: "Second" }),
          );
        });

        assert.notEqual(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
        assert.notEqual(
          await provider.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000002"),
          null,
        );
      },
    },
    {
      name: "rejected Promise внутри транзакции откатывает изменения",
      async run(provider) {
        await assertRejectsError(
          provider.withTransaction(async (transaction) => {
            await transaction.documents.put(documentInput());
            throw new Error("transaction failed");
          }),
          "rejected callback сохраняет исходную ошибку",
        );

        assert.equal(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
      },
    },
    {
      name: "операция другого вызова ждёт открытую транзакцию",
      async run(provider) {
        const started = deferred();
        const gate = deferred();

        const transaction = provider.withTransaction(async (tx) => {
          await tx.documents.put(documentInput());
          started.resolve();
          await gate.promise;
        });

        await started.promise;

        let outsideFinished = false;
        const outside = provider.documents.get(PLUGIN, COLLECTION, DOC_ID).then((document) => {
          outsideFinished = true;

          return document;
        });

        await wait(15);
        assert.equal(
          outsideFinished,
          false,
          "операция не должна выполняться внутри чужой транзакции",
        );

        gate.resolve();
        await transaction;

        const document = await outside;
        assert.equal(outsideFinished, true);
        assert.notEqual(document, null);
      },
    },
    {
      name: "параллельные write-транзакции сериализуются",
      async run(provider) {
        const firstStarted = deferred();
        const firstGate = deferred();
        let secondEntered = false;

        const first = provider.withTransaction(async (tx) => {
          await tx.documents.put(documentInput());
          firstStarted.resolve();
          await firstGate.promise;
        });

        await firstStarted.promise;

        const second = provider.withTransaction(async (tx) => {
          secondEntered = true;
          await tx.documents.put(documentInput("01JDOC00000000000000000002", { title: "Second" }));
        });

        await wait(15);
        assert.equal(secondEntered, false, "вторая транзакция не должна пересекаться с первой");

        firstGate.resolve();
        await Promise.all([first, second]);

        assert.equal((await provider.documents.list(PLUGIN)).length, 2);
      },
    },
    {
      name: "savepoint откатывает только вложенную часть",
      async run(provider) {
        if (!provider.capabilities.savepoints) {
          await assertRejectsCode(
            provider.withTransaction(async (transaction) =>
              transaction.withSavepoint(async () => undefined),
            ),
            "SAVEPOINTS_UNSUPPORTED",
            "savepoint без capability",
          );

          return;
        }

        await provider.withTransaction(async (transaction) => {
          await transaction.documents.put(documentInput());

          await assertRejectsError(
            transaction.withSavepoint(async (nested) => {
              await nested.documents.put(
                documentInput("01JDOC00000000000000000002", { title: "Nested" }),
              );
              throw new Error("nested failed");
            }),
            "ошибка вложенной транзакции",
          );

          assert.notEqual(await transaction.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
          assert.equal(
            await transaction.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000002"),
            null,
          );
        });

        assert.notEqual(await provider.documents.get(PLUGIN, COLLECTION, DOC_ID), null);
        assert.equal(
          await provider.documents.get(PLUGIN, COLLECTION, "01JDOC00000000000000000002"),
          null,
        );
      },
    },
    {
      name: "поиск: индексирует, находит и полностью переиндексирует",
      async run(provider) {
        const expectedStrategy = provider.capabilities.fullTextSearch ? "full-text" : "substring";

        assert.equal(provider.searchIndex.strategy, expectedStrategy);

        await provider.searchIndex.upsert([
          {
            ref: SOURCE,
            pluginId: PLUGIN,
            title: "Widget Alpha",
            text: "Первый виджет для доски",
            kind: "widget",
            updatedAt: "2026-11-06T12:00:00.000Z",
          },
          {
            ref: TARGET,
            pluginId: OTHER_PLUGIN,
            title: "Gadget Beta",
            text: "Второй гаджет",
            kind: "gadget",
            updatedAt: "2026-11-06T12:00:00.000Z",
          },
        ]);

        const hits = await provider.searchIndex.search({ text: "виджет" });
        assert.equal(hits.length, 1);
        assert.equal(hits[0]?.ref, SOURCE);
        assert.equal(hits[0]?.strategy, expectedStrategy);

        const filtered = await provider.searchIndex.search({
          text: "гаджет",
          pluginId: PLUGIN,
        });
        assert.deepEqual(filtered, []);

        assert.equal(await provider.searchIndex.delete(SOURCE), true);
        assert.equal(await provider.searchIndex.delete(SOURCE), false);
        assert.equal((await provider.searchIndex.list()).length, 1);

        assert.equal(
          await provider.searchIndex.reindex([
            {
              ref: OTHER,
              pluginId: PLUGIN,
              title: "Reindexed",
              text: "Новый индекс",
            },
          ]),
          1,
        );
        assert.equal((await provider.searchIndex.list()).length, 1);
        assert.equal(await provider.searchIndex.clear(PLUGIN), 1);
        assert.deepEqual(await provider.searchIndex.list(), []);
      },
    },
    {
      name: "Store-контракт создаётся в области провайдера и транзакции",
      async run(provider) {
        const contract = { id: "acme.widgets.store.v1", version: 1 } as const;
        const registration = {
          contract,
          create(scope: StorageStoreScope) {
            return {
              async list() {
                return scope.documents.list(PLUGIN);
              },
            };
          },
        };

        const store = await provider.createStore(registration);

        await provider.documents.put(documentInput());
        assert.equal((await store.list()).length, 1);

        await provider
          .withTransaction(async (transaction) => {
            const transactional = await transaction.createStore(registration);

            await transaction.documents.put(
              documentInput("01JDOC00000000000000000002", { title: "Transactional" }),
            );
            assert.equal((await transactional.list()).length, 2);

            throw new Error("rollback store check");
          })
          .catch(() => undefined);

        assert.equal((await provider.documents.list(PLUGIN)).length, 1);
      },
    },
    {
      name: "реестр открывает provider, отдаёт capabilities и дубликат backendId",
      async run(provider) {
        const registry = new StorageProviderRegistry();

        registry.register(provider);
        assert.equal(registry.has(provider.backendId), true);
        assert.equal(registry.capabilitiesOf(provider.backendId).transactions, true);

        const active = await registry.open(provider.backendId);
        assert.equal(active, provider);
        assert.equal(registry.getActive(), provider);
        assert.equal((await registry.healthCheck(provider.backendId)).ok, true);

        const other = await options.createProvider();

        try {
          if (other.backendId === provider.backendId) {
            let duplicateRejected = false;

            try {
              registry.register(other);
            } catch (error) {
              duplicateRejected = errorCode(error) === "DUPLICATE_BACKEND";
            }

            assert.equal(duplicateRejected, true, "дубликат backendId должен отклоняться");
          }
        } finally {
          await other.close();
          await registry.closeAll();
        }
      },
    },
    {
      name: "bootstrap открывает provider и проверяет health до миграций",
      async run(provider) {
        const registry = new StorageProviderRegistry();
        let migrated = false;

        const result = await bootstrapStorage({
          registry,
          provider,
          migrations: [
            {
              pluginId: PLUGIN,
              version: 1,
              name: "bootstrap",
              source: "bootstrap conformance",
              async up() {
                migrated = true;
              },
            },
          ],
        });

        assert.equal(migrated, true);
        assert.equal(result.health.ok, true);
        assert.equal(result.migrations.applied.length, 1);
        assert.equal(registry.getActive(), provider);

        await registry.closeAll();
      },
    },
  ];

  if (options.createProviderWithoutSavepoints !== undefined) {
    cases.push({
      name: "savepoint недоступен без capability",
      async run() {
        const provider = await options.createProviderWithoutSavepoints?.();

        assert.notEqual(provider, undefined);

        if (provider === undefined) {
          return;
        }

        await provider.open();

        try {
          const registration = {
            contract: { id: "acme.widgets.no-savepoint.v1", version: 1 } as const,
            create() {
              return {
                async ping() {
                  return "pong";
                },
              };
            },
          };

          assert.notEqual(await provider.createStore(registration), undefined);

          await assertRejectsCode(
            provider.withTransaction(async (transaction) =>
              transaction.withSavepoint(async () => undefined),
            ),
            "SAVEPOINTS_UNSUPPORTED",
            "savepoint без capability",
          );
        } finally {
          await provider.close();
        }
      },
    });
  }

  return cases;
}
