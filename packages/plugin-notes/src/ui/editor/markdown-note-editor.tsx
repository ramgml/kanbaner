"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, ComponentType } from "react";
import { ru } from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/core/style.css";
import "@blocknote/shadcn/style.css";

import { prepareMarkdownForBlockNote, serializeBlockNoteMarkdown } from "./blocknote-markdown.ts";
import {
  imageUploadErrorMessage,
  isImageFile,
  markdownDocumentsEqual,
  sanitizeImageSource,
  validateLinkHref,
} from "./editor-markdown.ts";
import { NOTE_EDITOR_STYLES } from "./editor-styles.ts";

export interface MarkdownNoteEditorProps {
  /** Смена ID означает новый документ и пересоздание редактора. */
  readonly noteId: string;
  /** Текущий Markdown документа. */
  readonly value: string;
  /** Вызывается только при пользовательских изменениях. */
  readonly onChange: (markdown: string) => void;
  /** Загружает изображение и возвращает URL для image-узла. */
  readonly onUploadImage: (file: File) => Promise<string>;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

const DEFAULT_ARIA_LABEL = "Текст заметки";

interface EditorViewProps {
  readonly editor: object;
  readonly theme: "light" | "dark";
  readonly editable: boolean;
  readonly className: string;
  readonly onChange: () => void;
}

// BlockNote 0.54 не проходит exactOptionalPropertyTypes в собственных generic-типах.
// Приведение ограничено props представления; editor остаётся строго типизирован выше.
const EditorView = BlockNoteView as unknown as ComponentType<EditorViewProps>;

function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** BlockNote редактирует дерево блоков, но наружу уходит канонический Markdown. */
export function MarkdownNoteEditor({
  noteId,
  value,
  onChange,
  onUploadImage,
  readOnly = false,
  disabled = false,
  ariaLabel = DEFAULT_ARIA_LABEL,
}: MarkdownNoteEditorProps) {
  const editorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const uploadRef = useRef(onUploadImage);
  const lastEmittedRef = useRef(value);
  const initializedRef = useRef(false);
  const suppressChangeRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const locked = readOnly || disabled;

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    uploadRef.current = onUploadImage;
  });

  useEffect(() => {
    const refresh = () => setTheme(currentTheme());
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    refresh();
    return () => observer.disconnect();
  }, []);

  const uploadFile = useCallback(async (file: File) => uploadRef.current(file), []);

  const editor = useCreateBlockNote(
    {
      dictionary: ru,
      uploadFile,
      links: {
        isValidLink: (href) => validateLinkHref(href).ok,
      },
      domAttributes: {
        editor: {
          id: editorId,
          class: "kne-content",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": ariaLabel,
          spellcheck: "true",
          autocapitalize: "sentences",
        },
      },
    },
    [noteId, editorId],
  );

  useEffect(() => {
    let cancelled = false;
    initializedRef.current = false;
    suppressChangeRef.current = false;
    lastEmittedRef.current = valueRef.current;
    // Новый экземпляр BlockNote требует сброса внешнего состояния редактора;
    // это синхронизация с imperative-объектом, а не derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(false);
    setError(null);
    setUploading(false);

    try {
      const markdown = prepareMarkdownForBlockNote(valueRef.current);
      const blocks = markdown.length > 0 ? editor.tryParseMarkdownToBlocks(markdown) : [];
      editor.replaceBlocks(editor.document, blocks);
      lastEmittedRef.current = serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy());
      initializedRef.current = true;
      if (!cancelled) setReady(true);
    } catch {
      if (!cancelled) setError("Не удалось создать редактор заметки.");
    }

    return () => {
      cancelled = true;
    };
  }, [editor]);

  useEffect(() => {
    const content = rootRef.current?.querySelector<HTMLElement>(".bn-editor");
    content?.setAttribute("aria-readonly", String(readOnly));
    content?.setAttribute("aria-disabled", String(disabled));
  }, [disabled, readOnly, ready]);

  useEffect(() => {
    if (!ready || markdownDocumentsEqual(value, lastEmittedRef.current)) return;

    const current = serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy());
    if (markdownDocumentsEqual(value, current)) {
      lastEmittedRef.current = current;
      return;
    }

    suppressChangeRef.current = true;
    try {
      editor.replaceBlocks(
        editor.document,
        editor.tryParseMarkdownToBlocks(prepareMarkdownForBlockNote(value)),
      );
      lastEmittedRef.current = serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy());
    } catch {
      queueMicrotask(() => setError("Не удалось обновить содержимое редактора."));
    } finally {
      suppressChangeRef.current = false;
    }
  }, [editor, ready, value]);

  const uploadFiles = useCallback(
    async (files: readonly File[]) => {
      const images = files.filter(isImageFile);
      if (locked || images.length === 0) {
        if (files.length > 0 && images.length === 0) {
          setError("Можно загрузить только файл изображения.");
        }
        return;
      }

      setError(null);
      setUploading(true);
      try {
        for (const file of images) {
          const source = sanitizeImageSource(await uploadRef.current(file));
          if (source === null) throw new Error("Некорректный адрес изображения.");
          const imageBlock = { type: "image", props: { url: source, name: file.name } } as const;
          let reference: { readonly id: string } | undefined;
          try {
            reference = editor.getTextCursorPosition().block;
          } catch {
            reference = editor.document.at(-1);
          }
          if (reference === undefined) throw new Error("Не удалось создать блок изображения.");

          const current = editor.getBlock(reference.id);
          if (current?.type === "paragraph" && current.content.length === 0) {
            editor.setTextCursorPosition(editor.updateBlock(current, imageBlock), "end");
          } else {
            const [inserted] = editor.insertBlocks([imageBlock], reference, "after");
            if (inserted !== undefined) editor.setTextCursorPosition(inserted, "end");
          }
        }
      } catch (reason) {
        setError(imageUploadErrorMessage(reason));
      } finally {
        setUploading(false);
      }
    },
    [editor, locked],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) void uploadFiles(files);
  };

  return (
    <div
      ref={rootRef}
      className="kanbaner-note-editor"
      data-note-id={noteId}
      data-read-only={readOnly ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
    >
      <style data-kanbaner-note-editor-styles="true">{NOTE_EDITOR_STYLES}</style>
      <div className="kne-surface">
        <EditorView
          editor={editor}
          theme={theme}
          editable={!locked}
          className="kne-blocknote"
          onChange={() => {
            if (!initializedRef.current || suppressChangeRef.current) return;
            const markdown = serializeBlockNoteMarkdown(editor.blocksToMarkdownLossy());
            lastEmittedRef.current = markdown;
            onChangeRef.current(markdown);
          }}
        />
        {!ready && error === null ? (
          <p className="kne-loading" role="status">
            Загрузка редактора…
          </p>
        ) : null}
      </div>
      <div className="kne-status" role="status" aria-live="polite">
        {uploading ? <span>Загрузка изображения…</span> : null}
        {error !== null ? (
          <span className="kne-status-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <input
        ref={imageInputRef}
        data-testid="note-image-input"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        disabled={locked}
        hidden
        onChange={handleFileChange}
      />
    </div>
  );
}
