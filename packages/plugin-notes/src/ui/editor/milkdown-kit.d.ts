/**
 * Типы Milkdown Kit для NodeNext.
 *
 * Пакет `@milkdown/kit` публикует `.d.ts` с относительными импортами без
 * расширений. При `moduleResolution: NodeNext` и `skipLibCheck: true`
 * TypeScript не видит реэкспорты и считает подмодули пустыми. Эти объявления
 * повторяют публичную поверхность Kit 7.23.0, которую использует редактор.
 * Реализация проверяется component- и roundtrip-тестами на реальном пакете.
 */

declare module "@milkdown/kit/ctx" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- параметр нужен для совместимости с оригинальным типом
  export interface SliceType<T, N extends string = string> {
    readonly id: symbol;
    readonly name: N;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- параметр нужен для совместимости с оригинальным типом
  export interface Slice<T, N extends string = string> {
    get(): T;
    set(value: T): void;
    update(updater: (previous: T) => T): void;
    on(watcher: (value: T) => unknown): () => void;
  }

  export class Ctx {
    get<T, N extends string>(slice: SliceType<T, N> | N): T;
    set<T, N extends string>(slice: SliceType<T, N> | N, value: T): void;
    update<T, N extends string>(slice: SliceType<T, N> | N, updater: (previous: T) => T): void;
  }

  export type MilkdownPlugin = unknown;
}

declare module "@milkdown/kit/prose/model" {
  export interface Mark {
    readonly type: MarkType;
    readonly attrs: Record<string, unknown>;
    eq(other: Mark): boolean;
  }

  export interface MarkType {
    readonly name: string;
    create(attrs?: Record<string, unknown>): Mark;
  }

  export interface NodeType {
    readonly name: string;
    create(attrs?: Record<string, unknown> | null, content?: unknown): Node;
  }

  export interface Fragment {
    readonly size: number;
    eq(other: Fragment): boolean;
    readonly firstChild: Node | null;
    childCount: number;
  }

  export interface Node {
    readonly type: NodeType;
    readonly attrs: Record<string, unknown>;
    readonly content: Fragment;
    readonly nodeSize: number;
    readonly isTextblock: boolean;
    readonly textContent: string;
    eq(other: Node): boolean;
    resolve(position: number): import("@milkdown/kit/prose/state").ResolvedPos;
    descendants(
      callback: (
        node: Node,
        pos: number,
        parent: Node | null,
        index: number,
      ) => boolean | undefined,
    ): void;
  }

  export interface Schema {
    readonly nodes: Record<string, NodeType>;
    readonly marks: Record<string, MarkType>;
    text(text: string, marks?: readonly Mark[]): Node;
  }

  export type Attrs = Record<string, unknown>;
}

declare module "@milkdown/kit/prose/state" {
  import type { Mark, Node, Schema } from "@milkdown/kit/prose/model";
  import type { EditorView } from "@milkdown/kit/prose/view";

  export interface ResolvedPos {
    readonly depth: number;
    readonly parent: Node;
    readonly parentOffset: number;
    marks(): readonly Mark[];
    node(depth?: number): Node;
    before(depth?: number): number;
  }

  export interface Selection {
    readonly empty: boolean;
    readonly from: number;
    readonly to: number;
    readonly $from: ResolvedPos;
    readonly $to: ResolvedPos;
  }

  export interface Transaction {
    readonly doc: Node;
    readonly selection: Selection;
    replaceWith(from: number, to: number, content: unknown): Transaction;
    replaceSelectionWith(node: Node, inheritMarks?: boolean): Transaction;
    insertText(text: string, from?: number, to?: number): Transaction;
    setNodeMarkup(
      pos: number,
      type?: import("@milkdown/kit/prose/model").NodeType | null,
      attrs?: Record<string, unknown> | null,
    ): Transaction;
    addMark(from: number, to: number, mark: Mark): Transaction;
    setMeta(key: string, value: unknown): Transaction;
    setSelection(selection: Selection): Transaction;
    delete(from: number, to: number): Transaction;
    scrollIntoView(): Transaction;
  }

  export interface EditorState {
    readonly doc: Node;
    readonly selection: Selection;
    readonly schema: Schema;
    readonly tr: Transaction;
    readonly storedMarks: readonly Mark[] | null;
  }

  export class TextSelection implements Selection {
    readonly empty: boolean;
    readonly from: number;
    readonly to: number;
    readonly $from: ResolvedPos;
    readonly $to: ResolvedPos;
    static near(pos: ResolvedPos, bias?: number): Selection;
  }

  export type Command = (
    state: EditorState,
    dispatch?: (transaction: Transaction) => void,
    view?: EditorView,
  ) => boolean;

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- повторяет класс из ProseMirror
  export class Plugin {
    constructor(spec: Record<string, unknown>);
  }
}

declare module "@milkdown/kit/prose/view" {
  import type { EditorState, Transaction } from "@milkdown/kit/prose/state";

  export interface DirectEditorProps {
    state: EditorState;
    editable?: (state: EditorState) => boolean;
    attributes?: Record<string, string>;
  }

