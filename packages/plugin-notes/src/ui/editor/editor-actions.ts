import type { Ctx } from "@milkdown/kit/ctx";
import {
  commandsCtx,
  editorStateCtx,
  editorViewCtx,
  parserCtx,
  serializerCtx,
  type CommandDescriptor,
  type Editor,
} from "@milkdown/kit/core";
import {
  createCodeBlockCommand,
  insertHrCommand,
  insertImageCommand,
  liftListItemCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";

import { sanitizeImageSource, validateLinkHref, type LinkValidation } from "./editor-markdown.ts";

export interface NoteEditorToolbarState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strikeThrough: boolean;
  readonly inlineCode: boolean;
  readonly link: boolean;
  readonly heading: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly bulletList: boolean;
  readonly orderedList: boolean;
  readonly taskList: boolean;
  readonly blockquote: boolean;
  readonly codeBlock: boolean;
}

export const EMPTY_NOTE_EDITOR_TOOLBAR_STATE: NoteEditorToolbarState = Object.freeze({
  bold: false,
  italic: false,
  strikeThrough: false,
  inlineCode: false,
  link: false,
  heading: 0,
  bulletList: false,
  orderedList: false,
  taskList: false,
  blockquote: false,
  codeBlock: false,
});

export type NoteEditorActionId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bold"
  | "italic"
  | "strikethrough"
  | "inlineCode"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "toggleTaskChecked"
  | "blockquote"
  | "codeBlock"
  | "table"
  | "divider"
  | "link"
  | "image"
  | "undo"
  | "redo";

export interface NoteEditorActionDefinition {
  readonly id: NoteEditorActionId;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly group: "history" | "block" | "inline" | "insert";
}

export const NOTE_EDITOR_ACTIONS: readonly NoteEditorActionDefinition[] = Object.freeze([
  { id: "paragraph", label: "Текст", keywords: ["текст", "paragraph", "абзац"], group: "block" },
  {
    id: "heading1",
    label: "Заголовок 1",
    keywords: ["заголовок", "heading", "h1", "1"],
    group: "block",
  },
  {
    id: "heading2",
    label: "Заголовок 2",
    keywords: ["заголовок", "heading", "h2", "2"],
    group: "block",
  },
  {
    id: "heading3",
    label: "Заголовок 3",
    keywords: ["заголовок", "heading", "h3", "3"],
    group: "block",
  },
  { id: "bold", label: "Жирный", keywords: ["жирный", "bold", "strong"], group: "inline" },
  { id: "italic", label: "Курсив", keywords: ["курсив", "italic", "emphasis"], group: "inline" },
  {
    id: "strikethrough",
    label: "Зачёркнутый",
    keywords: ["зачёркнутый", "strike", "strikethrough"],
    group: "inline",
  },
  { id: "inlineCode", label: "Код в строке", keywords: ["код", "code"], group: "inline" },
  { id: "bulletList", label: "Маркированный список", keywords: ["список", "list"], group: "block" },
  {
    id: "orderedList",
    label: "Нумерованный список",
    keywords: ["список", "list", "numbered"],
    group: "block",
  },
  {
    id: "taskList",
    label: "Список задач",
    keywords: ["задачи", "task", "checkbox", "чекбокс"],
    group: "block",
  },
  {
    id: "toggleTaskChecked",
    label: "Отметить задачу",
    keywords: ["задачи", "task", "готово", "checked"],
    group: "block",
  },
  { id: "blockquote", label: "Цитата", keywords: ["цитата", "quote"], group: "block" },
  { id: "codeBlock", label: "Блок кода", keywords: ["код", "code", "блок"], group: "block" },
  { id: "table", label: "Таблица", keywords: ["таблица", "table"], group: "insert" },
  {
    id: "divider",
    label: "Разделитель",
    keywords: ["разделитель", "линия", "divider"],
    group: "insert",
  },
  { id: "link", label: "Ссылка", keywords: ["ссылка", "link", "url"], group: "insert" },
  {
    id: "image",
    label: "Изображение",
    keywords: ["изображение", "image", "фото"],
    group: "insert",
  },
  { id: "undo", label: "Отменить", keywords: ["отменить", "undo"], group: "history" },
  { id: "redo", label: "Повторить", keywords: ["повторить", "redo"], group: "history" },
]);

interface Ancestor {
  readonly node: Node;
  readonly depth: number;
  readonly pos: number;
}

function findAncestor(state: EditorState, names: readonly string[]): Ancestor | null {
  const { $from } = state.selection;

  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);

    if (names.includes(node.type.name)) {
      return {
        node,
        depth,
        pos: depth === 0 ? 0 : $from.before(depth),
      };
    }
  }

  return null;
}

function callCommand<T>(ctx: Ctx, command: CommandDescriptor<T>, payload?: T): boolean {
  return ctx.get(commandsCtx).call(command.key, payload);
}

