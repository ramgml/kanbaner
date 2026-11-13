"use client";

import type { ComponentType, KeyboardEvent, MouseEvent } from "react";
import {
  Bold,
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Slash,
  SquareCode,
  Strikethrough,
  Table2,
  Undo2,
} from "lucide-react";

import type { NoteEditorActionId, NoteEditorToolbarState } from "./editor-actions.ts";

interface IconProps {
  readonly "aria-hidden"?: boolean;
  readonly size?: number;
}

type ActionIcon = ComponentType<IconProps>;

export const ACTION_ICONS: Record<NoteEditorActionId, ActionIcon> = {
  paragraph: Pilcrow,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  bold: Bold,
  italic: Italic,
  strikethrough: Strikethrough,
  inlineCode: Code,
  bulletList: List,
  orderedList: ListOrdered,
  taskList: ListChecks,
  toggleTaskChecked: CheckSquare,
  blockquote: Quote,
  codeBlock: SquareCode,
  table: Table2,
  divider: Minus,
  link: Link2,
  image: ImagePlus,
  undo: Undo2,
  redo: Redo2,
};

export const ACTION_LABELS: Record<NoteEditorActionId, string> = {
  paragraph: "Обычный текст",
  heading1: "Заголовок 1",
  heading2: "Заголовок 2",
  heading3: "Заголовок 3",
  bold: "Жирный",
  italic: "Курсив",
  strikethrough: "Зачёркнутый",
  inlineCode: "Код в строке",
  bulletList: "Маркированный список",
  orderedList: "Нумерованный список",
  taskList: "Список задач",
  toggleTaskChecked: "Отметить задачу",
  blockquote: "Цитата",
  codeBlock: "Блок кода",
  table: "Таблица",
  divider: "Разделитель",
  link: "Ссылка",
  image: "Изображение",
  undo: "Отменить",
  redo: "Повторить",
};

export interface NoteEditorToolbarProps {
  readonly state: NoteEditorToolbarState;
  readonly disabled: boolean;
  readonly editorId: string;
  readonly slashOpen: boolean;
  readonly onAction: (action: NoteEditorActionId) => void;
  readonly onLink: () => void;
  readonly onImage: () => void;
  readonly onOpenSlash: () => void;
}

interface ToolbarButtonProps {
  readonly action: NoteEditorActionId;
  readonly active?: boolean;
  readonly disabled: boolean;
  readonly onAction: (action: NoteEditorActionId) => void;
}

function ToolbarButton({ action, active = false, disabled, onAction }: ToolbarButtonProps) {
  const Icon = ACTION_ICONS[action];
  const label = ACTION_LABELS[action];

  return (
    <button
      type="button"
      data-action={action}
      data-active={active ? "true" : undefined}
      aria-label={label}
      aria-pressed={active ? "true" : undefined}
      title={label}
      disabled={disabled}
      onClick={() => {
        onAction(action);
      }}
    >
      <Icon aria-hidden size={18} />
    </button>
  );
}

function focusSiblingButton(event: KeyboardEvent<HTMLDivElement>, direction: 1 | -1): void {
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);

  if (current < 0) {
    return;
  }

  event.preventDefault();
  const next = (current + direction + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export function NoteEditorToolbar({
  state,
  disabled,
  editorId,
  slashOpen,
  onAction,
  onLink,
  onImage,
  onOpenSlash,
}: NoteEditorToolbarProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowRight") {
      focusSiblingButton(event, 1);
    } else if (event.key === "ArrowLeft") {
      focusSiblingButton(event, -1);
    }
  };

  const preventMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    // Сохраняем текущее выделение ProseMirror при клике по панели.
    if ((event.target as HTMLElement).closest("button")) {
      event.preventDefault();
    }
  };

  return (
    <div
      className="kne-toolbar"
      role="toolbar"
      aria-label="Форматирование заметки"
      aria-controls={editorId}
      onKeyDown={handleKeyDown}
      onMouseDown={preventMouseDown}
    >
      <ToolbarButton action="undo" disabled={disabled} onAction={onAction} />
      <ToolbarButton action="redo" disabled={disabled} onAction={onAction} />
      <span className="kne-separator" aria-hidden="true" />
      <ToolbarButton
        action="paragraph"
        active={state.heading === 0}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="heading1"
        active={state.heading === 1}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="heading2"
        active={state.heading === 2}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="heading3"
        active={state.heading === 3}
        disabled={disabled}
        onAction={onAction}
      />
      <span className="kne-separator" aria-hidden="true" />
      <ToolbarButton action="bold" active={state.bold} disabled={disabled} onAction={onAction} />
      <ToolbarButton
        action="italic"
        active={state.italic}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="strikethrough"
        active={state.strikeThrough}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="inlineCode"
        active={state.inlineCode}
        disabled={disabled}
        onAction={onAction}
      />
      <span className="kne-separator" aria-hidden="true" />
      <ToolbarButton
        action="bulletList"
        active={state.bulletList}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="orderedList"
        active={state.orderedList}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="taskList"
        active={state.taskList}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="toggleTaskChecked"
        disabled={disabled || !state.taskList}
        onAction={onAction}
      />
      <ToolbarButton
        action="blockquote"
        active={state.blockquote}
        disabled={disabled}
        onAction={onAction}
      />
      <ToolbarButton
        action="codeBlock"
        active={state.codeBlock}
        disabled={disabled}
        onAction={onAction}
      />
      <span className="kne-separator" aria-hidden="true" />
      <button
        type="button"
        data-action="link"
        data-active={state.link ? "true" : undefined}
        aria-label={ACTION_LABELS.link}
        title={ACTION_LABELS.link}
        aria-pressed={state.link ? "true" : undefined}
        disabled={disabled}
        onClick={onLink}
      >
        <Link2 aria-hidden size={18} />
      </button>
      <button
        type="button"
        data-action="image"
        aria-label={ACTION_LABELS.image}
        title={ACTION_LABELS.image}
        disabled={disabled}
        onClick={onImage}
      >
        <ImagePlus aria-hidden size={18} />
      </button>
      <ToolbarButton action="table" disabled={disabled} onAction={onAction} />
      <ToolbarButton action="divider" disabled={disabled} onAction={onAction} />
      <span className="kne-separator" aria-hidden="true" />
      <button
        type="button"
        data-action="openSlash"
        aria-label="Вставить блок"
        title="Вставить блок (/)"
        aria-expanded={slashOpen ? "true" : "false"}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={onOpenSlash}
      >
        <Slash aria-hidden size={18} />
      </button>
    </div>
  );
}
