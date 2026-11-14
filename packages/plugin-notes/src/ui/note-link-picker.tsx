"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Building2,
  ChevronDown,
  ChevronUp,
  ListTodo,
  Loader2,
  Plus,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { ResourceRef } from "@kanbaner/plugin-sdk";

import { invokeNotes, type UiOperationInvoker } from "./runtime.ts";

/** Размер страницы `project.list` / `task.list`; сохраняет прежнюю выборку. */
const PAGE_SIZE = 100;

const PROJECT_QUERY = "kanbaner.tasks.project.list";
const TASK_QUERY = "kanbaner.tasks.task.list";

const KIND_LABEL = {
  project: "Проект",
  task: "Задача",
} as const;

export type LinkTargetKind = keyof typeof KIND_LABEL;

/** Проект или задача, доступные для выбора в блоке связей. */
export interface LinkTarget {
  readonly id: string;
  readonly ref: ResourceRef;
  readonly title: string;
  readonly kind: LinkTargetKind;
}

interface TargetPage {
  readonly items: readonly LinkTarget[];
  readonly nextOffset: number | null;
}

interface SourceErrors {
  project: string | null;
  task: string | null;
}

interface NoteLinkPickerProps {
  readonly noteId: string;
  readonly invoke: UiOperationInvoker;
  readonly busy: boolean;
  /** Возвращает `true`, если связь создана и picker можно закрыть. */
  readonly onLink: (targetRef: ResourceRef) => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(reason: unknown, label: string): string {
  const detail = reason instanceof Error ? reason.message : "";
  return detail.length > 0 ? `${label}: ${detail}` : `${label}: не удалось загрузить`;
}

function readPage(value: unknown, kind: LinkTargetKind): TargetPage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { items: [], nextOffset: null };
  }

  const items: LinkTarget[] = [];
  for (const item of value.items) {
    if (!isRecord(item)) continue;
    const { id, title } = item;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof title !== "string" || title.length === 0) continue;
    items.push({
      id,
      ref: `kanbaner.tasks:${kind}:${id}`,
      title,
      kind,
    });
  }

  const nextOffset =
    typeof value.nextOffset === "number" &&
    Number.isInteger(value.nextOffset) &&
    value.nextOffset > 0
      ? value.nextOffset
      : null;

  return { items, nextOffset };
}

async function requestPage(
  invoke: UiOperationInvoker,
  kind: LinkTargetKind,
  offset: number,
): Promise<TargetPage> {
  const value = await invokeNotes<unknown>(
    invoke,
    kind === "project" ? PROJECT_QUERY : TASK_QUERY,
    { limit: PAGE_SIZE, offset },
  );
  return readPage(value, kind);
}

/**
 * Picker проектов и задач для универсальной связи заметки.
 *
 * Показывает человекочитаемые названия и тип ресурса; ResourceRef остаётся
 * внутренним значением и не вводится вручную. Поиск, клавиши ↑/↓/Home/End/Enter/
 * Escape и кнопки выбора работают одинаково на desktop и mobile.
 */
