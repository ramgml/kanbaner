import {
  StorageError,
  parseResourceRef,
  toSearchDocument,
  type ResourceRef,
  type SearchIndexDocument,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASK_RESOURCE_TYPE } from "./constants.ts";
import type { Task } from "./model.ts";
import { formatTaskRef } from "./resources.ts";

/**
 * Преобразует задачу в поисковый документ.
 *
 * Функция ничего не пишет в индекс. `ref` обязан принадлежать домену задач и
 * указывать на ту же задачу; чужой ResourceRef отклоняется.
 */
export function toTaskSearchDocument(
  task: Task,
  ref: ResourceRef = formatTaskRef(task.id),
): SearchIndexDocument {
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

  return toSearchDocument(PLUGIN_ID, {
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
  });
}
