import {
  type PluginLogger,
  type PluginSearchService,
  type ResourceRef,
} from "@kanbaner/plugin-sdk";

import type { Task } from "../model.ts";
import { toTaskSearchDocument } from "../search.ts";
import type { TasksStore } from "../store.ts";
import { listAllTasks } from "./snapshots.ts";

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "UnknownError";
}

/**
 * Обновляет поисковые документы задач после коммита.
 *
 * Ошибка индекса не отменяет уже зафиксированную команду. Полная
 * переиндексация при следующей активации восстановит индекс.
 */
export async function upsertTaskSearchDocuments(
  search: PluginSearchService,
  tasks: readonly Task[],
  logger: PluginLogger,
): Promise<void> {
  if (tasks.length === 0) {
    return;
  }

  try {
    await search.upsert(tasks.map((task) => toTaskSearchDocument(task)));
  } catch (error) {
    logger.warn("tasks.search_upsert_failed", {
      count: tasks.length,
      errorName: safeErrorName(error),
    });
  }
}

/** Удаляет документы всех переданных ресурсов; ошибки best-effort. */
export async function deleteSearchDocuments(
  search: PluginSearchService,
  refs: readonly ResourceRef[],
  logger: PluginLogger,
): Promise<void> {
  for (const ref of refs) {
    try {
      await search.delete(ref);
    } catch (error) {
      logger.warn("tasks.search_delete_failed", {
        resource: ref,
        errorName: safeErrorName(error),
      });
    }
  }
}

/**
 * Полная переиндексация задач при активации.
 *
 * Читает все задачи домена в одной транзакции и заменяет документы поиска.
 * Проекты не индексируются: контракт предусматривает поисковые документы
 * только для задач. Сбой пробрасывается: вызывающая активация обязана
 * завершиться ошибкой, а не оставить провайдера со stale-индексом.
 */
export async function reindexAllTasks(
  store: Pick<TasksStore, "withTransaction">,
  search: PluginSearchService,
  logger: PluginLogger,
): Promise<number> {
  const tasks = await store.withTransaction((transaction) => listAllTasks(transaction));

  try {
    return await search.reindex(tasks.map((task) => toTaskSearchDocument(task)));
  } catch (error) {
    logger.error("tasks.search_reindex_failed", {
      count: tasks.length,
      errorName: safeErrorName(error),
    });

    throw error;
  }
}
