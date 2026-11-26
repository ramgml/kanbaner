import type { JsonValue } from "@kanbaner/plugin-sdk";
import {
  TASKS_QUERY_IDS,
  type ColumnListOutput,
  type TaskColumn,
} from "@kanbaner/plugin-tasks/contract";
import type { UiOperationInvoker } from "@kanbaner/task-ui";

import { invokeJson } from "./operations.ts";

/** Контракт запросов ограничивает `limit` значением 200. */
const MAX_LIST_LIMIT = 200;

/** Читает все фактические колонки проекта устойчивыми страницами. */
export async function fetchProjectColumns(
  invoke: UiOperationInvoker,
  projectId: string,
): Promise<readonly TaskColumn[]> {
  const items: TaskColumn[] = [];
  let offset = 0;

  for (;;) {
    const data = await invokeJson<ColumnListOutput>(invoke, TASKS_QUERY_IDS.columnList, {
      projectId,
      limit: MAX_LIST_LIMIT,
      offset,
    } as unknown as JsonValue);

    items.push(...data.items);

    if (data.nextOffset === null || data.items.length === 0 || data.nextOffset <= offset) {
      break;
    }

    offset = data.nextOffset;
  }

  return items;
}
