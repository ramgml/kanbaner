"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

export interface NoteTitleFieldProps {
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}

const titleClass =
  "mb-4 w-full min-w-0 resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-2 text-2xl font-semibold tracking-tight break-words [overflow-wrap:anywhere] focus-visible:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-3xl";

/**
 * Заголовок заметки в виде многострочного поля: текст переносится целиком,
 * высота растёт по содержимому, внутренней прокрутки нет. Домен запрещает
 * переводы строк в заголовке, поэтому Enter завершает редактирование, а
 * вставленный многострочный текст схлопывается в одну строку.
 */
export function NoteTitleField({ value, disabled = false, onChange }: NoteTitleFieldProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const element = fieldRef.current;
    if (element === null) return;
    element.style.height = "auto";
    // В jsdom scrollHeight всегда 0; не схлопываем поле до нулевой высоты.
    if (element.scrollHeight > 0) {
      // box-sizing: border-box, поэтому к scrollHeight нужно добавить рамку,
      // иначе внутри поля остаётся прокрутка на толщину border.
      const border = Math.max(0, element.offsetHeight - element.clientHeight);
      element.style.height = `${String(element.scrollHeight + border)}px`;
    }
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [fit, value, disabled]);

  // Ширина меняется при повороте экрана, открытии дерева и ресайзе окна:
  // после неё количество строк другое, поэтому высоту нужно пересчитать.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const element = fieldRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      fit();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [fit]);

  return (
    <textarea
      ref={fieldRef}
      aria-label="Заголовок заметки"
      data-testid="note-title"
      value={value}
      rows={1}
      disabled={disabled}
      placeholder="Без названия"
      onChange={(event) => onChange(event.target.value.replace(/\r\n?|\n/g, " "))}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.currentTarget.blur();
      }}
      className={titleClass}
    />
  );
}