function toggleList(editor: Editor, kind: "bullet" | "ordered"): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const state = view.state;
    const listName = kind === "bullet" ? "bullet_list" : "ordered_list";
    const otherName = kind === "bullet" ? "ordered_list" : "bullet_list";
    const same = findAncestor(state, [listName]);

    if (same) {
      return callCommand(ctx, liftListItemCommand);
    }

    const other = findAncestor(state, [otherName]);
    const targetType = state.schema.nodes[listName];

    if (other && targetType) {
      const spread = other.node.attrs.spread === true;
      const attrs = kind === "ordered" ? { order: 1, spread } : { spread };
      const transaction = state.tr.setNodeMarkup(other.pos, targetType, attrs);
      view.dispatch(transaction);
      return true;
    }

    return callCommand(ctx, kind === "bullet" ? wrapInBulletListCommand : wrapInOrderedListCommand);
  });
}

function toggleTaskList(editor: Editor): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let state = view.state;
    let item = findAncestor(state, ["list_item"]);

    if (!item) {
      if (!callCommand(ctx, wrapInBulletListCommand)) {
        return false;
      }

      state = view.state;
      item = findAncestor(state, ["list_item"]);

      if (!item) {
        return false;
      }
    }

    const checked = item.node.attrs.checked == null ? false : null;
    view.dispatch(
      state.tr.setNodeMarkup(item.pos, undefined, {
        ...item.node.attrs,
        checked,
      }),
    );
    return true;
  });
}

function toggleTaskChecked(editor: Editor): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const state = view.state;
    const item = findAncestor(state, ["list_item"]);

    if (!item || typeof item.node.attrs.checked !== "boolean") {
      return false;
    }

    view.dispatch(
      state.tr.setNodeMarkup(item.pos, undefined, {
        ...item.node.attrs,
        checked: !item.node.attrs.checked,
      }),
    );
    return true;
  });
}

function toggleBlockquote(editor: Editor): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const state = view.state;
    const quote = findAncestor(state, ["blockquote"]);

    if (!quote) {
      return callCommand(ctx, wrapInBlockquoteCommand);
    }

    view.dispatch(
      state.tr.replaceWith(quote.pos, quote.pos + quote.node.nodeSize, quote.node.content),
    );
    return true;
  });
}

function toggleCodeBlock(editor: Editor): boolean {
  return editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state;
    const codeBlock = findAncestor(state, ["code_block"]);

    return callCommand(ctx, codeBlock ? turnIntoTextCommand : createCodeBlockCommand);
  });
}

/** Выполняет действие панели инструментов или slash-меню. */
export function runNoteEditorAction(editor: Editor, action: NoteEditorActionId): boolean {
  switch (action) {
    case "paragraph":
      return editor.action((ctx) => callCommand(ctx, turnIntoTextCommand));
    case "heading1":
      return editor.action((ctx) => callCommand(ctx, wrapInHeadingCommand, 1));
    case "heading2":
      return editor.action((ctx) => callCommand(ctx, wrapInHeadingCommand, 2));
    case "heading3":
      return editor.action((ctx) => callCommand(ctx, wrapInHeadingCommand, 3));
    case "bold":
      return editor.action((ctx) => callCommand(ctx, toggleStrongCommand));
    case "italic":
      return editor.action((ctx) => callCommand(ctx, toggleEmphasisCommand));
    case "strikethrough":
      return editor.action((ctx) => callCommand(ctx, toggleStrikethroughCommand));
    case "inlineCode":
      return editor.action((ctx) => callCommand(ctx, toggleInlineCodeCommand));
    case "bulletList":
      return toggleList(editor, "bullet");
    case "orderedList":
      return toggleList(editor, "ordered");
    case "taskList":
      return toggleTaskList(editor);
    case "toggleTaskChecked":
      return toggleTaskChecked(editor);
    case "blockquote":
      return toggleBlockquote(editor);
    case "codeBlock":
      return toggleCodeBlock(editor);
    case "table":
      return editor.action((ctx) => callCommand(ctx, insertTableCommand, { row: 3, col: 3 }));
    case "divider":
      return editor.action((ctx) => callCommand(ctx, insertHrCommand));
    case "undo":
      return editor.action((ctx) => callCommand(ctx, undoCommand));
    case "redo":
      return editor.action((ctx) => callCommand(ctx, redoCommand));
    case "link":
    case "image":
      return false;
  }
}

