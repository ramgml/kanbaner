import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from "@milkdown/kit/core";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Ctx } from "@milkdown/kit/ctx";

import { readToolbarState, type NoteEditorToolbarState } from "./editor-actions.ts";

export interface CreateNoteEditorOptions {
  readonly root: HTMLElement;
  readonly markdown: string;
  readonly readOnly: boolean;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly editorId: string;
  readonly onMarkdownChange: (markdown: string) => void;
  readonly onToolbarStateChange: (state: NoteEditorToolbarState) => void;
}

function editorAttributes(options: CreateNoteEditorOptions): Record<string, string> {
  return {
    id: options.editorId,
    class: "kne-content",
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": options.ariaLabel,
    "aria-readonly": String(options.readOnly),
    "aria-disabled": String(options.disabled),
    spellcheck: "true",
    autocapitalize: "sentences",
  };
}

function observer(ctx: Ctx, options: CreateNoteEditorOptions): void {
  const refresh = (): void => {
    options.onToolbarStateChange(readToolbarState(ctx));
  };

  ctx
    .get(listenerCtx)
    .markdownUpdated((_ctx, markdown) => {
      options.onMarkdownChange(markdown);
    })
    .mounted(refresh)
    .updated(refresh)
    .selectionUpdated(refresh);
}

/**
 * Создаёт Milkdown Kit (CommonMark + GFM) с историей, clipboard и listener.
 * Crepe и дополнительные пресеты не используются.
 */
export async function createNoteEditor(options: CreateNoteEditorOptions): Promise<Editor> {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.root);
      ctx.set(defaultValueCtx, options.markdown);
      ctx.update(editorViewOptionsCtx, (previous) => ({
        ...previous,
        editable: () => !options.readOnly && !options.disabled,
        attributes: {
          ...previous.attributes,
          ...editorAttributes(options),
        },
      }));
      observer(ctx, options);
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(history)
    .use(clipboard)
    .create();
}

export async function destroyNoteEditor(editor: Editor): Promise<void> {
  try {
    await editor.destroy();
  } catch {
    // Редактор мог быть уже уничтожен StrictMode-циклом эффектов.
  }
}
