"use client";

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import type { BoardColor, TaskColumn } from "@kanbaner/plugin-tasks/contract";
import { LoadingState } from "@kanbaner/task-ui";

import {
  BOARD_COLOR_OPTIONS,
  boardColorSwatchClassName,
  boardColorSurface,
  resolveBoardColor,
} from "./board-colors.ts";

export interface KanbanColumnRenameState {
  readonly open: boolean;
  readonly value: string;
  readonly error: string | null;
  readonly submitting: boolean;
}

export interface KanbanColumnProps {
  readonly column: TaskColumn;
  readonly slug: string;
  readonly total: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly dragOver: boolean;
  /** В колонку сейчас будет вставлена карточка (placeholder уже в children). */
  readonly dropActive: boolean;
  readonly pending: boolean;
  readonly conflict: boolean;
  readonly canMoveLeft: boolean;
  readonly canMoveRight: boolean;
  readonly canDelete: boolean;
  readonly deleteDisabledReason: string | null;
  /** Ошибка color-only `column.update`; null — ошибки нет. */
  readonly colorError?: string | null;
  readonly rename: KanbanColumnRenameState;
  readonly onRenameOpen: () => void;
  readonly onRenameValueChange: (value: string) => void;
  readonly onRenameSubmit: () => void;
  readonly onRenameCancel: () => void;
  readonly onMoveLeft: () => void;
  readonly onMoveRight: () => void;
  readonly onColorSelect: (color: BoardColor) => void;
  readonly onDelete: () => void;
  readonly onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  /** Быстрый composer сразу под заголовком, вне прокручиваемого списка. */
  readonly quickComposer: ReactNode;
  readonly children: ReactNode;
}

const secondaryButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-background/70 px-2 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

const menuItemClass =
  "inline-flex min-h-10 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

const menuIconClass = "size-3.5 shrink-0";

/**
 * Колонка доски: заголовок, счётчик, меню действий, composer и список.
 *
 * Заголовок — общая top drop zone для карточек. Drag handle колонки находится
 * отдельно от карточек и запускает только reorder самой колонки.
 */
