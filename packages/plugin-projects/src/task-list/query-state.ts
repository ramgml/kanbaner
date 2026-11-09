"use client";

import { useEffect, useState } from "react";

import type { SortDirection, TaskSortField } from "@kanbaner/plugin-tasks/contract";

export const TASK_LIST_PAGE_SIZE = 25;

export type TaskListSortField = Extract<
  TaskSortField,
  "position" | "dueAt" | "updatedAt" | "title"
>;

export interface TaskListQueryState {
  readonly projectId: string;
  readonly status: string;
  readonly priority: string;
  readonly tag: string;
  readonly dueAfter: string;
  readonly dueBefore: string;
  readonly sortField: TaskListSortField;
  readonly sortDirection: SortDirection;
  /** Нумерация страниц в URL человекочитаемая: 1 — первая. */
  readonly page: number;
  readonly taskId: string | null;
  /** Локальная ревизия данных; не сериализуется в URL. */
  readonly revision: number;
}

const SORT_FIELDS: readonly TaskListSortField[] = ["position", "dueAt", "updatedAt", "title"];

export const DEFAULT_TASK_LIST_QUERY: TaskListQueryState = Object.freeze({
  projectId: "",
  status: "",
  priority: "",
  tag: "",
  dueAfter: "",
  dueBefore: "",
  sortField: "position",
  sortDirection: "asc",
  page: 1,
  taskId: null,
  revision: 0,
});

const listeners = new Set<() => void>();
let current: TaskListQueryState = DEFAULT_TASK_LIST_QUERY;

function isSortField(value: string | null): value is TaskListSortField {
  return value !== null && (SORT_FIELDS as readonly string[]).includes(value);
}

function parsePositivePage(value: string | null): number {
  if (value === null) {
    return 1;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function first(params: URLSearchParams, key: string): string {
  return params.get(key)?.trim() ?? "";
}

/** Читает состояние списка из query string. */
export function parseTaskListQuery(search: string): TaskListQueryState {
  const params = new URLSearchParams(search);
  const sort = params.get("sort");
  const direction = params.get("dir");
  const taskId = params.get("task")?.trim() ?? "";

  return {
    ...DEFAULT_TASK_LIST_QUERY,
    projectId: first(params, "project"),
    status: first(params, "status"),
    priority: first(params, "priority"),
    tag: first(params, "tag"),
    dueAfter: first(params, "dueAfter"),
    dueBefore: first(params, "dueBefore"),
    sortField: isSortField(sort) ? sort : "position",
    sortDirection: direction === "desc" ? "desc" : "asc",
    page: parsePositivePage(params.get("page")),
    taskId: taskId.length === 0 ? null : taskId,
  };
}

function toSearchParams(state: TaskListQueryState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.projectId.length > 0) {
    params.set("project", state.projectId);
  }

  if (state.status.length > 0) {
    params.set("status", state.status);
  }

  if (state.priority.length > 0) {
    params.set("priority", state.priority);
  }

  if (state.tag.length > 0) {
    params.set("tag", state.tag);
  }

  if (state.dueAfter.length > 0) {
    params.set("dueAfter", state.dueAfter);
  }

  if (state.dueBefore.length > 0) {
    params.set("dueBefore", state.dueBefore);
  }

  if (state.sortField !== "position") {
    params.set("sort", state.sortField);
  }

  if (state.sortDirection !== "asc") {
    params.set("dir", "desc");
  }

  if (state.page !== 1) {
    params.set("page", String(state.page));
  }

  if (state.taskId !== null) {
    params.set("task", state.taskId);
  }

  return params;
}

/** Сериализует состояние списка в query string с ведущим `?`. */
export function serializeTaskListQuery(state: TaskListQueryState): string {
  const search = toSearchParams(state).toString();

  return search.length === 0 ? "" : `?${search}`;
}

function readLocation(): TaskListQueryState {
  if (typeof window === "undefined") {
    return current;
  }

  return parseTaskListQuery(window.location.search);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ошибка наблюдателя не должна ломать перерисовку остальных.
    }
  }
}

function writeUrl(state: TaskListQueryState, mode: "replace" | "push"): void {
  if (typeof window === "undefined") {
    return;
  }

  const search = toSearchParams(state).toString();
  const url = `${window.location.pathname}${search.length === 0 ? "" : `?${search}`}`;

  if (mode === "push") {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
}

/** Обновляет query string и уведомляет все смонтированные панели. */
export function updateTaskListQuery(
  patch: Partial<Omit<TaskListQueryState, "revision">>,
  options: { readonly mode?: "replace" | "push" } = {},
): void {
  const next: TaskListQueryState = { ...current, ...patch, revision: current.revision };

  current = next;
  writeUrl(next, options.mode ?? "replace");
  emit();
}

/** Применяет произвольную query string, сохраняя локальную ревизию. */
export function setTaskListSearch(search: string): void {
  const parsed = parseTaskListQuery(search);

  current = { ...parsed, revision: current.revision };
  writeUrl(current, "replace");
  emit();
}

/** Сбрасывает фильтры и страницу, сохраняя проект, задачу и сортировку. */
export function resetTaskListFilters(): void {
  updateTaskListQuery({
    status: "",
    priority: "",
    tag: "",
    dueAfter: "",
    dueBefore: "",
    page: 1,
  });
}

/** Требует повторного запроса списка и деталей после команды. */
export function bumpTaskListRevision(): void {
  current = { ...current, revision: current.revision + 1 };
  emit();
}

/** Только для тестов: синхронизирует модульное состояние с переданным URL. */
export function resetTaskListQueryForTests(search = ""): void {
  current = { ...parseTaskListQuery(search), revision: current.revision + 1 };
  emit();
}

export function getTaskListQuerySnapshot(): TaskListQueryState {
  return current;
}

export function subscribeTaskListQuery(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Подписка на состояние query string.
 *
 * Начальное значение всегда безопасно для SSR; фактический URL читается в
 * effect после монтирования. Так серверный и клиентский первый рендер
 * совпадают даже при открытии ссылки с фильтрами.
 */
export function useTaskListQuery(): TaskListQueryState {
  const [state, setState] = useState<TaskListQueryState>(current);

  useEffect(() => {
    const sync = (): void => {
      setState(current);
    };

    const updateFromUrl = (): void => {
      current = { ...readLocation(), revision: current.revision };
      sync();
    };

    updateFromUrl();
    const unsubscribe = subscribeTaskListQuery(sync);
    window.addEventListener("popstate", updateFromUrl);

    return () => {
      unsubscribe();
      window.removeEventListener("popstate", updateFromUrl);
    };
  }, []);

  return state;
}
