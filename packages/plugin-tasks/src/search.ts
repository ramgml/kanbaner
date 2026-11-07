import {
  StorageError,
  parseResourceRef,
  type ResourceRef,
  type SearchDocumentInput,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASK_RESOURCE_TYPE } from "./constants.ts";
import type { Task } from "./model.ts";
import { formatTaskRef } from "./resources.ts";
import { assertStoredTask } from "./validation.ts";

/**
 * Преобразует задачу в `SearchDocumentInput`.
 *
 * Функция ничего не пишет в индекс и не добавляет `pluginId`: ответственный
 * плагин подставляет фасад поиска. `ref` обязан принадлежать домену задач и
 * указывать на ту же задачу; чужой `ResourceRef` отклоняется. Перед
 * преобразованием проверяется граница сохранённой модели: инвариант
 * `completedAt` и нормализованные теги.
 */
export function toTaskSearchDocument(
  task: Task,
  ref: ResourceRef = formatTaskRef(task.id),
): SearchDocumentInput {
  assertStoredTask(task);

  const parts = parseResourceRef(ref);

  if (parts.pluginId !== PLUGIN_ID) {
    throw new StorageError(
      "INVALID_PLUGIN_ID",
      "ResourceRef поискового документа принадлежит другому плагину",
    );
  }

  if (parts.resourceType !== TASK_RESOURCE_TYPE) {
    throw new StorageError(
      "INVALID_ARGUMENT",
      "ResourceRef поискового документа должен быть задачей",
    );
  }

  if (parts.opaqueId !== task.id) {
    throw new StorageError("INVALID_ARGUMENT", "ResourceRef не соответствует ID задачи");
  }

  const description = task.descriptionMarkdown.trim();
  const text = description.length === 0 ? task.title : `${task.title}\n\n${description}`;

  return {
    ref,
    title: task.title,
    text,
    kind: TASK_RESOURCE_TYPE,
    updatedAt: task.updatedAt,
    metadata: {
      projectId: task.projectId,
      status: task.status,
      priority: task.priority,
      tags: [...task.tags],
      ...(task.parentTaskId === null ? {} : { parentTaskId: task.parentTaskId }),
    },
  };
}
