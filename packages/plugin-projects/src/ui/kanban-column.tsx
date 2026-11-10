"use client";

import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { TaskColumn } from "@kanbaner/plugin-tasks/contract";
import { LoadingState } from "@kanbaner/task-ui";

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
  readonly rename: KanbanColumnRenameState;
  readonly onRenameOpen: () => void;
  readonly onRenameValueChange: (value: string) => void;
  readonly onRenameSubmit: () => void;
  readonly onRenameCancel: () => void;
  readonly onMoveLeft: () => void;
  readonly onMoveRight: () => void;
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
  "min-h-10 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8";

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
  rename,
  onRenameOpen,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  onMoveLeft,
  onMoveRight,
  onDelete,
  onDragStart,
  onLoadMore,
  onRetry,
  quickComposer,
  children,
}: KanbanColumnProps) {
  return (
    <section
      id={`kanban-column-${slug}`}
      data-testid={`kanban-column-${slug}`}
      data-kanban-column={slug}
      data-kanban-column-id={column.id}
      data-column-slug={slug}
      aria-labelledby={`kanban-column-title-${slug}`}
      aria-busy={pending}
      className="flex max-h-full min-h-0 w-[85vw] max-w-[272px] shrink-0 snap-start flex-col gap-2 rounded-xl border bg-[#f1f5f9] p-2.5 transition-colors md:w-auto md:max-w-none md:min-w-[272px] md:flex-1 dark:bg-[#263244]"
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
              <span aria-hidden="true">⠿</span>
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

            <details data-testid={`kanban-column-menu-${slug}`} className="relative shrink-0">
              <summary
                aria-label={`Действия колонки «${column.title}»`}
                title="Действия колонки"
                className="flex min-h-10 min-w-8 cursor-pointer list-none items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-8 xl:min-w-7"
              >
                <span aria-hidden="true">⋯</span>
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
                  onClick={onRenameOpen}
                  className={menuItemClass}
                >
                  Переименовать
                </button>
                <button
                  type="button"
                  data-testid={`kanban-column-move-left-${slug}`}
                  disabled={pending || !canMoveLeft}
                  onClick={onMoveLeft}
                  className={menuItemClass}
                >
                  Переместить влево
                </button>
                <button
                  type="button"
                  data-testid={`kanban-column-move-right-${slug}`}
                  disabled={pending || !canMoveRight}
                  onClick={onMoveRight}
                  className={menuItemClass}
                >
                  Переместить вправо
                </button>
                <button
                  type="button"
                  data-testid={`kanban-column-delete-${slug}`}
                  disabled={pending || !canDelete}
                  title={deleteDisabledReason ?? undefined}
                  onClick={onDelete}
                  className={`${menuItemClass} text-destructive`}
                >
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
          className="flex flex-col gap-2"
          style={{ margin: 0, padding: 0, listStyle: "none" }}
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