  export class EditorView {
    state: EditorState;
    readonly editable: boolean;
    readonly dom: HTMLElement;
    dispatch(transaction: Transaction): void;
    focus(): void;
    setProps(props: Partial<DirectEditorProps>): void;
    posAtDOM(node: Node, offset?: number): number;
  }
}

declare module "@milkdown/kit/core" {
  import type { Ctx, MilkdownPlugin, SliceType } from "@milkdown/kit/ctx";
  import type { Node } from "@milkdown/kit/prose/model";
  import type { EditorState } from "@milkdown/kit/prose/state";
  import type { DirectEditorProps, EditorView } from "@milkdown/kit/prose/view";

  export type Config = (ctx: Ctx) => void | Promise<void>;

  export interface Editor {
    readonly ctx: Ctx;
    config(configure: Config): Editor;
    use(plugins: MilkdownPlugin | readonly MilkdownPlugin[]): Editor;
    create(): Promise<Editor>;
    destroy(clearPlugins?: boolean): Promise<Editor>;
    action<T>(action: (ctx: Ctx) => T): T;
  }

  export const Editor: { make(): Editor };

  export interface CommandDescriptor<T = undefined> {
    readonly key: SliceType<(payload?: T) => unknown, string>;
  }

  export interface CommandChain {
    run(): boolean;
    pipe<T>(command: CommandDescriptor<T>, payload?: T): CommandChain;
  }

  export interface CommandManager {
    call<T>(key: CommandDescriptor<T>["key"] | string, payload?: T): boolean;
    chain(): CommandChain;
  }

  export const rootCtx: SliceType<HTMLElement | string | null | undefined, "root">;
  export const defaultValueCtx: SliceType<
    string | { type: "html"; dom: HTMLElement } | { type: "json"; value: unknown },
    "defaultValue"
  >;
  export const editorStateCtx: SliceType<EditorState, "editorState">;
  export const editorViewCtx: SliceType<EditorView, "editorView">;
  export const serializerCtx: SliceType<(doc: Node) => string, "serializer">;
  export const parserCtx: SliceType<(markdown: string) => Node, "parser">;
  export const commandsCtx: SliceType<CommandManager, "commands">;
  export const editorViewOptionsCtx: SliceType<Partial<DirectEditorProps>, "editorViewOptions">;
}

declare module "@milkdown/kit/plugin/history" {
  import type { CommandDescriptor } from "@milkdown/kit/core";
  import type { MilkdownPlugin } from "@milkdown/kit/ctx";

  export const history: MilkdownPlugin[];
  export const undoCommand: CommandDescriptor;
  export const redoCommand: CommandDescriptor;
}

declare module "@milkdown/kit/plugin/clipboard" {
  import type { MilkdownPlugin } from "@milkdown/kit/ctx";

  export const clipboard: MilkdownPlugin;
}

declare module "@milkdown/kit/plugin/listener" {
  import type { MilkdownPlugin, SliceType } from "@milkdown/kit/ctx";
  import type { Node } from "@milkdown/kit/prose/model";
  import type { Selection } from "@milkdown/kit/prose/state";

  export interface ListenerManager {
    markdownUpdated(
      callback: (ctx: import("@milkdown/kit/ctx").Ctx, markdown: string, previous: string) => void,
    ): this;
    updated(
      callback: (ctx: import("@milkdown/kit/ctx").Ctx, doc: Node, previous: Node) => void,
    ): this;
    selectionUpdated(
      callback: (
        ctx: import("@milkdown/kit/ctx").Ctx,
        selection: Selection,
        previous: Selection | null,
      ) => void,
    ): this;
    mounted(callback: (ctx: import("@milkdown/kit/ctx").Ctx) => void): this;
  }

  export const listenerCtx: SliceType<ListenerManager, "listener">;
  export const listener: MilkdownPlugin;
}

declare module "@milkdown/kit/preset/commonmark" {
  import type { CommandDescriptor } from "@milkdown/kit/core";
  import type { MilkdownPlugin } from "@milkdown/kit/ctx";

  export const commonmark: MilkdownPlugin[];
  export const toggleStrongCommand: CommandDescriptor;
  export const toggleEmphasisCommand: CommandDescriptor;
  export const toggleInlineCodeCommand: CommandDescriptor;
  export const toggleLinkCommand: CommandDescriptor<{ href?: string; title?: string }>;
  export const wrapInHeadingCommand: CommandDescriptor<number>;
  export const turnIntoTextCommand: CommandDescriptor;
  export const wrapInBlockquoteCommand: CommandDescriptor;
  export const wrapInBulletListCommand: CommandDescriptor;
  export const wrapInOrderedListCommand: CommandDescriptor;
  export const liftListItemCommand: CommandDescriptor;
  export const createCodeBlockCommand: CommandDescriptor;
  export const insertHrCommand: CommandDescriptor;
  export const insertImageCommand: CommandDescriptor<{
    src?: string;
    title?: string;
    alt?: string;
  }>;
}

declare module "@milkdown/kit/preset/gfm" {
  import type { CommandDescriptor } from "@milkdown/kit/core";
  import type { MilkdownPlugin } from "@milkdown/kit/ctx";

  export const gfm: MilkdownPlugin[];
  export const toggleStrikethroughCommand: CommandDescriptor;
  export const insertTableCommand: CommandDescriptor<{ row?: number; col?: number }>;
}
