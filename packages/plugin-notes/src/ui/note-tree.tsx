"use client";

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Plus, Star, Trash2 } from "lucide-react";

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
  /**
   * Полный набор страниц для расчёта siblings и позиций.
   *
   * Нужен фильтру «Избранное»: в дереве видны только избранные страницы, но
   * `note.move` и кнопки порядка обязаны считать позицию по полному набору
   * соседей, иначе скрытые страницы дадут неверный порядок.
   */
  readonly positionItems?: readonly NoteView[];
  /** Пока move в полёте, DnD, reorder и корневая зона недоступны. */
  readonly movePending?: boolean;
}

/** MIME-тип собственного drag-and-drop дерева заметок. */
const NOTE_DRAG_TYPE = "application/x-kanbaner-note";

/**
 * Зона drop относительно строки-цели.
 *
 * `inside` делает страницу ребёнком цели, `before`/`after` — соседом
 * (sibling) сверху или снизу. Зона в корне обрабатывается отдельной областью
 * и не является зоной строки.
 */
export type NoteDropZone = "before" | "inside" | "after";

/** Аргументы `note.move`, выведенные из зоны drop. */
export interface NoteMoveRequest {
  readonly parentId: string | null;
  readonly position?: number;
}

type DropHint =
  | { readonly kind: "item"; readonly id: string; readonly zone: NoteDropZone }
  | { readonly kind: "root" };

const buttonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Кнопка раскрытия ветки.
 *
 * Уже `buttonClass`: слева от названия помещается только она, поэтому компактный
 * размер уменьшает отступ корневых строк. Псевдоэлемент расширяет область
 * нажатия до 24×28 px, не занимая места в раскладке и не перекрывая название.
 * Для листьев тот же размер занимает невидимый spacer, чтобы названия соседей
 * оставались на одной вертикали.
 */
const disclosureButtonClass =
  "relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground before:absolute before:-inset-y-1 before:-left-1 before:w-6 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Кнопки overlay-панели действий.
 *
 * Панель не участвует в расчёте ширины строки и лежит поверх названия, поэтому
 * интерактивны только сами кнопки: клик между ними проходит к названию. На
 * desktop панель скрыта до hover/focus, на touch видна всегда.
 */
const actionButtonClass = `${buttonClass} pointer-events-auto lg:size-6 lg:pointer-events-none lg:group-hover:pointer-events-auto lg:focus-within:pointer-events-auto`;

/**
 * Зона drop по вертикали внутри строки: верхняя четверть — перед, нижняя —
 * после, середина — внутрь. При неизвестной высоте (например, в jsdom без
 * layout) безопасно выбирается «внутрь».
 */
