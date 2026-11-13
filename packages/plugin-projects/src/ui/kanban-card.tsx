"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  CalendarDays,
  Flag,
  ListTree,
  MoreHorizontal,
  MoveRight,
} from "lucide-react";

import type { Task, TaskColumn, TaskPriority } from "@kanbaner/plugin-tasks/contract";
import { taskPriorityLabel } from "@kanbaner/task-ui";

import { CardDescriptionTooltip } from "./card-description-tooltip.tsx";
import { computeMenuPosition, type MenuPosition } from "./card-menu.ts";
import { describeDue, type DueTone } from "./due.ts";

export type KanbanReorderKind = "up" | "down" | "start" | "end";

/**
 * Спокойные акценты приоритета без заливки всей карточки.
 *
 * Левая полоса и Lucide-флаг получают один тон: high — red, medium — amber,
 * low — green. Фон карточки остаётся обычным `--card`, поэтому контраст
 * текста/чекбокса/меню не зависит от приоритета.
 */
const PRIORITY_ACCENTS: Readonly<
  Record<
    TaskPriority,
    {
      readonly stripeColor: string;
      readonly badgeClassName: string;
      readonly iconClassName: string;
    }
  >
> = {
  low: {
    stripeColor: "color-mix(in oklab, #22c55e 82%, var(--card))",
    badgeClassName: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  medium: {
    stripeColor: "color-mix(in oklab, #f59e0b 86%, var(--card))",
    badgeClassName: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
  high: {
    stripeColor: "color-mix(in oklab, var(--destructive) 84%, var(--card))",
    badgeClassName: "bg-destructive/15 text-destructive",
    iconClassName: "text-destructive",
  },
};

const DUE_STYLES: Readonly<
  Record<DueTone, { readonly background: string; readonly color: string }>
> = {
  overdue: {
    background: "color-mix(in oklab, var(--destructive) 14%, transparent)",
    color: "var(--destructive)",
  },
  today: {
    background: "color-mix(in oklab, #f59e0b 18%, transparent)",
    color: "#a16207",
  },
  tomorrow: {
    background: "color-mix(in oklab, #3b82f6 14%, transparent)",
    color: "#1d4ed8",
  },
  later: { background: "transparent", color: "var(--muted-foreground)" },
  none: { background: "transparent", color: "var(--muted-foreground)" },
};

const actionButtonStyle = {
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  borderRadius: "6px",
  padding: "4px 8px",
  fontSize: "12px",
  cursor: "pointer",
} as const;

/**
 * Элементы, с которых карточка не начинает перетаскивание.
 *
 * Кнопка открытия — исключение: это осознанная drag-поверхность, которая
 * одновременно остаётся обычным элементом управления.
 */
const NON_DRAG_SELECTOR = [
  "a",
  "button",
  "input",
  "label",
  "textarea",
  `${"sel"}${"ect"}`,
  "summary",
  "details",
  '[contenteditable="true"]',
  '[contenteditable=""]',
  "[role='menu']",
  "[role='group']",
  "[data-card-menu]",
].join(",");

/** Одно открытое меню карточки на всю доску. */
let closeActiveCardMenu: (() => void) | null = null;

export interface KanbanCardProps {
  readonly task: Task;
  readonly index: number;
  readonly columnSize: number;
  /** Фактические колонки проекта; текущая исключается из меню. */
  readonly columns: readonly TaskColumn[];
  readonly currentColumnId: string;
  /** `null` — счётчик неизвестен из-за ошибки запроса, а не реальный ноль. */
  readonly subtaskCount: number | null;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly conflict: boolean;
  readonly dragging: boolean;
  /** Карточка входит в массовый выбор. */
  readonly bulkSelected?: boolean;
  /** Массовая операция выполняется: менять выбор нельзя. */
  readonly bulkDisabled?: boolean;
  readonly onBulkToggle?: (task: Task, selected: boolean) => void;
  readonly onOpen: (task: Task) => void;
  readonly onMoveTo: (task: Task, columnId: string) => void;
  readonly onReorder: (task: Task, kind: KanbanReorderKind) => void;
  readonly onDragStart: (task: Task, event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * Поглощает click, если перед ним карточку перетащили.
   *
   * Клик по заголовку по-прежнему открывает карточку; после настоящего drag
   * браузерный click на источнике подавляется до вызова `onOpen`.
   */
  readonly shouldSuppressClick?: (() => boolean) | undefined;
  /** Новое pointer-взаимодействие снимает устаревшее подавление click. */
  readonly onCardPointerDown?: (() => void) | undefined;
}

/**
 * Компактная карточка доски.
 *
 * Заголовок — главный элемент. Теги ограничены двумя видимыми + `+N`, срок
 * получает семантический тон (просрочено/сегодня/завтра/дата) и текстовое
 * описание, а pending/conflict занимают строку только пока актуальны.
 * В верхней строке слева находится чекбокс массового выбора, справа — меню.
 * Перетаскивание доступно за любую неинтерактивную область карточки и за
 * заголовок; меню «Переместить в…» и кнопки порядка остаются
 * альтернативой для клавиатуры и мобильного.
 */
export function KanbanCard({
  task,
  index,
  columnSize,
  columns,
  currentColumnId,
  subtaskCount,
  selected,
  pending,
  conflict,
  dragging,
  bulkSelected = false,
  bulkDisabled = false,
  onBulkToggle,
  onOpen,
  onMoveTo,
  onReorder,
  onDragStart,
  shouldSuppressClick,
  onCardPointerDown,
}: KanbanCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [descriptionTooltipOpen, setDescriptionTooltipOpen] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirstMenuRef = useRef(false);
  const descriptionTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descriptionTooltipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = `kanban-card-menu-${task.id}`;

  const priorityAccent = PRIORITY_ACCENTS[task.priority];
  const due = describeDue(task.dueAt);
  const dueStyle = DUE_STYLES[due.tone];
  const visibleTags = task.tags.slice(0, 2);
  const extraTags = task.tags.length - visibleTags.length;
  const moveTargets = columns.filter((column) => column.id !== currentColumnId);

  const hideDescriptionTooltip = useCallback((): void => {
    if (descriptionTooltipTimerRef.current !== null) {
      clearTimeout(descriptionTooltipTimerRef.current);
      descriptionTooltipTimerRef.current = null;
    }

    if (descriptionTooltipHideTimerRef.current !== null) {
      clearTimeout(descriptionTooltipHideTimerRef.current);
      descriptionTooltipHideTimerRef.current = null;
    }

    setDescriptionTooltipOpen(false);
  }, []);

  const scheduleDescriptionTooltipHide = useCallback((): void => {
    if (descriptionTooltipTimerRef.current !== null) {
      clearTimeout(descriptionTooltipTimerRef.current);
      descriptionTooltipTimerRef.current = null;
    }

    if (descriptionTooltipHideTimerRef.current !== null) {
      clearTimeout(descriptionTooltipHideTimerRef.current);
    }

    // Небольшая пауза позволяет перевести курсор с карточки на сам tooltip.
    descriptionTooltipHideTimerRef.current = setTimeout(() => {
      descriptionTooltipHideTimerRef.current = null;
      setDescriptionTooltipOpen(false);
    }, 150);
  }, []);

  const showDescriptionTooltip = useCallback(
    (delayed: boolean): void => {
      if (task.descriptionMarkdown.trim().length === 0) {
        return;
      }

      if (descriptionTooltipTimerRef.current !== null) {
        clearTimeout(descriptionTooltipTimerRef.current);
        descriptionTooltipTimerRef.current = null;
      }

      if (descriptionTooltipHideTimerRef.current !== null) {
        clearTimeout(descriptionTooltipHideTimerRef.current);
        descriptionTooltipHideTimerRef.current = null;
      }

      if (!delayed) {
        setDescriptionTooltipOpen(true);

        return;
      }

      descriptionTooltipTimerRef.current = setTimeout(() => {
        descriptionTooltipTimerRef.current = null;
        setDescriptionTooltipOpen(true);
      }, 400);
    },
    [task.descriptionMarkdown],
  );

  useEffect(() => {
    return () => {
      if (descriptionTooltipTimerRef.current !== null) {
        clearTimeout(descriptionTooltipTimerRef.current);
      }

      if (descriptionTooltipHideTimerRef.current !== null) {
        clearTimeout(descriptionTooltipHideTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!descriptionTooltipOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Tooltip не владеет событием: активный редактор/меню тоже получат Escape.
        hideDescriptionTooltip();
      }
    };

    const onScroll = (event: Event): void => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-card-description-scroll]") !== null
      ) {
        return;
      }

      hideDescriptionTooltip();
    };

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hideDescriptionTooltip);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hideDescriptionTooltip);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [descriptionTooltipOpen, hideDescriptionTooltip]);

  const closeMenu = useCallback((returnFocus: boolean, preventScroll = false): void => {
    focusFirstMenuRef.current = false;
    setMenuOpen(false);
    setMenuPosition(null);

    if (returnFocus) {
      if (preventScroll) {
        triggerRef.current?.focus({ preventScroll: true });
      } else {
        triggerRef.current?.focus();
      }
    }
  }, []);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") {
      // Меню не ловушка фокуса: Tab закрывает его и возвращает фокус на trigger.
      event.preventDefault();
      closeMenu(true);

      return;
    }

    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ??
        []),
    ];

    if (items.length === 0) {
      return;
    }

    const active = document.activeElement;
    const currentIndex = items.findIndex((item) => item === active);
    let nextIndex = currentIndex;

    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex =
        currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    items[nextIndex]?.focus();
  };

  // Одно открытое меню на доску: открытие нового закрывает предыдущее.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const close = (): void => {
      setMenuOpen(false);
      setMenuPosition(null);
    };

    closeActiveCardMenu?.();
    closeActiveCardMenu = close;

    return () => {
      if (closeActiveCardMenu === close) {
        closeActiveCardMenu = null;
      }
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) {
      return;
    }

    const update = (): void => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;

      if (trigger === null || menu === null) {
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();

      // Прокрутили карточку за пределы viewport — меню закрывается, а не
      // остаётся висеть над пустым местом.
      if (
        triggerRect.bottom < 0 ||
        triggerRect.top > window.innerHeight ||
        triggerRect.right < 0 ||
        triggerRect.left > window.innerWidth
      ) {
        focusFirstMenuRef.current = false;
        closeMenu(true, true);

        return;
      }

      const menuRect = menu.getBoundingClientRect();

      setMenuPosition(
        computeMenuPosition(triggerRect, menuRect.width, menuRect.height, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);

    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [closeMenu, menuOpen]);

  // После открытия и вычисления позиции фокус сразу попадает в первое
  // доступное действие, а не остаётся на trigger.
  useEffect(() => {
    if (!menuOpen || menuPosition === null || !focusFirstMenuRef.current) {
      return;
    }

    focusFirstMenuRef.current = false;

    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');

    first?.focus();
  }, [menuOpen, menuPosition]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (
        menuRef.current?.contains(target) === true ||
        triggerRef.current?.contains(target) === true
      ) {
        return;
      }

      closeMenu(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }

      // Меню не должно закрывать выбранную задачу или черновик под доской.
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeMenu, menuOpen]);

  const handleArticlePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    if (event.pointerType === "touch" && event.isPrimary === false) {
      return;
    }

    hideDescriptionTooltip();

    // Любое новое взаимодействие начинается с pointerdown: подавление click
    // относится только к click, сгенерированному завершившимся drag.
    onCardPointerDown?.();

    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const dragSurface = target.closest("[data-card-drag-allow]");
    const interactive = target.closest(NON_DRAG_SELECTOR);

    if (interactive !== null && dragSurface === null) {
      return;
    }

    // Блокируем drag только если выделение начато/закончено внутри этой
    // карточки. Выделение в другом месте страницы не мешает drag.
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;

    if (selection !== null && !selection.isCollapsed) {
      const article = event.currentTarget;
      const insideArticle = (node: Node | null): boolean => node !== null && article.contains(node);

      if (insideArticle(selection.anchorNode) || insideArticle(selection.focusNode)) {
        return;
      }
    }

    onDragStart(task, event);
  };

  const renderMenu = (): React.ReactNode => {
    if (!menuOpen || typeof document === "undefined") {
      return null;
    }

    return createPortal(
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={`Действия задачи ${task.title}`}
        data-testid={`kanban-card-menu-${task.id}`}
        data-card-menu
        data-placement={menuPosition?.placement ?? "bottom"}
        onKeyDown={onMenuKeyDown}
        onBlur={(event) => {
          const next = event.relatedTarget;

          if (
            next instanceof Node &&
            (menuRef.current?.contains(next) === true ||
              triggerRef.current?.contains(next) === true)
          ) {
            return;
          }

          closeMenu(false);
        }}
        className="fixed flex max-h-[calc(100vh-1rem)] w-[min(15rem,calc(100vw-1rem))] flex-col gap-1 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        style={{
          position: "fixed",
          zIndex: 60,
          top: menuPosition?.top ?? 0,
          left: menuPosition?.left ?? 0,
          visibility: menuPosition === null ? "hidden" : "visible",
        }}
      >
        {moveTargets.map((column) => (
          <button
            key={column.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid={`kanban-move-${task.id}-${column.id}`}
            disabled={pending}
            onClick={() => {
              closeMenu(true);
              onMoveTo(task, column.id);
            }}
            className="inline-flex min-h-10 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
            style={actionButtonStyle}
          >
            <MoveRight aria-hidden="true" className="size-3.5 shrink-0" />
            Переместить в {column.title}
          </button>
        ))}

        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={pending || index === 0}
          onClick={() => {
            closeMenu(true);
            onReorder(task, "up");
          }}
          className="inline-flex min-h-10 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
          style={actionButtonStyle}
        >
          <ArrowUp aria-hidden="true" className="size-3.5 shrink-0" />
          Выше
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={pending || index >= columnSize - 1}
          onClick={() => {
            closeMenu(true);
            onReorder(task, "down");
          }}
          className="inline-flex min-h-10 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
          style={actionButtonStyle}
        >
          <ArrowDown aria-hidden="true" className="size-3.5 shrink-0" />
          Ниже
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={pending || index === 0}
          onClick={() => {
            closeMenu(true);
            onReorder(task, "start");
          }}
          className="inline-flex min-h-10 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
          style={actionButtonStyle}
        >
          <ArrowUpToLine aria-hidden="true" className="size-3.5 shrink-0" />В начало
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={pending || index >= columnSize - 1}
          onClick={() => {
            closeMenu(true);
            onReorder(task, "end");
          }}
          className="inline-flex min-h-10 items-center gap-1.5 rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7"
          style={actionButtonStyle}
        >
          <ArrowDownToLine aria-hidden="true" className="size-3.5 shrink-0" />В конец
        </button>
      </div>,
      document.body,
    );
  };

  return (
    <article
      ref={cardRef}
      data-testid={`kanban-card-${task.id}`}
      data-card-id={task.id}
      data-priority={task.priority}
      aria-current={selected ? "true" : undefined}
      aria-busy={pending}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          showDescriptionTooltip(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") {
          scheduleDescriptionTooltipHide();
        }
      }}
      onPointerDown={handleArticlePointerDown}
      onClickCapture={(event) => {
        if (shouldSuppressClick?.() === true) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => {
        // Долгое нажатие на мобильном не должно открывать системное меню
        // вместо перетаскивания.
        event.preventDefault();
      }}
      className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-card-foreground transition-shadow"
      style={{
        borderColor: selected ? "var(--ring)" : "var(--border)",
        borderLeftColor: priorityAccent.stripeColor,
        borderLeftWidth: "3px",
        opacity: dragging || pending ? 0.62 : 1,
        boxShadow: selected ? "0 0 0 2px var(--ring)" : "0 1px 2px rgb(0 0 0 / 0.10)",
        touchAction: "auto",
        WebkitUserSelect: "none",
        userSelect: "none",
      }}
    >
      <div className="flex items-center justify-between gap-1">
        <label
          data-testid={`kanban-bulk-check-target-${task.id}`}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
          title="Выбрать задачу"
        >
          <input
            type="checkbox"
            data-testid={`kanban-bulk-check-${task.id}`}
            aria-label={`Выбрать задачу ${task.title}`}
            checked={bulkSelected}
            disabled={bulkDisabled}
            onChange={(event) => {
              onBulkToggle?.(task, event.target.checked);
            }}
            onClick={(event) => {
              // Клик по выбору не открывает карточку и не начинает drag.
              event.stopPropagation();
            }}
            className="size-4 cursor-pointer accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed"
          />
        </label>

        <button
          ref={triggerRef}
          type="button"
          data-testid={`kanban-menu-${task.id}`}
          data-card-menu
          aria-label={`Действия карточки ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          title="Действия карточки"
          onClick={() => {
            hideDescriptionTooltip();

            if (menuOpen) {
              closeMenu(true);
            } else {
              focusFirstMenuRef.current = true;
              setMenuPosition(null);
              setMenuOpen(true);
            }
          }}
          className="flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:min-h-7 xl:min-w-7"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </button>
      </div>

      <button
        type="button"
        aria-label={`Открыть карточку задачи ${task.title}`}
        aria-describedby={descriptionTooltipOpen ? `kanban-card-description-${task.id}` : undefined}
        data-testid={`kanban-open-${task.id}`}
        data-card-drag-allow
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) {
            showDescriptionTooltip(false);
          }
        }}
        onBlur={scheduleDescriptionTooltipHide}
        onClick={() => {
          hideDescriptionTooltip();
          onOpen(task);
        }}
        className="flex min-h-10 w-full min-w-0 items-center rounded-sm text-left text-sm leading-snug font-semibold break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 xl:min-h-7"
      >
        {task.title}
      </button>

      {visibleTags.length === 0 ? null : (
        <ul aria-label="Теги" className="flex flex-wrap items-center gap-1">
          {visibleTags.map((tag) => (
            <li
              key={tag}
              className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
            >
              {tag}
            </li>
          ))}
          {extraTags > 0 ? (
            <li
              aria-label={`Ещё тегов: ${String(extraTags)}`}
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              +{extraTags}
            </li>
          ) : null}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span
          data-testid={`kanban-priority-${task.id}`}
          data-priority={task.priority}
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold ${priorityAccent.badgeClassName}`}
        >
          <Flag aria-hidden="true" className={`size-3 ${priorityAccent.iconClassName}`} />
          {taskPriorityLabel(task.priority)}
        </span>

        <span
          data-testid={`kanban-due-${task.id}`}
          aria-label={due.ariaLabel}
          title={due.title}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium"
          style={{ background: dueStyle.background, color: dueStyle.color }}
        >
          <CalendarDays aria-hidden="true" className="size-3" />
          {due.label}
        </span>

        <span
          data-testid={`kanban-subtasks-${task.id}`}
          className="inline-flex items-center gap-1 whitespace-nowrap"
        >
          <ListTree aria-hidden="true" className="size-3" />
          Подзадачи: {subtaskCount ?? "—"}
        </span>
      </div>

      {pending || conflict ? (
        <div className="flex flex-wrap items-center gap-1">
          {pending ? (
            <span
              role="status"
              data-testid={`kanban-pending-${task.id}`}
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              Сохранение…
            </span>
          ) : null}

          {conflict ? (
            <span
              role="alert"
              data-testid={`kanban-conflict-${task.id}`}
              className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
            >
              Конфликт версий
            </span>
          ) : null}
        </div>
      ) : null}

      {descriptionTooltipOpen && !dragging && !menuOpen ? (
        <CardDescriptionTooltip
          taskId={task.id}
          description={task.descriptionMarkdown}
          anchorRef={cardRef}
          onKeepOpen={() => {
            showDescriptionTooltip(false);
          }}
          onRequestClose={scheduleDescriptionTooltipHide}
        />
      ) : null}

      {renderMenu()}
    </article>
  );
}
