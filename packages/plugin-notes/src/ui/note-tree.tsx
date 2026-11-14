"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GripVertical,
  Plus,
  Star,
  Trash2,
} from "lucide-react";

import type { NoteView } from "../model.ts";

interface NoteTreeProps {
  readonly items: readonly NoteView[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: (parentId: string | null) => void;
  readonly onMove: (id: string, parentId: string | null, position?: number) => void;
  readonly onDelete: (view: NoteView) => void;
  /**
   * Плоский список в переданном порядке.
   *
   * Нужен для «Недавних»: порядок задаёт вызывающий (lastOpenedAt), а дерево
   * не пересортировывает элементы по position и не показывает иерархию.
   */
  readonly flat?: boolean;
}

const buttonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Кнопки overlay-панели действий.
 *
 * Панель не участвует в расчёте ширины строки и лежит поверх названия, поэтому
 * интерактивны только сами кнопки: клик между ними проходит к названию. На
 * desktop панель скрыта до hover/focus, на touch видна всегда.
 */
const actionButtonClass = `${buttonClass} pointer-events-auto lg:size-6 lg:pointer-events-none lg:group-hover:pointer-events-auto lg:focus-within:pointer-events-auto`;

export function NoteTree({
  items,
  selectedId,
  onSelect,
  onCreate,
  onMove,
  onDelete,
  flat = false,
}: NoteTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const byParent = useMemo(() => {
    const result = new Map<string | null, NoteView[]>();
    for (const item of items) {
      const siblings = result.get(item.note.parentId) ?? [];
      siblings.push(item);
      result.set(item.note.parentId, siblings);
    }
    for (const siblings of result.values()) {
      siblings.sort((left, right) => left.note.position - right.note.position);
    }
    return result;
  }, [items]);
  const visibleIds = useMemo(() => new Set(items.map((item) => item.note.id)), [items]);
  const roots = useMemo(
    () =>
      items
        .filter((item) => item.note.parentId === null || !visibleIds.has(item.note.parentId))
        .sort((left, right) => left.note.position - right.note.position),
    [items, visibleIds],
  );

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    const byId = new Map(items.map((item) => [item.note.id, item.note]));
    const parents = new Set<string>();
    let current = byId.get(selectedId)?.parentId ?? null;
    while (current !== null) {
      parents.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    const timer = setTimeout(() => {
      setExpanded((previous) => new Set([...previous, ...parents]));
    }, 0);
    return () => clearTimeout(timer);
  }, [items, selectedId]);

  const renderNode = (view: NoteView, depth: number): ReactNode => {
    const id = view.note.id;
    const children = flat ? [] : (byParent.get(id) ?? []);
    const isExpanded = !flat && expanded.has(id);
    const siblings = byParent.get(view.note.parentId) ?? roots;
    const index = siblings.findIndex((item) => item.note.id === id);

    return (
      <li key={id}>
        <div
          data-note-tree-item={id}
          draggable={!flat}
          onDragStart={
            flat
              ? undefined
              : (event) => {
                  event.dataTransfer.setData("application/x-kanbaner-note", id);
                  event.dataTransfer.effectAllowed = "move";
                }
          }
          onDragOver={
            flat
              ? undefined
              : (event) => {
                  if (event.dataTransfer.types.includes("application/x-kanbaner-note")) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }
          }
          onDrop={
            flat
              ? undefined
              : (event) => {
                  const dragged = event.dataTransfer.getData("application/x-kanbaner-note");
                  if (dragged && dragged !== id) {
                    event.preventDefault();
                    onMove(dragged, view.note.parentId, Math.max(0, index));
                  }
                }
          }
          className={`group relative flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pr-1 ${
            selectedId === id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
          }`}
          style={{ paddingLeft: `${depth * 12 + 2}px` }}
        >
          {flat ? null : (
            <GripVertical aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/50" />
          )}
          {flat ? null : (
            <button
              type="button"
              aria-label={
                isExpanded ? `Свернуть ${view.note.title}` : `Развернуть ${view.note.title}`
              }
              aria-expanded={children.length > 0 ? isExpanded : undefined}
              disabled={children.length === 0}
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              className={`${buttonClass} ${children.length === 0 ? "invisible" : ""}`}
            >
              {isExpanded ? (
                <ChevronDown aria-hidden="true" className="size-3.5" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            data-note-select={id}
            onClick={() => onSelect(id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-28 pl-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:pr-1"
          >
            <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span data-note-title={id} className="min-w-0 flex-1 truncate">
              {view.note.title}
            </span>
            {view.favorite ? (
              <Star aria-label="Избранное" className="size-3 shrink-0 fill-current" />
            ) : null}
          </button>
          <div
            data-note-actions={id}
            className={`pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center rounded-r-md bg-gradient-to-l from-70% to-transparent pl-12 pr-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100 ${
              selectedId === id ? "from-accent" : "from-background lg:group-hover:from-accent"
            }`}
          >
            {flat ? null : (
              <>
                <button
                  type="button"
                  aria-label={`Переместить ${view.note.title} выше`}
                  disabled={index <= 0}
                  onClick={() => onMove(id, view.note.parentId, index - 1)}
                  className={`${actionButtonClass} text-xs disabled:opacity-30`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Переместить ${view.note.title} ниже`}
                  disabled={index < 0 || index >= siblings.length - 1}
                  onClick={() => onMove(id, view.note.parentId, index + 1)}
                  className={`${actionButtonClass} text-xs disabled:opacity-30`}
                >
                  ↓
                </button>
              </>
            )}
            <button
              type="button"
              data-note-add-child={id}
              aria-label={`Создать вложенную страницу в ${view.note.title}`}
              onClick={() => {
                setExpanded((previous) => new Set([...previous, id]));
                onCreate(id);
              }}
              className={actionButtonClass}
            >
              <Plus aria-hidden="true" className="size-3.5" />
            </button>
            <button
              type="button"
              data-note-delete={id}
              aria-label={`Удалить ${view.note.title}`}
              onClick={() => onDelete(view)}
              className={`${actionButtonClass} hover:text-destructive`}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </div>
        {children.length > 0 && isExpanded ? (
          <ul className="m-0 list-none p-0">
            {children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="min-w-0">
      <ul
        aria-label={flat ? "Список заметок" : "Дерево заметок"}
        className="m-0 list-none p-0"
        onDragOver={flat ? undefined : (event) => event.preventDefault()}
        onDrop={
          flat
            ? undefined
            : (event) => {
                const dragged = event.dataTransfer.getData("application/x-kanbaner-note");
                if (dragged && event.target === event.currentTarget) {
                  onMove(dragged, null);
                }
              }
        }
      >
        {flat ? items.map((view) => renderNode(view, 0)) : roots.map((view) => renderNode(view, 0))}
      </ul>
      {items.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">Заметок пока нет</p>
      ) : null}
      <button
        type="button"
        data-testid="note-create-root"
        onClick={() => onCreate(null)}
        className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus aria-hidden="true" className="size-4" /> Новая страница
      </button>
    </div>
  );
}
