import type {
  PluginLogger,
  PluginSearchService,
  SearchProvider,
  SearchProviderFacet,
  SearchHit,
} from "@kanbaner/plugin-sdk";

import { PLUGIN_ID, TASK_RESOURCE_TYPE } from "../constants.ts";
import { TASK_STATUSES, type TaskStatus } from "../model.ts";
import type { TasksStore } from "../store.ts";
import { reindexAllTasks } from "./search-index.ts";
import { listAllTasks } from "./snapshots.ts";

const PAGE_SIZE = 200;

const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: "Бэклог",
  todo: "К выполнению",
  in_progress: "В работе",
  done: "Готово",
};

async function listProjects(
  store: Pick<TasksStore, "listProjects">,
): Promise<readonly { readonly id: string; readonly title: string }[]> {
  const projects: { id: string; title: string }[] = [];
  let offset = 0;

  for (;;) {
    const page = await store.listProjects({ limit: PAGE_SIZE, offset });

    projects.push(...page.items.map((project) => ({ id: project.id, title: project.title })));

    if (page.nextOffset === null) {
      return projects;
    }

    offset = page.nextOffset;
  }
}

/**
 * SearchProvider домена задач.
 *
 * Провайдер не читает чужой индекс: он вызывает bound `search` своего
 * namespace-а, а facet-ы строит по собственным проектам и задачам.
 */
export function createTasksSearchProvider(
  store: TasksStore,
  search: PluginSearchService,
  logger: PluginLogger,
): SearchProvider {
  return {
    id: PLUGIN_ID,
    kinds: [{ id: TASK_RESOURCE_TYPE, title: "Задачи" }],
    filterFields: ["projectId", "status", "tags"],

    async listFacets(): Promise<readonly SearchProviderFacet[]> {
      const [projects, tasks] = await Promise.all([
        listProjects(store),
        store.withTransaction((transaction) => listAllTasks(transaction)),
      ]);
      const tags = new Set<string>();

      for (const task of tasks) {
        for (const tag of task.tags) {
          tags.add(tag);
        }
      }

      return [
        {
          id: "projectId",
          title: "Проект",
          operators: ["eq"],
          values: projects
            .map((project) => ({ value: project.id, label: project.title }))
            .sort((left, right) => left.label.localeCompare(right.label, "ru")),
        },
        {
          id: "status",
          title: "Статус",
          operators: ["eq"],
          values: TASK_STATUSES.map((status) => ({
            value: status,
            label: STATUS_LABELS[status],
          })),
        },
        {
          id: "tags",
          title: "Тег",
          operators: ["contains"],
          values: [...tags]
            .sort((left, right) => left.localeCompare(right, "ru"))
            .map((tag) => ({ value: tag, label: tag })),
        },
      ];
    },

    search(query): Promise<readonly SearchHit[]> {
      return search.search({
        text: query.text,
        kind: TASK_RESOURCE_TYPE,
        ...(query.filters === undefined ? {} : { filters: query.filters }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    reindex(): Promise<number> {
      return reindexAllTasks(store, search, logger);
    },
  };
}
