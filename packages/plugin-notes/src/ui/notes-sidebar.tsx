"use client";

import { PanelLeftClose, Plus, Search } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { NoteSearchPage, NoteView } from "../model.ts";
import { NoteTree } from "./note-tree.tsx";

export type NotesFilter = "tree" | "favorite" | "recent";

export interface NotesSidebarContext {
  readonly items: readonly NoteView[];
  readonly visibleItems: readonly NoteView[];
  readonly selectedId: string | null;
  readonly filter: NotesFilter;
  readonly searchText: string;
  readonly searchResults: NoteSearchPage | null;
  readonly busy: boolean;
  readonly movePending: boolean;
  readonly onFilterChange: (filter: NotesFilter) => void;
  readonly onSearchTextChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onClearSearch: () => void;
  readonly onSelect: (id: string) => void;
  readonly onCreate: (parentId: string | null) => void;
  readonly onMove: (id: string, parentId: string | null, position?: number) => void;
  readonly onDelete: (view: NoteView) => void;
}

const inputClass =
  "rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

interface PublishedContext {
  readonly owner: object;
  readonly value: NotesSidebarContext;
}

let published: PublishedContext | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ошибка одного наблюдателя не должна ломать рабочее пространство.
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentValue(): NotesSidebarContext | null {
  return published?.value ?? null;
}

function snapshotChanged(left: NotesSidebarContext, right: NotesSidebarContext): boolean {
  const leftRecord = left as unknown as Readonly<Record<string, unknown>>;
  const rightRecord = right as unknown as Readonly<Record<string, unknown>>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);

  for (const key of keys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (typeof leftValue === "function" && typeof rightValue === "function") continue;
    if (leftValue !== rightValue) return true;
  }

  return false;
}

/**
 * Публикует состояние смонтированного NotesView для вклада глобального sidebar.
 * Owner не даёт старому представлению очистить состояние нового после HMR.
 */
export function usePublishNotesSidebar(value: NotesSidebarContext): void {
  const [owner] = useState<object>(() => ({}));

  useEffect(() => {
    const previous = published;
    if (previous !== null && previous.owner === owner && !snapshotChanged(previous.value, value)) {
      // Обработчики обновляются без перерисовки дерева при вводе в редакторе.
      published = { owner, value };
      return;
    }
    published = { owner, value };
    emit();
  });

  useEffect(
    () => () => {
      if (published?.owner === owner) {
        published = null;
        emit();
      }
    },
    [owner],
  );
}

function useNotesSidebar(): NotesSidebarContext | null {
  return useSyncExternalStore(subscribe, currentValue, () => null);
}

export const NOTES_MOBILE_MEDIA_QUERY = "(max-width: 767px)" as const;

function mobileMatches(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(NOTES_MOBILE_MEDIA_QUERY).matches;
}

function subscribeMobile(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia(NOTES_MOBILE_MEDIA_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/** В jsdom без matchMedia сохраняется прежний мобильный режим NotesView. */
export function useNotesMobileViewport(): boolean {
  return useSyncExternalStore(subscribeMobile, mobileMatches, () => true);
}

export function NotesSidebarPanel({
  value,
  mobile = false,
  onClose,
}: {
  readonly value: NotesSidebarContext;
  readonly mobile?: boolean;
  readonly onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        {mobile ? (
          <h1 className="text-base font-semibold">Заметки</h1>
        ) : (
          <h2 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Заметки
          </h2>
        )}
        <div className="flex items-center gap-1">
          {mobile ? (
            <button
              type="button"
              aria-label="Закрыть дерево заметок"
              onClick={onClose}
              className={buttonClass}
            >
              <PanelLeftClose aria-hidden="true" className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Создать заметку"
            title="Создать заметку"
            data-note-create-top
            disabled={value.busy}
            onClick={() => value.onCreate(null)}
            className={buttonClass}
          >
            <Plus aria-hidden="true" className="size-4" />
            {mobile ? "Создать" : null}
          </button>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          value.onSearch();
        }}
        className="flex gap-1 border-b border-border p-2"
      >
        <input
          aria-label="Поиск заметок"
          data-testid="note-search-input"
          value={value.searchText}
          onChange={(event) => value.onSearchTextChange(event.target.value)}
          placeholder="Поиск…"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="submit" aria-label="Найти" className={buttonClass}>
          <Search aria-hidden="true" className="size-4" />
        </button>
      </form>
      <div
        className="flex gap-1 border-b border-border p-2"
        role="group"
        aria-label="Фильтр страниц"
      >
        {(["tree", "favorite", "recent"] as const).map((filter) => (
          <button
            key={filter}
            type="button"
            aria-pressed={value.filter === filter}
            data-note-filter={filter}
            onClick={() => value.onFilterChange(filter)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${value.filter === filter ? "bg-accent" : "hover:bg-accent/50"}`}
          >
            {filter === "tree" ? "Дерево" : filter === "favorite" ? "Избранное" : "Недавние"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {value.searchResults !== null ? (
          <section aria-label="Результаты поиска">
            <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span>Найдено: {value.searchResults.items.length}</span>
              <button type="button" onClick={value.onClearSearch} className="underline">
                Сбросить
              </button>
            </div>
            <ul className="m-0 list-none p-0">
              {value.searchResults.items.map((hit) => (
                <li key={hit.noteId}>
                  <button
                    type="button"
                    data-note-search-result={hit.noteId}
                    onClick={() => value.onSelect(hit.noteId)}
                    className="w-full rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-sm font-medium">{hit.title}</span>
                    <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                      {hit.excerpt}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <NoteTree
            items={value.visibleItems}
            positionItems={value.items}
            flat={value.filter === "recent"}
            movePending={value.movePending}
            actionsDisabled={value.busy}
            selectedId={value.selectedId}
            onSelect={value.onSelect}
            onCreate={value.onCreate}
            onMove={value.onMove}
            onDelete={value.onDelete}
          />
        )}
      </div>
    </>
  );
}

/** Desktop-вклад `app.sidebar`; состояние и действия принадлежат NotesView. */
export function NotesSidebar() {
  const value = useNotesSidebar();
  const mobile = useNotesMobileViewport();

  if (value === null || mobile) return null;

  return (
    <section
      aria-label="Навигация по заметкам"
      data-testid="notes-global-sidebar"
      className="flex min-h-0 flex-1 flex-col"
    >
      <NotesSidebarPanel value={value} />
    </section>
  );
}
