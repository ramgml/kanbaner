"use client";

import { useEffect, useRef, useState } from "react";

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
/**
 * Поддерживаемые writer-ы query string из router-aware shell.
 *
 * `history.replaceState` меняет URL, но Next 16 App Router не обновляет
 * `useSearchParams` для внешнего replaceState (renderedSearch остаётся
 * прежним). `router.replace` держит router и URL синхронными.
 */
const searchWriters = new Set<(search: string) => void>();
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

/** Сериализует состояние доски в query string с ведущим `?`. */
export function serializeKanbanQuery(state: KanbanQueryState): string {
  const search = toSearchParams(state).toString();

  return search.length === 0 ? "" : `?${search}`;
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
  const nextSearch = search.length === 0 ? "" : `?${search}`;
  const writer = searchWriters.values().next().value;

  if (writer !== undefined) {
    writer(nextSearch);

    return;
  }

  const url = `${window.location.pathname}${nextSearch}`;

  window.history.replaceState(null, "", url);
}

/**
 * Регистрирует writer из shell. Возвращает cleanup; несколько смонтированных
 * вкладов доски используют один и тот же writer, поэтому хранится набор.
 */
export function registerKanbanSearchWriter(writer: (search: string) => void): () => void {
  searchWriters.add(writer);

  return () => {
    searchWriters.delete(writer);
  };
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

/** Применяет произвольную query string, сохраняя локальную ревизию. */
export function setKanbanSearch(search: string): void {
  const parsed = parseKanbanQuery(search);

  current = { ...parsed, revision: current.revision };
  writeUrl(current);
  emit();
}

/** Сбрасывает тег, сохраняя выбранный проект и выбранную карточку. */
export function resetKanbanFilters(): void {
  updateKanbanQuery({ tag: "" });
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
 *
 * `search` — актуальная query string из router-aware shell (`useSearchParams`).
 * Она синхронизирует состояние при настоящих Link-переходах, а не только по
 * `popstate`; локальные обновления (`updateKanbanQuery`) по-прежнему уведомляют
 * подписчиков напрямую.
 */
export function useKanbanQuery(search?: string): KanbanQueryState {
  const [state, setState] = useState<KanbanQueryState>(current);
  const lastSearchRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (search === undefined || lastSearchRef.current === search) {
      return;
    }

    lastSearchRef.current = search;
    current = { ...parseKanbanQuery(search), revision: current.revision };
    setState(current);
  }, [search]);

  return state;
}
