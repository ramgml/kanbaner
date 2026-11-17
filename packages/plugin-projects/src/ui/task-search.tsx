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
 * Доступное поле поиска задач с debounce.
 *
 * Ввод хранится локально и не перезаписывается устаревшей query string:
 * shell обновляет URL через router, поэтому `value` может прийти на один
 * рендер позже последнего нажатия. Пока пользователь печатает, локальный
 * черновик важнее внешнего значения; внешний сброс (или навигация без фокуса
 * в поле) очищает/заменяет черновик.
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
  const draftRef = useRef(value);
  const valueRef = useRef(value);
  const emittedRef = useRef(value);
  const [draft, setDraft] = useState(value);

  const cancelTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const emit = useCallback(
    (next: string): void => {
      if (next === valueRef.current) {
        emittedRef.current = next;

        return;
      }

      emittedRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  useEffect(() => {
    // Последнее значение prop для emit; обновляется после коммита, не в render.
    valueRef.current = value;

    if (value === draftRef.current) {
      emittedRef.current = value;

      return;
    }

    let next: string;

    // Пустое внешнее значение — явный сброс фильтров или очистка поиска.
    // Он важнее незавершённого debounce.
    if (value.length === 0) {
      cancelTimer();
      next = "";
    } else if (timerRef.current !== null) {
      return;
    } else if (
      // Устаревшее эхо router обычно является префиксом свежего ввода (или
      // наоборот при удалении). Пока поле в фокусе, такой откат не применяем.
      document.activeElement === inputRef.current &&
      (draftRef.current.startsWith(value) || value.startsWith(draftRef.current))
    ) {
      return;
    } else {
      cancelTimer();
      next = value;
    }

    draftRef.current = next;
    emittedRef.current = next;
    setDraft(next);
  }, [cancelTimer, value]);

  useEffect(() => cancelTimer, [cancelTimer]);

  const updateDraft = (next: string): void => {
    draftRef.current = next;
    setDraft(next);
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      emit(draftRef.current);
    }, debounceMs);
  };

  const clear = (): void => {
    cancelTimer();
    draftRef.current = "";
    setDraft("");
    emit("");
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
