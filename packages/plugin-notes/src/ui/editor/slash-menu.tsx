"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { NoteEditorActionDefinition, NoteEditorActionId } from "./editor-actions.ts";
import { ACTION_ICONS } from "./editor-toolbar.tsx";

export interface NoteEditorSlashMenuProps {
  readonly actions: readonly NoteEditorActionDefinition[];
  readonly onSelect: (action: NoteEditorActionId) => void;
  readonly onClose: () => void;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU");
}

export function filterNoteEditorActions(
  actions: readonly NoteEditorActionDefinition[],
  query: string,
): readonly NoteEditorActionDefinition[] {
  const normalized = normalize(query);

  if (normalized.length === 0) {
    return actions;
  }

  return actions.filter(
    (action) =>
      normalize(action.label).includes(normalized) ||
      action.keywords.some((keyword) => normalize(keyword).includes(normalized)),
  );
}

export function NoteEditorSlashMenu({ actions, onSelect, onClose }: NoteEditorSlashMenuProps) {
  const listboxId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => filterNoteEditorActions(actions, query), [actions, query]);
  const activeIndexClamped = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);
  const active = filtered[activeIndexClamped] ?? null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const select = (action: NoteEditorActionDefinition | null): void => {
    if (action === null) {
      return;
    }

    onSelect(action.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        setActiveIndex((index) => (index + 1) % filtered.length);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      select(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="kne-slash" role="dialog" aria-label="Вставить блок">
      <div className="kne-slash-search">
        <label className="kne-sr-only" htmlFor={inputId}>
          Найти блок
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={active ? `${listboxId}-${active.id}` : undefined}
          placeholder="Найти блок…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      {filtered.length > 0 ? (
        <ul className="kne-slash-list" id={listboxId} role="listbox" aria-label="Блоки">
          {filtered.map((action, index) => {
            const Icon = ACTION_ICONS[action.id];

            return (
              <li
                key={action.id}
                id={`${listboxId}-${action.id}`}
                className="kne-slash-option"
                role="option"
                aria-selected={index === activeIndexClamped ? "true" : "false"}
                onMouseEnter={() => {
                  setActiveIndex(index);
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  select(action);
                }}
              >
                <Icon aria-hidden size={16} />
                <span>{action.label}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="kne-slash-empty">Ничего не найдено. Попробуйте другой запрос.</p>
      )}
    </div>
  );
}