export function noteDropZone(clientY: number, top: number, height: number): NoteDropZone {
  if (!Number.isFinite(height) || height <= 0) return "inside";
  const ratio = (clientY - top) / height;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

/**
 * Переводит drop в аргументы `note.move`.
 *
 * Позиция считается среди siblings цели без самой перемещаемой страницы, как
 * и в домене: `position` — индекс вставки в этот список. Для `inside`
 * возвращается `parentId` без `position`, то есть добавление в конец ветки.
 * `null` означает недопустимый drop (сама страница или неизвестная цель).
 */
export function noteMoveRequest(
  items: readonly NoteView[],
  draggedId: string,
  targetId: string,
  zone: NoteDropZone,
): NoteMoveRequest | null {
  if (draggedId === targetId) return null;
  if (!items.some((item) => item.note.id === draggedId)) return null;
  const target = items.find((item) => item.note.id === targetId);
  if (target === undefined) return null;
  if (zone === "inside") return { parentId: targetId };

  const siblings = items
    .filter((item) => item.note.parentId === target.note.parentId && item.note.id !== draggedId)
    .sort((left, right) => left.note.position - right.note.position);
  const index = siblings.findIndex((item) => item.note.id === targetId);
  if (index === -1) return null;

  return {
    parentId: target.note.parentId,
    position: zone === "before" ? index : index + 1,
  };
}

/** Текст drop-подсказки: дублирует цвет и форму визуального индикатора. */
function hintLabel(hint: DropHint): string {
  if (hint.kind === "root") return "Перемещение в корень: страница станет корневой";
  if (hint.zone === "inside") return "Перемещение внутрь: страница станет вложенной";
  return hint.zone === "before"
    ? "Перемещение перед страницей: порядок среди соседей"
    : "Перемещение после страницы: порядок среди соседей";
}

export function NoteTree({
  items,
  selectedId,
  onSelect,
  onCreate,
  onMove,
  onDelete,
  flat = false,
  positionItems,
  movePending = false,
}: NoteTreeProps) {
  const allItems = positionItems ?? items;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
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
  const fullById = useMemo(
    () => new Map(allItems.map((item) => [item.note.id, item] as const)),
    [allItems],
  );
  const fullByParent = useMemo(() => {
    const result = new Map<string | null, NoteView[]>();
    for (const item of allItems) {
      const siblings = result.get(item.note.parentId) ?? [];
      siblings.push(item);
      result.set(item.note.parentId, siblings);
    }
    for (const siblings of result.values()) {
      siblings.sort((left, right) => left.note.position - right.note.position);
    }
    return result;
  }, [allItems]);
  const fullRoots = useMemo(
    () =>
      allItems
        .filter((item) => item.note.parentId === null || !fullById.has(item.note.parentId))
        .sort((left, right) => left.note.position - right.note.position),
    [allItems, fullById],
  );
  const dndDisabled = flat || movePending;

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

  const clearDrag = () => {
    setDraggedId(null);
    setDropHint(null);
  };

  const dropOnItem = (dragged: string, targetId: string, zone: NoteDropZone) => {
    const request = noteMoveRequest(allItems, dragged, targetId, zone);
    clearDrag();
    if (request === null) return;
    // Цель раскрывается до обновления items: перенесённая страница сразу видна
    // внутри ветки, даже если до drop ветка была свёрнута.
    if (zone === "inside") {
      setExpanded((previous) => new Set([...previous, targetId]));
    }
    if (request.position === undefined) onMove(dragged, request.parentId);
    else onMove(dragged, request.parentId, request.position);
  };

  const itemDragOver = (event: DragEvent<HTMLElement>, id: string) => {
    if (!event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    // На себя drop не даёт содержательного результата, поэтому индикатор не
    // показывается, хотя событие остаётся отменённым для совместимости.
    if (draggedId === id) {
      setDropHint(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setDropHint({ kind: "item", id, zone: noteDropZone(event.clientY, rect.top, rect.height) });
  };

  const itemDrop = (event: DragEvent<HTMLElement>, id: string) => {
    const dragged = event.dataTransfer.getData(NOTE_DRAG_TYPE);
    if (dragged.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    dropOnItem(dragged, id, noteDropZone(event.clientY, rect.top, rect.height));
  };

  const rootDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropHint({ kind: "root" });
  };

  const rootDrop = (event: DragEvent<HTMLElement>) => {
    const dragged = event.dataTransfer.getData(NOTE_DRAG_TYPE);
    if (dragged.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    clearDrag();
    onMove(dragged, null);
  };

  const dropHintFor = (id: string): NoteDropZone | null =>
    dropHint?.kind === "item" && dropHint.id === id ? dropHint.zone : null;

  const renderNode = (view: NoteView, depth: number): ReactNode => {
    const id = view.note.id;
    const children = flat ? [] : (byParent.get(id) ?? []);
    const isExpanded = !flat && expanded.has(id);
    const siblings = fullByParent.get(view.note.parentId) ?? fullRoots;
    const index = siblings.findIndex((item) => item.note.id === id);
    const fullView = fullById.get(id) ?? view;
    const hint = dropHintFor(id);

    return (
      <li key={id}>
        <div
          data-note-tree-item={id}
          data-note-dragging={draggedId === id ? "true" : undefined}
          data-note-move-pending={movePending ? "true" : undefined}
          draggable={!dndDisabled}
          onDragStart={
            dndDisabled
              ? undefined
              : (event) => {
                  event.dataTransfer.setData(NOTE_DRAG_TYPE, id);
                  event.dataTransfer.effectAllowed = "move";
                  setDraggedId(id);
                  setDropHint(null);
                }
          }
          onDragEnd={dndDisabled ? undefined : clearDrag}
          onDragOver={dndDisabled ? undefined : (event) => itemDragOver(event, id)}
          onDragLeave={
            dndDisabled
              ? undefined
              : (event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && event.currentTarget.contains(next)) return;
                  setDropHint((current) =>
                    current?.kind === "item" && current.id === id ? null : current,
                  );
                }
          }
          onDrop={dndDisabled ? undefined : (event) => itemDrop(event, id)}
          className={`group relative flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pr-1 ${
            selectedId === id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
          }${flat ? "" : " cursor-grab active:cursor-grabbing"}${draggedId === id ? " opacity-60" : ""}`}
          style={{ paddingLeft: `${depth * 12 + 2}px` }}
        >
          {hint === "before" || hint === "after" ? (
            <div
              data-note-drop-indicator={hint}
              aria-hidden="true"
              className={`pointer-events-none absolute inset-x-0 z-20 flex items-center gap-1 ${
                hint === "before" ? "-top-1" : "-bottom-1"
              }`}
            >
              <span className="h-0.5 flex-1 rounded bg-primary" />
              <span className="rounded bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                {hint === "before" ? "Перед" : "После"}
              </span>
            </div>
          ) : null}
          {hint === "inside" ? (
            <div
              data-note-drop-indicator="inside"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-20 rounded-md ring-2 ring-primary ring-inset"
            >
              <span className="absolute -top-2 right-1 rounded bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                Внутрь
              </span>
            </div>
          ) : null}
          {flat ? null : children.length > 0 ? (
            <button
              type="button"
              data-note-expand={id}
              aria-label={
                isExpanded ? `Свернуть ${view.note.title}` : `Развернуть ${view.note.title}`
              }
              aria-expanded={isExpanded}
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              className={disclosureButtonClass}
            >
              {isExpanded ? (
                <ChevronDown aria-hidden="true" className="size-3.5" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-3.5" />
              )}
            </button>
          ) : (
            // Лист не тратит место на неактивную кнопку, но сохраняет ширину
            // раскрытия, иначе его название «прыгает» влево относительно веток.
            <span aria-hidden="true" data-note-expand-spacer={id} className="size-5 shrink-0" />
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
                  disabled={movePending || index <= 0}
                  onClick={() => onMove(id, fullView.note.parentId, index - 1)}
                  className={`${actionButtonClass} text-xs disabled:opacity-30`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Переместить ${view.note.title} ниже`}
                  disabled={movePending || index < 0 || index >= siblings.length - 1}
                  onClick={() => onMove(id, fullView.note.parentId, index + 1)}
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
        onDragOver={dndDisabled ? undefined : (event) => event.preventDefault()}
        onDragLeave={
          dndDisabled
            ? undefined
            : (event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                setDropHint(null);
              }
        }
        onDrop={
          dndDisabled
            ? undefined
            : (event) => {
                if (event.target !== event.currentTarget) return;
                rootDrop(event);
              }
        }
      >
        {flat ? items.map((view) => renderNode(view, 0)) : roots.map((view) => renderNode(view, 0))}
      </ul>
      {flat || items.length === 0 ? null : (
        <div
          data-note-root-drop
          data-note-drop-indicator={dropHint?.kind === "root" ? "root" : undefined}
          aria-disabled={movePending ? "true" : undefined}
          onDragOver={movePending ? undefined : rootDragOver}
          onDragLeave={
            movePending
              ? undefined
              : (event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && event.currentTarget.contains(next)) return;
                  setDropHint((current) => (current?.kind === "root" ? null : current));
                }
          }
          onDrop={movePending ? undefined : rootDrop}
          className={`mt-1 flex min-w-0 items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs ${
            dropHint?.kind === "root"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground"
          }${movePending ? " cursor-not-allowed opacity-50" : ""}`}
        >
          <span aria-hidden="true" className="text-sm leading-none">
            ↳
          </span>
          <span className="min-w-0 flex-1 truncate">
            {movePending
              ? "Перемещение выполняется…"
              : dropHint?.kind === "root"
                ? "Отпустите, чтобы сделать корневой"
                : "Сюда — переместить в корень"}
          </span>
        </div>
      )}
      {items.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">Заметок пока нет</p>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite" data-note-drop-status>
        {dropHint === null ? "" : hintLabel(dropHint)}
      </span>
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