export function NoteLinkPicker({ noteId, invoke, busy, onLink }: NoteLinkPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly LinkTarget[]>([]);
  const [offsets, setOffsets] = useState<{
    readonly project: number | null;
    readonly task: number | null;
  }>({ project: 0, task: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errors, setErrors] = useState<SourceErrors>({ project: null, task: null });
  const [activeIndexState, setActiveIndex] = useState(0);
  const [selecting, setSelecting] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const selectingRef = useRef(false);
  const noteIdRef = useRef(noteId);

  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  const listboxId = `note-link-targets-${noteId}`;
  const panelId = `note-link-picker-${noteId}`;

  const loadInitial = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setErrors({ project: null, task: null });

    const [projects, tasks] = await Promise.allSettled([
      requestPage(invoke, "project", 0),
      requestPage(invoke, "task", 0),
    ]);
    if (requestRef.current !== request) return;

    const nextItems: LinkTarget[] = [];
    const nextOffsets: { project: number | null; task: number | null } = {
      project: null,
      task: null,
    };
    const nextErrors: SourceErrors = { project: null, task: null };

    if (projects.status === "fulfilled") {
      nextItems.push(...projects.value.items);
      nextOffsets.project = projects.value.nextOffset;
    } else {
      nextErrors.project = errorMessage(projects.reason, "Проекты");
    }

    if (tasks.status === "fulfilled") {
      nextItems.push(...tasks.value.items);
      nextOffsets.task = tasks.value.nextOffset;
    } else {
      nextErrors.task = errorMessage(tasks.reason, "Задачи");
    }

    setItems(nextItems);
    setOffsets(nextOffsets);
    setErrors(nextErrors);
    setLoading(false);
  }, [invoke]);

  useEffect(() => {
    void Promise.resolve().then(loadInitial);
  }, [loadInitial]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore) return;
    const projectOffset = offsets.project;
    const taskOffset = offsets.task;
    const requestProject = projectOffset !== null;
    const requestTask = taskOffset !== null;
    if (!requestProject && !requestTask) return;

    const request = requestRef.current;
    setLoadingMore(true);
    const [projects, tasks] = await Promise.allSettled([
      requestProject ? requestPage(invoke, "project", projectOffset) : Promise.resolve(null),
      requestTask ? requestPage(invoke, "task", taskOffset) : Promise.resolve(null),
    ]);
    if (requestRef.current !== request) {
      setLoadingMore(false);
      return;
    }

    const added: LinkTarget[] = [];
    const nextOffsets: { project: number | null; task: number | null } = {
      project: null,
      task: null,
    };
    const nextErrors: SourceErrors = { project: null, task: null };

    if (requestProject) {
      if (projects.status === "fulfilled" && projects.value !== null) {
        added.push(...projects.value.items);
        nextOffsets.project =
          projects.value.nextOffset !== null && projects.value.nextOffset > projectOffset
            ? projects.value.nextOffset
            : null;
      } else if (projects.status === "rejected") {
        nextOffsets.project = projectOffset;
        nextErrors.project = errorMessage(projects.reason, "Проекты");
      }
    }

    if (requestTask) {
      if (tasks.status === "fulfilled" && tasks.value !== null) {
        added.push(...tasks.value.items);
        nextOffsets.task =
          tasks.value.nextOffset !== null && tasks.value.nextOffset > taskOffset
            ? tasks.value.nextOffset
            : null;
      } else if (tasks.status === "rejected") {
        nextOffsets.task = taskOffset;
        nextErrors.task = errorMessage(tasks.reason, "Задачи");
      }
    }

    setItems((current) => {
      const seen = new Set(current.map((item) => item.ref));
      return [...current, ...added.filter((item) => !seen.has(item.ref))];
    });
    setOffsets(nextOffsets);
    // Незапрошенный источник сохраняет свою прежнюю ошибку и retry.
    setErrors((current) => ({
      project: projectOffset === null ? current.project : nextErrors.project,
      task: taskOffset === null ? current.task : nextErrors.task,
    }));
    setLoadingMore(false);
  }, [invoke, loading, loadingMore, offsets]);

  const normalized = search.trim().toLocaleLowerCase("ru");
  const filtered = useMemo(
    () =>
      normalized.length === 0
        ? items
        : items.filter((item) => item.title.toLocaleLowerCase("ru").includes(normalized)),
    [items, normalized],
  );

  const activeIndex = filtered.length === 0 ? 0 : Math.min(activeIndexState, filtered.length - 1);

  useEffect(() => {
    if (!open || filtered.length === 0) return;
    const element = document.getElementById(`${listboxId}-option-${activeIndex}`);
    element?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, filtered.length, listboxId, open]);

  const choose = async (target: LinkTarget) => {
    if (selectingRef.current || busy) return;
    const activeNoteId = noteId;
    selectingRef.current = true;
    setSelecting(true);
    try {
      const linked = await onLink(target.ref);
      if (noteIdRef.current !== activeNoteId) return;
      if (linked) {
        setOpen(false);
        setSearch("");
        triggerRef.current?.focus();
      } else {
        // Неуспешное добавление не должно уводить фокус из combobox.
        inputRef.current?.focus();
      }
    } finally {
      if (noteIdRef.current === activeNoteId) {
        selectingRef.current = false;
        setSelecting(false);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setSearch("");
      triggerRef.current?.focus();
      return;
    }

    if (event.key === "Tab") {
      setOpen(false);
      return;
    }

    if (filtered.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((activeIndex + 1) % filtered.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((activeIndex - 1 + filtered.length) % filtered.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(filtered.length - 1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[activeIndex];
      if (target !== undefined) {
        void choose(target);
      }
    }
  };

  const hasMore = offsets.project !== null || offsets.task !== null;
  const errorMessages = [errors.project, errors.task].filter(
    (message): message is string => message !== null,
  );
  const error = errorMessages.length > 0 ? errorMessages.join(" ") : null;

  // Поиск идёт по уже загруженным страницам. Пока совпадений нет, а страницы
  // остались и ошибок нет, догружаем их; иначе «Ничего не найдено» было бы
  // ложным. После ошибки страницы автодогрузка останавливается: повторять
  // упавший offset можно только явной кнопкой «Повторить».
  useEffect(() => {
    if (!open || normalized.length === 0) return;
    if (filtered.length > 0 || !hasMore || loading || loadingMore || error !== null) return;
    void Promise.resolve().then(loadMore);
  }, [error, filtered.length, hasMore, loadMore, loading, loadingMore, normalized, open]);

  const activeTarget = filtered[activeIndex];
  const activeDescendant =
    open && activeTarget !== undefined ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div className="flex flex-col gap-2">
      <button
        ref={triggerRef}
        type="button"
        data-testid="note-link-picker-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={busy}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <Plus aria-hidden="true" className="size-3.5" />
        {open ? "Свернуть выбор" : "Добавить связь"}
        {open ? (
          <ChevronUp aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        )}
      </button>

      {open ? (
        <div
          id={panelId}
          data-testid="note-link-picker"
          className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2"
        >
          <div className="relative min-w-0">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              aria-label="Поиск проекта или задачи"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={filtered.length > 0 ? listboxId : undefined}
              aria-activedescendant={activeDescendant}
              data-testid="note-link-search"
              value={search}
              placeholder="Название проекта или задачи"
              onChange={(event) => {
                setActiveIndex(0);
                setSearch(event.target.value);
              }}
              onKeyDown={onKeyDown}
              className="h-9 w-full min-w-0 rounded-md border border-input bg-background pr-2 pl-7 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {loading && items.length === 0 ? (
            <p
              role="status"
              data-testid="note-link-picker-loading"
              className="m-0 flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Загрузка проектов и задач…
            </p>
          ) : null}

          {error !== null ? (
            <div
              role="alert"
              data-testid="note-link-picker-error"
              className="rounded-md border border-destructive/40 px-2 py-1.5 text-xs text-destructive"
            >
              <p className="m-0 flex items-start gap-1.5">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">{error}</span>
              </p>
              <button
                type="button"
                data-testid="note-link-picker-retry"
                disabled={loading}
                onClick={() => {
                  void loadInitial();
                }}
                className="mt-1 inline-flex min-h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Повторить
              </button>
            </div>
          ) : null}

          {!loading && error === null && items.length === 0 ? (
            <p
              data-testid="note-link-picker-empty"
              className="m-0 rounded-md border border-dashed border-border px-2 py-2 text-xs text-muted-foreground"
            >
              Нет доступных проектов и задач. Создайте проект или задачу, чтобы связать их с
              заметкой.
            </p>
          ) : null}

          {loadingMore && normalized.length > 0 && filtered.length === 0 ? (
            <p
              role="status"
              data-testid="note-link-picker-searching"
              className="m-0 flex items-center gap-1.5 px-1 py-1 text-xs text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Ищем на остальных страницах…
            </p>
          ) : null}

          {items.length > 0 &&
          filtered.length === 0 &&
          !hasMore &&
          error === null &&
          !loading &&
          !loadingMore ? (
            <p
              role="status"
              data-testid="note-link-picker-no-results"
              className="m-0 px-1 py-1 text-xs text-muted-foreground"
            >
              Ничего не найдено
            </p>
          ) : null}

          {filtered.length > 0 ? (
            <div
              id={listboxId}
              role="listbox"
              aria-label="Проекты и задачи"
              className="flex max-h-64 min-w-0 flex-col gap-0.5 overflow-y-auto"
            >
              {filtered.map((target, index) => {
                const active = index === activeIndex;
                const Icon = target.kind === "project" ? Building2 : ListTodo;
                return (
                  <button
                    key={target.ref}
                    type="button"
                    role="option"
                    id={`${listboxId}-option-${index}`}
                    aria-selected={active}
                    tabIndex={-1}
                    data-testid={`note-link-option-${target.kind}-${target.id}`}
                    data-note-link-target={target.ref}
                    disabled={busy || selecting}
                    onMouseDown={(event) => {
                      // Указатель не должен уводить DOM-фокус из combobox:
                      // клавиатурная навигация продолжает работать сразу.
                      event.preventDefault();
                    }}
                    onMouseEnter={() => {
                      setActiveIndex(index);
                    }}
                    onClick={() => {
                      void choose(target);
                    }}
                    className={`flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                      active ? "bg-accent" : "hover:bg-accent/60"
                    }`}
                  >
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{target.title}</span>
                    <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[0.6875rem] font-medium text-secondary-foreground">
                      {KIND_LABEL[target.kind]}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {hasMore ? (
            <button
              type="button"
              data-testid="note-link-picker-more"
              disabled={loadingMore || loading}
              onClick={() => {
                void loadMore();
              }}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : null}
              Показать ещё
            </button>
          ) : null}

          {selecting ? (
            <p role="status" className="m-0 px-1 text-xs text-muted-foreground">
              Добавляем связь…
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
