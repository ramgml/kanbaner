"use client";

import { useId, useRef } from "react";
import { Search, X } from "lucide-react";

import { MAX_SEARCH_TEXT_LENGTH } from "@kanbaner/plugin-tasks/contract";

export interface TaskSearchProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

const inputClass =
  "h-9 w-full rounded-md border bg-background pr-9 pl-8 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

/**
 * Доступное controlled-поле поиска задач.
 *
 * Каждое изменение немедленно уходит в query-state: локальный backend делает
 * это приемлемым, а отсутствие локального черновика и debounce исключает
 * гонки с reset, открытием задачи и навигацией по представлениям.
 */
export function TaskSearch({ value, onChange, disabled = false, className = "" }: TaskSearchProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

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
          value={value}
          disabled={disabled}
          maxLength={MAX_SEARCH_TEXT_LENGTH}
          placeholder="Название или описание"
          data-testid="task-search-input"
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={inputClass}
        />
        {value.length === 0 ? null : (
          <button
            type="button"
            aria-label="Очистить поиск задач"
            data-testid="task-search-clear"
            disabled={disabled}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