export function KanbanColumn({
  column,
  slug,
  total,
  loading,
  error,
  hasMore,
  dragOver,
  dropActive,
  pending,
  conflict,
  canMoveLeft,
  canMoveRight,
  canDelete,
  deleteDisabledReason,
  colorError = null,
  rename,
  onRenameOpen,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  onMoveLeft,
  onMoveRight,
  onColorSelect,
  onDelete,
  onDragStart,
  onLoadMore,
  onRetry,
  quickComposer,
  children,
}: KanbanColumnProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const columnColor = resolveBoardColor(column.color);
  const surface = boardColorSurface(columnColor);

  const closeMenu = (returnFocus: boolean): void => {
    const details = detailsRef.current;

    if (details === null) {
      return;
    }

    details.open = false;

    if (returnFocus) {
      summaryRef.current?.focus();
    }
  };

  // Нативный <details> сам не закрывается по клику вне или Escape.
  // Слушаем документ только пока меню открыто. Событие не перехватывается,
  // поэтому DnD, кнопки внутри меню и открытие другого меню не ломаются.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const details = detailsRef.current;

      if (details === null || !details.open) {
        return;
      }

      const target = event.target;

      if (target instanceof Node && details.contains(target)) {
        return;
      }

      details.open = false;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const details = detailsRef.current;

      if (details === null || !details.open || event.key !== "Escape") {
        return;
      }

      const target = event.target;
      const focusInsideMenu = target instanceof Node && details.contains(target);

      details.open = false;

      // Escape вне меню (например, в inline-редакторе карточки) только
      // закрывает меню. Событие не перехватывается и фокус не переносится,
      // поэтому активный контрол обрабатывает Escape сам.
      if (!focusInsideMenu) {
        return;
      }

      // Escape внутри меню относится только к меню: не доходит до окна и
      // других обработчиков, а фокус возвращается на видимый summary.
      event.preventDefault();
      event.stopPropagation();
      summaryRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return (
    <section
      id={`kanban-column-${slug}`}
      data-testid={`kanban-column-${slug}`}
      data-kanban-column={slug}
      data-kanban-column-id={column.id}
      data-column-slug={slug}
      aria-labelledby={`kanban-column-title-${slug}`}
      aria-busy={pending}
      className={`flex max-h-full min-h-0 w-[85vw] max-w-[272px] shrink-0 snap-start flex-col gap-2 rounded-xl border p-2.5 transition-colors md:w-[288px] md:min-w-[288px] md:max-w-[288px] md:flex-[0_0_288px] ${surface.columnClassName}`}
      style={{
        ...(dragOver
          ? { background: "color-mix(in oklab, var(--accent) 70%, var(--background))" }
          : {}),
        borderColor: dragOver ? "var(--ring)" : "var(--border)",
        boxShadow: dragOver ? "0 0 0 2px var(--ring)" : "none",
        opacity: pending ? 0.7 : 1,
      }}
    >
      <header
        data-kanban-drop-zone="top"
        className="flex shrink-0 items-start justify-between gap-1 px-0.5"
      >
        {rename.open ? (
          <form
            data-testid={`kanban-column-rename-form-${slug}`}
            aria-label={`Переименование колонки «${column.title}»`}
            className="flex min-w-0 flex-1 flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              onRenameSubmit();
            }}
          >
            <input
              autoFocus
              name="title"
              data-testid={`kanban-column-rename-input-${slug}`}
              aria-label="Новое название колонки"
              value={rename.value}
              maxLength={200}
              disabled={rename.submitting}
              onChange={(event) => {
                onRenameValueChange(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onRenameCancel();
                }
              }}
              className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:h-8"
            />

            {rename.error === null ? null : (
              <p
                role="alert"
                data-testid={`kanban-column-rename-error-${slug}`}
                className="m-0 text-[11px] text-destructive"
              >
                {rename.error}
              </p>
            )}

            <div className="flex flex-wrap gap-1">
              <button
                type="submit"
                data-testid={`kanban-column-rename-submit-${slug}`}
                disabled={
                  rename.submitting ||
                  rename.value.trim().length === 0 ||
                  rename.value.trim() === column.title
                }
                className="inline-flex min-h-10 items-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 xl:min-h-8"
              >
                Сохранить
              </button>
              <button
                type="button"
                data-testid={`kanban-column-rename-cancel-${slug}`}
                disabled={rename.submitting}
                onClick={onRenameCancel}
                className={secondaryButtonClass}
              >
                Отмена
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Перетащить колонку «${column.title}»`}
              data-testid={`kanban-column-drag-${slug}`}
              title="Перетащить колонку"
              onPointerDown={onDragStart}
              className="flex min-h-10 min-w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing xl:min-h-8 xl:min-w-7"
            >
              <GripVertical aria-hidden="true" className="size-4" />
            </button>

            <h2
              id={`kanban-column-title-${slug}`}
              data-testid={`kanban-column-title-${slug}`}
              className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight"
              title={column.title}
            >
              {column.title}
            </h2>

            <span
              data-testid={`kanban-count-${slug}`}
              aria-label={`Задач в колонке: ${String(total)}`}
              className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-semibold text-muted-foreground"
            >
              {total}
            </span>

            <details
              ref={detailsRef}
              data-testid={`kanban-column-menu-${slug}`}
              className="relative shrink-0"
            >
              <summary
                ref={summaryRef}
                aria-label={`Действия колонки «${column.title}»`}
                title="Действия колонки"
                className="flex min-h-10 min-w-8 cursor-pointer list-none items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-8 xl:min-w-7"
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </summary>
              <div
                role="group"
                aria-label={`Меню колонки «${column.title}»`}
                className="absolute top-full right-0 z-20 mt-1 flex w-[13rem] flex-col gap-1 rounded-md border border-border bg-popover p-1 shadow-md"
              >
                <button
                  type="button"
                  data-testid={`kanban-column-rename-${slug}`}
                  disabled={pending}
                  onClick={() => {
                    closeMenu(false);
                    onRenameOpen();
                  }}
                  className={menuItemClass}
                >
                  <Pencil aria-hidden="true" className={menuIconClass} />
                  Переименовать
                </button>
                <button
                  type="button"
                  data-testid={`kanban-column-move-left-${slug}`}
                  disabled={pending || !canMoveLeft}
                  onClick={() => {
                    closeMenu(true);
                    onMoveLeft();
                  }}
                  className={menuItemClass}
                >
                  <ArrowLeft aria-hidden="true" className={menuIconClass} />
                  Переместить влево
                </button>
                <button
                  type="button"
                  data-testid={`kanban-column-move-right-${slug}`}
                  disabled={pending || !canMoveRight}
                  onClick={() => {
                    closeMenu(true);
                    onMoveRight();
                  }}
                  className={menuItemClass}
                >
                  <ArrowRight aria-hidden="true" className={menuIconClass} />
                  Переместить вправо
                </button>
                <div
                  role="group"
                  aria-label={`Цвет колонки «${column.title}»`}
                  data-testid={`kanban-column-color-${slug}`}
                  className="flex flex-col gap-1 border-t border-border/70 pt-1"
                >
                  <p className="m-0 px-2 pt-1 text-[11px] font-medium text-muted-foreground">
                    Цвет колонки
                  </p>
                  <div className="grid grid-cols-2 gap-1">
                    {BOARD_COLOR_OPTIONS.map((option) => {
                      const selected = columnColor === option.value;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          data-testid={`kanban-column-color-${slug}-${option.value}`}
                          aria-label={`Цвет колонки: ${option.label}`}
                          aria-pressed={selected}
                          title={option.label}
                          disabled={pending}
                          onClick={() => {
                            // Выбор цвета — действие меню: оно закрывается, а
                            // фокус возвращается на видимый trigger.
                            closeMenu(true);
                            onColorSelect(option.value);
                          }}
                          className={`${menuItemClass} ${selected ? "bg-accent" : ""} min-w-0 px-1.5`}
                        >
                          <span
                            aria-hidden="true"
                            className={`size-3 shrink-0 rounded-full border border-black/10 ${boardColorSwatchClassName(option.value)}`}
                          />
                          <span className="truncate">{option.label}</span>
                          {selected ? (
                            <Check aria-hidden="true" className="ml-auto size-3 shrink-0" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid={`kanban-column-delete-${slug}`}
                  disabled={pending || !canDelete}
                  title={deleteDisabledReason ?? undefined}
                  onClick={() => {
                    closeMenu(true);
                    onDelete();
                  }}
                  className={`${menuItemClass} text-destructive`}
                >
                  <Trash2 aria-hidden="true" className={menuIconClass} />
                  Удалить колонку
                </button>
                {deleteDisabledReason === null ? null : (
                  <p className="m-0 px-2 pb-1 text-[11px] text-muted-foreground">
                    {deleteDisabledReason}
                  </p>
                )}
              </div>
            </details>
          </>
        )}
      </header>

      {conflict ? (
        <p
          role="alert"
          data-testid={`kanban-column-conflict-${slug}`}
          className="m-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
        >
          Конфликт версий
        </p>
      ) : null}

      {colorError === null ? null : (
        <p
          role="alert"
          data-testid={`kanban-column-color-error-${slug}`}
          className="m-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
        >
          {colorError}
        </p>
      )}

      {/*
        Composer идёт сразу под заголовком и вне прокручиваемого списка:
        кнопка создания остаётся на месте при любой длине колонки.
      */}
      <div
        data-testid={`kanban-quick-composer-${slug}`}
        data-kanban-drop-zone="top"
        className="flex shrink-0 flex-col gap-1"
      >
        {quickComposer}
      </div>

      {error === null ? null : (
        <div
          role="alert"
          data-testid={`kanban-column-error-${slug}`}
          className="flex shrink-0 flex-col gap-1 text-xs text-destructive"
        >
          <p className="m-0">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-10 w-fit rounded-md border border-destructive/40 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive xl:min-h-8"
          >
            Повторить
          </button>
        </div>
      )}

      {loading && total === 0 ? <LoadingState label={`Загрузка: ${column.title}`} /> : null}

      <div
        data-testid={`kanban-column-scroll-${slug}`}
        className="min-h-0 flex-1 overflow-y-auto pr-0.5"
      >
        {!loading && total === 0 && error === null && !dropActive ? (
          <div
            data-testid={`kanban-column-empty-${slug}`}
            className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border bg-background/40 p-4 text-center"
          >
            <p className="m-0 text-xs font-medium">Пусто</p>
            <p className="m-0 text-[11px] text-muted-foreground">
              Перетащите задачу сюда или создайте новую.
            </p>
          </div>
        ) : null}

        <ol
          data-testid={`kanban-cards-${slug}`}
          className="relative flex flex-col gap-2"
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            minHeight: dropActive && total === 0 ? "3rem" : undefined,
          }}
        >
          {children}
        </ol>

        {hasMore ? (
          <button
            type="button"
            data-testid={`kanban-load-more-${slug}`}
            disabled={loading}
            onClick={onLoadMore}
            className={`${secondaryButtonClass} mt-2 w-full`}
          >
            Показать ещё
          </button>
        ) : null}
      </div>
    </section>
  );
}