export function readToolbarState(ctx: Ctx): NoteEditorToolbarState {
  const state = ctx.get(editorStateCtx);
  const { $from } = state.selection;
  const marks = state.storedMarks ?? $from.marks();
  const hasMark = (name: string): boolean => marks.some((mark) => mark.type.name === name);
  const headingNode = $from.parent.type.name === "heading" ? $from.parent : null;
  const level = Number(headingNode?.attrs.level ?? 0);
  const heading: NoteEditorToolbarState["heading"] =
    level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6
      ? level
      : 0;
  const taskItem = findAncestor(state, ["list_item"]);

  return {
    bold: hasMark("strong"),
    italic: hasMark("emphasis"),
    strikeThrough: hasMark("strike_through"),
    inlineCode: hasMark("inlineCode"),
    link: hasMark("link"),
    heading,
    bulletList: findAncestor(state, ["bullet_list"]) !== null,
    orderedList: findAncestor(state, ["ordered_list"]) !== null,
    taskList: taskItem !== null && taskItem.node.attrs.checked != null,
    blockquote: findAncestor(state, ["blockquote"]) !== null,
    codeBlock: $from.parent.type.name === "code_block",
  };
}

export function readNoteEditorToolbarState(editor: Editor): NoteEditorToolbarState {
  return editor.action(readToolbarState);
}

export function serializeNoteMarkdown(editor: Editor): string {
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorStateCtx).doc));
}

/**
 * Применяет внешнюю версию Markdown без пересоздания редактора. Выделение
 * переносится в ближайшую допустимую позицию, история не засоряется.
 */
export function replaceNoteMarkdown(editor: Editor, markdown: string): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    const nextDoc = parser(markdown);
    const state = view.state;

    if (nextDoc.eq(state.doc)) {
      return false;
    }

    const previousFrom = state.selection.from;
    const transaction = state.tr.replaceWith(0, state.doc.content.size, nextDoc.content);
    const maxPosition = transaction.doc.content.size;
    const position = Math.max(0, Math.min(previousFrom, maxPosition));
    transaction.setMeta("addToHistory", false);

    try {
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(position)));
    } catch {
      // Если позиция не разрешается, ProseMirror оставит безопасное выделение
      // после замены документа.
    }

    view.dispatch(transaction);
    return true;
  });
}

export function setNoteEditorReadOnly(
  editor: Editor,
  options: { readOnly: boolean; disabled: boolean; ariaLabel: string },
): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const editable = (): boolean => !options.readOnly && !options.disabled;

    view.setProps({ editable });
    view.dom.setAttribute("aria-label", options.ariaLabel);
    view.dom.setAttribute("aria-readonly", String(options.readOnly));
    view.dom.setAttribute("aria-disabled", String(options.disabled));
  });
}

export function focusNoteEditor(editor: Editor): void {
  editor.action((ctx) => {
    ctx.get(editorViewCtx).focus();
  });
}

export function isCaretInEmptyBlock(editor: Editor): boolean {
  return editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state;
    const { selection } = state;

    return (
      selection.empty &&
      selection.$from.parent.isTextblock &&
      selection.$from.parent.content.size === 0
    );
  });
}

export function currentLinkHref(editor: Editor): string {
  return editor.action((ctx) => {
    const state = ctx.get(editorStateCtx);
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const link = marks.find((mark) => mark.type.name === "link");
    const href = link?.attrs.href;

    return typeof href === "string" ? href : "";
  });
}

export function applyNoteEditorLink(editor: Editor, rawHref: string): LinkValidation {
  const validation = validateLinkHref(rawHref);

  if (!validation.ok) {
    return validation;
  }

  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const state = view.state;
    const { selection, schema } = state;
    const linkType = schema.marks.link;

    if (!linkType) {
      return false;
    }

    if (selection.empty) {
      const mark = linkType.create({ href: validation.href });
      const text = schema.text(validation.href, [mark]);
      view.dispatch(state.tr.replaceSelectionWith(text, false));
      return true;
    }

    return callCommand(ctx, toggleLinkCommand, { href: validation.href });
  });

  return validation;
}

/** Вставляет изображение только после успешной проверки URL. */
export function insertNoteEditorImage(editor: Editor, rawSrc: string, alt: string): boolean {
  const src = sanitizeImageSource(rawSrc);

  if (src === null) {
    return false;
  }

  return editor.action((ctx) =>
    callCommand(ctx, insertImageCommand, { src, alt: alt.slice(0, 200) }),
  );
}

export function toggleNoteEditorTaskAtPosition(
  editor: Editor,
  position: number,
  checked: boolean,
): boolean {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const state = view.state;
    const $position = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
    let item: { node: Node; pos: number } | null = null;

    for (let depth = $position.depth; depth >= 0; depth -= 1) {
      const node = $position.node(depth);
      if (node.type.name === "list_item" && node.attrs.checked != null) {
        item = { node, pos: depth === 0 ? 0 : $position.before(depth) };
        break;
      }
    }

    if (!item) {
      return false;
    }

    const transaction: Transaction = state.tr.setNodeMarkup(item.pos, undefined, {
      ...item.node.attrs,
      checked,
    });
    view.dispatch(transaction);
    return true;
  });
}
