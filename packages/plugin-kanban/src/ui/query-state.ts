"use client";

import { useEffect, useState } from "react";

export interface KanbanQueryState {
  readonly projectId: string;
  readonly tag: string;
  readonly taskId: string | null;
  /** Локальная ревизия данных; не сериализуется в URL. */
  readonly revision: number;
}

export const DEFAULT_KANBAN_QUERY: KanbanQueryState = Object.freeze({
  projectId: "",
  tag: "",
  taskId: null,
  revision: 0,
});

const listeners = new Set<() => void>();
let current: KanbanQueryState = DEFAULT_KANBAN_QUERY;

function first(params: URLSearchParams, key: string): string {
  return params.get(key)?.trim() ?? "";
}

/** Читает фильтры и выбранную карточку из query string. */
export function parseKanbanQuery(search: string): KanbanQueryState {
  const params = new URLSearchParams(search);
  const taskId = first(params, "task");

  return {
    ...DEFAULT_KANBAN_QUERY,
    projectId: first(params, "project"),
    tag: first(params, "tag"),
    taskId: taskId.length === 0 ? null : taskId,
  };
}

function toSearchParams(state: KanbanQueryState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.projectId.length > 0) {
    params.set("project", state.projectId);
  }

  if (state.tag.length > 0) {
    params.set("tag", state.tag);
  }

  if (state.taskId !== null) {
    params.set("task", state.taskId);
  }

  return params;
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

function writeUrl(state: KanbanQueryState): void {
  if (typeof window === "undefined") {
    return;
  }

  const search = toSearchParams(state).toString();
  const url = `${window.location.pathname}${search.length === 0 ? "" : `?${search}`}`;

  window.history.replaceState(null, "", url);
}

function readLocation(): KanbanQueryState {
  if (typeof window === "undefined") {
    return current;
  }

  return parseKanbanQuery(window.location.search);
}

/** Обновляет query string и уведомляет все смонтированные вклады доски. */
export function updateKanbanQuery(patch: Partial<Omit<KanbanQueryState, "revision">>): void {
  current = { ...current, ...patch, revision: current.revision };
  writeUrl(current);
  emit();
}

/** Сбрасывает project/tag, сохраняя выбранную карточку. */
export function resetKanbanFilters(): void {
  updateKanbanQuery({ projectId: "", tag: "" });
}

/** Требует повторного запроса доски и деталей после команды. */
export function bumpKanbanRevision(): void {
  current = { ...current, revision: current.revision + 1 };
  emit();
}

/** Только для тестов: синхронизирует модульное состояние с переданным URL. */
export function resetKanbanQueryForTests(search = ""): void {
  current = { ...parseKanbanQuery(search), revision: current.revision + 1 };
  emit();
}

export function getKanbanQuerySnapshot(): KanbanQueryState {
  return current;
}

export function subscribeKanbanQuery(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Подписка на состояние query string.
 *
 * Начальное значение безопасно для SSR; фактический URL читается в effect
 * после монтирования, поэтому серверный и клиентский первый рендер совпадают.
 */
export function useKanbanQuery(): KanbanQueryState {
  const [state, setState] = useState<KanbanQueryState>(current);

  useEffect(() => {
    const sync = (): void => {
      setState(current);
    };

    const updateFromUrl = (): void => {
      current = { ...readLocation(), revision: current.revision };
      sync();
    };

    updateFromUrl();
    const unsubscribe = subscribeKanbanQuery(sync);
    window.addEventListener("popstate", updateFromUrl);

    return () => {
      unsubscribe();
      window.removeEventListener("popstate", updateFromUrl);
    };
  }, []);

  return state;
}
