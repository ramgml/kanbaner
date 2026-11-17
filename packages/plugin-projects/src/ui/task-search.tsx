"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { MAX_SEARCH_TEXT_LENGTH } from "@kanbaner/plugin-tasks/contract";

/** Задержка между последним нажатием и запросом списка. */
export const TASK_SEARCH_DEBOUNCE_MS = 275;

export interface TaskSearchProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly debounceMs?: number;
  readonly className?: string;
}

const inputClass =
  "h-9 w-full rounded-md border bg-background pr-9 pl-8 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

/**
 * Доступное поле поиска задач с локальным draft и debounce.
 *
 * Видимый ввод принадлежит полю, поэтому запоздалое эхо router не может
 * откатить набранный текст. Пока поле в фокусе, внешнее `value` не применяется;
 * blur синхронно фиксирует draft до click-действия (reset, открытие задачи,
 * переключение представления). Unmount только отменяет таймер.
 */
export function TaskSearch({
  value,
  onChange,
  disabled = false,
  debounceMs = TASK_SEARCH_DEBOUNCE_MS,
  className = "",
}: TaskSearchProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const committedRef = useRef(value);
  const focusedRef = useRef(false);
  const skipFlushOnBlurRef = useRef(false);

  const cancelTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const commit = useCallback(
    (next: string): void => {
      if (next === committedRef.current) {
        return;
      }

      committedRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const flush = useCallback((): void => {
    cancelTimer();
    commit(draftRef.current);
  }, [cancelTimer, commit]);

  /**
   * Back/forward меняет только URL и не даёт inline-события blur. Пока поле в
   * фокусе, обычный effect синхронизации намеренно молчит, поэтому внешний
   * `q` читается из location напрямую. Следующий blur не должен вернуть
   * прежний draft.
   */
  useEffect(() => {
    const onPopState = (): void => {
      cancelTimer();

      const next = (new URLSearchParams(window.location.search).get("q") ?? "").slice(
        0,
        MAX_SEARCH_TEXT_LENGTH,
      );

      draftRef.current = next;
      committedRef.current = next;

      if (focusedRef.current) {
        skipFlushOnBlurRef.current = true;
      }

      setDraft(next);
    };

    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [cancelTimer]);

  useEffect(() => {
    if (focusedRef.current) {
      return;
    }

    if (value === draftRef.current) {
      committedRef.current = value;

      return;
    }

    draftRef.current = value;
    committedRef.current = value;
    setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      cancelTimer();
    },
    [cancelTimer],
  );

  const updateDraft = (next: string): void => {
    draftRef.current = next;
    skipFlushOnBlurRef.current = false;
    setDraft(next);
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      commit(draftRef.current);
    }, debounceMs);
  };

  const clear = (): void => {
    cancelTimer();
    draftRef.current = "";
    committedRef.current = "";
    skipFlushOnBlurRef.current = false;
    setDraft("");
    onChange("");
    inputRef.current?.focus();
  };

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        Поиск задач
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          id={inputId}
          name="q"
          type="search"
          value={draft}
          disabled={disabled}
          maxLength={MAX_SEARCH_TEXT_LENGTH}
          placeholder="Название или описание"
          data-testid="task-search-input"
          onFocus={() => {
            focusedRef.current = true;
            skipFlushOnBlurRef.current = false;
          }}
          onBlur={() => {
            focusedRef.current = false;

            if (skipFlushOnBlurRef.current) {
              skipFlushOnBlurRef.current = false;

              return;
            }

            flush();
          }}
          onChange={(event) => {
            updateDraft(event.target.value);
          }}
          className={inputClass}
        />
        {draft.length === 0 ? null : (
          <button
            type="button"
            aria-label="Очистить поиск задач"
            data-testid="task-search-clear"
            disabled={disabled}
            onClick={clear}
            className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
