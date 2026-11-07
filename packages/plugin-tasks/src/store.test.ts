import { describe, expect, expectTypeOf, it } from "vitest";

import type { PluginDocumentStore, ResourceRef } from "@kanbaner/plugin-sdk";

import type { DeletedTaskDescriptor, Task } from "./model.ts";
import {
  TASKS_NESTED_TRANSACTION_CODE,
  TasksNestedTransactionError,
  type CompleteTaskStoreInput,
  type CreateTaskStoreInput,
  type DeleteStoreResult,
  type TasksStore,
  type TasksStoreTransaction,
} from "./store.ts";

/**
 * Compile-time проверка callback-а: scoped-транзакция даёт bound documents и
 * сама является TasksStore. Функция никогда не вызывается в runtime.
 */
function assertTransactionCallback(store: TasksStore): void {
  void store.withTransaction(async (transaction) => {
    const documents: PluginDocumentStore = transaction.documents;
    const scoped: TasksStore = transaction;

    void documents;
    void scoped;

    return 1;
  });
}

void assertTransactionCallback;

describe("TasksStore transaction contract", () => {
  it("scoped-интерфейс расширяет TasksStore и отдаёт bound documents", () => {
    expectTypeOf<TasksStoreTransaction>().toExtend<TasksStore>();
    expectTypeOf<TasksStoreTransaction["documents"]>().toEqualTypeOf<PluginDocumentStore>();
    expectTypeOf<TasksStore["withTransaction"]>().toBeFunction();
    expectTypeOf<TasksStoreTransaction["withTransaction"]>().toBeFunction();
  });

  it("root и scoped методы возвращают Promise", () => {
    expectTypeOf<TasksStore["createTask"]>().returns.toEqualTypeOf<Promise<Task>>();
    expectTypeOf<TasksStore["completeTask"]>().returns.toEqualTypeOf<Promise<Task>>();
    expectTypeOf<TasksStore["deleteTask"]>().returns.toEqualTypeOf<Promise<DeleteStoreResult>>();
  });

  it("фиксирует явную ошибку вложенной транзакции", () => {
    const error = new TasksNestedTransactionError();

    expect(error.name).toBe("TasksNestedTransactionError");
    expect(error.code).toBe(TASKS_NESTED_TRANSACTION_CODE);
    expect(error.code).toBe("NESTED_TRANSACTION");
  });
});

describe("append и каскадные типы", () => {
  it("position в create/complete необязательна и допускает undefined", () => {
    expectTypeOf<CreateTaskStoreInput["position"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<CompleteTaskStoreInput["position"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<CompleteTaskStoreInput>().not.toHaveProperty("completedAt");
  });

  it("delete result дискриминирован и содержит дескрипторы последних версий", () => {
    type Success = Extract<DeleteStoreResult, { readonly deleted: true }>;
    type Noop = Extract<DeleteStoreResult, { readonly deleted: false }>;

    expectTypeOf<Success["version"]>().toEqualTypeOf<number>();
    expectTypeOf<Success["deletedResourceRefs"]>().toEqualTypeOf<readonly ResourceRef[]>();
    expectTypeOf<Success["deletedTasks"]>().toEqualTypeOf<readonly DeletedTaskDescriptor[]>();
    expectTypeOf<Noop>().toEqualTypeOf<{ readonly deleted: false }>();
  });
});
