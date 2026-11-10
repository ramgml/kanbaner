"use client";

import { useEffect, useRef, useState } from "react";

import type { TaskColumn } from "@kanbaner/plugin-tasks/contract";

import { TitleComposer, type TitleCreateResult } from "./title-composer.tsx";

export type QuickCreateResult = TitleCreateResult;

export interface KanbanQuickComposerProps {
  readonly column: TaskColumn;
  /** Безопасный суффикс test ID фактической колонки. */
  readonly slug: string;
  readonly projectId: string;
  readonly disabled: boolean;
  readonly onCreate: (columnId: string, title: string) => Promise<QuickCreateResult>;
  /** Открытие/закрытие composer: колонка скрывает дублирующий путь в форму. */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /** Увеличивается после создания из другой формы: очищает заголовок. */
  readonly resetToken?: number | undefined;
}

/**
 * Trello-like быстрый composer в начале колонки.
 *
 * Создание требует только название. Проект берётся из текущей доски, колонка —
 * из фактического заголовка, позицию определяет доменный append. Полная форма
 * доступна только для редактирования уже открытой карточки.
 */
export function KanbanQuickComposer({
  column,
  slug,
  projectId,
  disabled,
  onCreate,
  onOpenChange,
  resetToken = 0,
}: KanbanQuickComposerProps) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (open || !restoreFocusRef.current) {
      return;
    }

    restoreFocusRef.current = false;
    openerRef.current?.focus();
  }, [open]);

  const openComposer = (): void => {
    if (disabled) {
      return;
    }

    setOpen(true);
    onOpenChange?.(true);
  };

  const closeComposer = (): void => {
    restoreFocusRef.current = true;
    setOpen(false);
    onOpenChange?.(false);
  };

  const label = column.title;

  if (!open) {
    return (
      <button
        ref={openerRef}
        type="button"
        data-testid={`kanban-quick-add-${slug}`}
        aria-label={`Добавить карточку в колонку «${label}»`}
        title={disabled ? "Сначала создайте проект" : `Добавить карточку в колонку «${label}»`}
        disabled={disabled}
        onClick={openComposer}
        className={`inline-flex min-h-10 items-center justify-start rounded-md border border-transparent bg-transparent px-3 text-left text-sm font-medium text-muted-foreground hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 xl:min-h-8`}
      >
        <span aria-hidden="true" className="mr-1 text-base leading-none">
          +
        </span>
        Добавить карточку
      </button>
    );
  }

  return (
    <TitleComposer
      status={column.status}
      columnTitle={column.title}
      projectId={projectId}
      disabled={disabled}
      onCreate={(title) => onCreate(column.id, title)}
      onCancel={closeComposer}
      keepOpen
      testIdPrefix={`kanban-quick-add-${slug}`}
      resetToken={resetToken}
    />
  );
}
