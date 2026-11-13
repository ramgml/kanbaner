"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";

import {
  EMPTY_NOTE_EDITOR_TOOLBAR_STATE,
  NOTE_EDITOR_ACTIONS,
  applyNoteEditorLink,
  currentLinkHref,
  focusNoteEditor,
  insertNoteEditorImage,
  isCaretInEmptyBlock,
  readNoteEditorToolbarState,
  replaceNoteMarkdown,
  runNoteEditorAction,
  serializeNoteMarkdown,
  setNoteEditorReadOnly,
  toggleNoteEditorTaskAtPosition,
  type NoteEditorActionId,
  type NoteEditorToolbarState,
} from "./editor-actions.ts";
import { imageUploadErrorMessage, isImageFile, markdownDocumentsEqual } from "./editor-markdown.ts";
import { NOTE_EDITOR_STYLES } from "./editor-styles.ts";
import { NoteEditorToolbar } from "./editor-toolbar.tsx";
import { createNoteEditor, destroyNoteEditor } from "./create-note-editor.ts";
import { NoteEditorSlashMenu } from "./slash-menu.tsx";

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
  const linkInputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const uploadRef = useRef(onUploadImage);
  const readOnlyRef = useRef(readOnly);
  const disabledRef = useRef(disabled);
  const lockedRef = useRef(readOnly || disabled);
  const ariaLabelRef = useRef(ariaLabel);
  const lastEmittedRef = useRef(value);
  const suppressChangeRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [toolbarState, setToolbarState] = useState<NoteEditorToolbarState>(
    EMPTY_NOTE_EDITOR_TOOLBAR_STATE,
  );
  const [slashOpen, setSlashOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [menuLocked, setMenuLocked] = useState(readOnly || disabled);
  const locked = readOnly || disabled;

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    uploadRef.current = onUploadImage;
    readOnlyRef.current = readOnly;
    disabledRef.current = disabled;
    lockedRef.current = locked;
    ariaLabelRef.current = ariaLabel;
  });

  // Реакция на смену readOnly/disabled: закрываем открытые меню один раз.
  if (menuLocked !== locked) {
    setMenuLocked(locked);

    if (locked) {
      setSlashOpen(false);
      setLinkOpen(false);
    }
  }

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    let disposed = false;
    let created: Editor | null = null;

    setReady(false);
    setToolbarState(EMPTY_NOTE_EDITOR_TOOLBAR_STATE);
    setSlashOpen(false);
    setLinkOpen(false);
    setLinkError(null);
    setUploadError(null);
    setUploading(false);
    root.replaceChildren();
    lastEmittedRef.current = valueRef.current;

    void createNoteEditor({
      root,
      markdown: valueRef.current,
      readOnly: readOnlyRef.current,
      disabled: disabledRef.current,
      ariaLabel: ariaLabelRef.current,
      editorId,
      onMarkdownChange: (markdown) => {
        lastEmittedRef.current = markdown;

        if (!suppressChangeRef.current) {
          onChangeRef.current(markdown);
        }
      },
      onToolbarStateChange: (next) => {
        if (!disposed) {
          setToolbarState(next);
        }
      },
    })
      .then((editor) => {
        created = editor;

        if (disposed) {
          void destroyNoteEditor(editor);
          return;
        }

        editorRef.current = editor;
        setNoteEditorReadOnly(editor, {
          readOnly: readOnlyRef.current,
          disabled: disabledRef.current,
          ariaLabel: ariaLabelRef.current,
        });
        setToolbarState(readNoteEditorToolbarState(editor));
        setReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setUploadError("Не удалось создать редактор заметки.");
        }
      });

    return () => {
      disposed = true;
      const editor = editorRef.current;
      editorRef.current = null;

      if (editor) {
        void destroyNoteEditor(editor);
      } else if (created) {
        void destroyNoteEditor(created);
      }
    };
  }, [noteId, editorId]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor || !ready) {
      return;
    }

    setNoteEditorReadOnly(editor, { readOnly, disabled, ariaLabel });
  }, [ariaLabel, disabled, readOnly, ready]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor || !ready) {
      return;
    }

    if (markdownDocumentsEqual(value, lastEmittedRef.current)) {
      return;
    }

    const current = serializeNoteMarkdown(editor);

    if (markdownDocumentsEqual(value, current)) {
      lastEmittedRef.current = current;
      return;
    }

    suppressChangeRef.current = true;

    try {
      replaceNoteMarkdown(editor, value);
    } finally {
      suppressChangeRef.current = false;
    }
  }, [noteId, ready, value]);

  useEffect(() => {
    if (linkOpen) {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    }
  }, [linkOpen]);

  const openSlash = useCallback(() => {
    if (lockedRef.current || !editorRef.current) {
      return;
    }

    setLinkOpen(false);
    setLinkError(null);
    setUploadError(null);
    setSlashOpen(true);
  }, []);

  const closeSlash = useCallback(() => {
    setSlashOpen(false);
    const editor = editorRef.current;

    if (editor && !lockedRef.current) {
      focusNoteEditor(editor);
    }
  }, []);

  const openLink = useCallback(() => {
    const editor = editorRef.current;

    if (!editor || lockedRef.current) {
      return;
    }

    setLinkHref(currentLinkHref(editor));
    setLinkError(null);
    setSlashOpen(false);
    setUploadError(null);
    setLinkOpen(true);
  }, []);

  const closeLink = useCallback((restoreFocus = true) => {
    setLinkOpen(false);
    setLinkError(null);
    const editor = editorRef.current;

    if (restoreFocus && editor && !lockedRef.current) {
      focusNoteEditor(editor);
    }
  }, []);

  const applyLink = useCallback(() => {
    const editor = editorRef.current;

    if (!editor || lockedRef.current) {
      return;
    }

    const result = applyNoteEditorLink(editor, linkHref);

    if (!result.ok) {
      setLinkError(result.error);
      return;
    }

    setLinkOpen(false);
    setLinkError(null);
    focusNoteEditor(editor);
  }, [linkHref]);

  const runAction = useCallback(
    (action: NoteEditorActionId) => {
      const editor = editorRef.current;

      if (!editor || lockedRef.current) {
        return;
      }

      setUploadError(null);

      if (action === "link") {
        openLink();
        return;
      }

      if (action === "image") {
        setSlashOpen(false);
        imageInputRef.current?.click();
        return;
      }

      setSlashOpen(false);
      setLinkOpen(false);
      runNoteEditorAction(editor, action);
      focusNoteEditor(editor);
    },
    [openLink],
  );

  const uploadFiles = useCallback(async (files: readonly File[]) => {
    const editor = editorRef.current;
    const images = files.filter(isImageFile);

    if (!editor || lockedRef.current) {
      return;
    }

    if (images.length === 0) {
      setUploadError("Можно загрузить только файл изображения.");
      return;
    }

    setUploadError(null);
    setUploading(true);

    try {
      for (const file of images) {
        const url = await uploadRef.current(file);

        if (editorRef.current !== editor || lockedRef.current) {
          return;
        }

        if (!insertNoteEditorImage(editor, url, file.name)) {
          throw new Error("Некорректный адрес изображения.");
        }
      }
    } catch (error) {
      setUploadError(imageUploadErrorMessage(error));
    } finally {
      setUploading(false);

      if (editorRef.current === editor && !lockedRef.current) {
        focusNoteEditor(editor);
      }
    }
  }, []);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.currentTarget.files;
    event.currentTarget.value = "";

    if (files && files.length > 0) {
      void uploadFiles(Array.from(files));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (lockedRef.current) {
      return;
    }

    const target = event.target;

    if (target instanceof HTMLElement && target.closest("input, textarea")) {
      return;
    }

    const images = Array.from(event.clipboardData.files).filter(isImageFile);

    if (images.length > 0) {
      event.preventDefault();
      void uploadFiles(images);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (lockedRef.current) {
      return;
    }

    const target = event.target;

    if (target instanceof HTMLElement && target.closest("input, textarea")) {
      return;
    }

    const images = Array.from(event.dataTransfer.files).filter(isImageFile);

    if (images.length > 0) {
      event.preventDefault();
      void uploadFiles(images);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!lockedRef.current && event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
    }
  };

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;

    if (
      target instanceof HTMLElement &&
      target.closest("input, textarea, select, [role='dialog']")
    ) {
      return;
    }

    if (event.key === "Escape" && slashOpen) {
      event.preventDefault();
      closeSlash();
      return;
    }

    if (
      event.key === "/" &&
      !slashOpen &&
      !linkOpen &&
      !lockedRef.current &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const editor = editorRef.current;

      if (editor && isCaretInEmptyBlock(editor)) {
        event.preventDefault();
        openSlash();
      }
    }
  };

  const handlePointerDownCapture = (event: PointerEvent<HTMLDivElement>): void => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    if (slashOpen && !target.closest(".kne-slash")) {
      setSlashOpen(false);
    }

    if (linkOpen && !target.closest(".kne-link-dialog")) {
      setLinkOpen(false);
    }
  };

  const handleSurfaceClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (lockedRef.current) {
      return;
    }

    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const item = target.closest<HTMLElement>('li[data-item-type="task"]');

    if (!item || item !== target) {
      return;
    }

    const editor = editorRef.current;

    if (!editor) {
      return;
    }

    try {
      const position = editor.action((ctx) => ctx.get(editorViewCtx).posAtDOM(item, 0) + 1);
      const checked = item.dataset.checked === "true";

      if (toggleNoteEditorTaskAtPosition(editor, position, !checked)) {
        focusNoteEditor(editor);
      }
    } catch {
      // Если DOM-узел задачи уже перестроен, клик игнорируется.
    }
  };

  const handleLinkKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLink();
    }
  };

  return (
    <div
      className="kanbaner-note-editor"
      data-read-only={readOnly ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
      onKeyDownCapture={handleKeyDownCapture}
      onPointerDownCapture={handlePointerDownCapture}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <style data-kanbaner-note-editor-styles="true">{NOTE_EDITOR_STYLES}</style>
      <NoteEditorToolbar
        state={toolbarState}
        disabled={!ready || locked}
        editorId={editorId}
        slashOpen={slashOpen}
        onAction={runAction}
        onLink={openLink}
        onImage={() => {
          runAction("image");
        }}
        onOpenSlash={openSlash}
      />
      <div className="kne-surface" onClick={handleSurfaceClick}>
        <div ref={rootRef} />
        {!ready && (
          <p className="kne-slash-empty" role="status">
            Загрузка редактора…
          </p>
        )}
        {slashOpen && (
          <NoteEditorSlashMenu
            actions={NOTE_EDITOR_ACTIONS}
            onSelect={(action) => {
              setSlashOpen(false);
              runAction(action);
            }}
            onClose={closeSlash}
          />
        )}
        {linkOpen && (
          <div className="kne-link-dialog" role="dialog" aria-label="Ссылка">
            <label className="kne-sr-only" htmlFor={linkInputId}>
              Адрес ссылки
            </label>
            <input
              ref={linkInputRef}
              id={linkInputId}
              type="text"
              inputMode="url"
              placeholder="https://example.com"
              value={linkHref}
              aria-invalid={linkError ? "true" : "false"}
              onChange={(event) => {
                setLinkHref(event.target.value);
                setLinkError(null);
              }}
              onKeyDown={handleLinkKeyDown}
            />
            {linkError !== null && (
              <p className="kne-link-error" role="alert">
                {linkError}
              </p>
            )}
            <div className="kne-link-dialog-actions">
              <button type="button" data-primary="true" onClick={applyLink}>
                Применить
              </button>
              <button
                type="button"
                onClick={() => {
                  closeLink();
                }}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="kne-status" role="status" aria-live="polite">
        {uploading && <span>Загрузка изображения…</span>}
        {uploadError !== null && (
          <span className="kne-status-error" role="alert">
            {uploadError}
          </span>
        )}
      </div>
      <input
        ref={imageInputRef}
        data-testid="note-image-input"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        hidden
        onChange={handleFileChange}
      />
    </div>
  );
}
