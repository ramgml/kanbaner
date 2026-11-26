/**
 * Тонкая адаптация BlockNote к дизайн-токенам Kanbaner. Стандартные side menu,
 * formatting toolbar и slash menu остаются частью редактора.
 */
export const NOTE_EDITOR_STYLES = `
.kanbaner-note-editor {
  --kne-fg: var(--foreground, #18181b);
  --kne-muted: var(--muted-foreground, #6b7280);
  --kne-surface: var(--muted, #f4f4f5);
  --kne-accent: var(--accent, #eef2ff);
  --kne-ring: var(--ring, #6366f1);
  --kne-danger: var(--destructive, #b91c1c);
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--kne-fg);
  overflow: visible;
}

.kanbaner-note-editor *,
.kanbaner-note-editor *::before,
.kanbaner-note-editor *::after {
  box-sizing: border-box;
}

.kanbaner-note-editor .kne-surface {
  position: relative;
  min-width: 0;
  padding: 0.75rem 0.5rem;
}

.kanbaner-note-editor .kne-blocknote,
.kanbaner-note-editor .bn-container,
.kanbaner-note-editor .bn-editor {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  background: transparent;
  color: var(--kne-fg);
  font: inherit;
}

.kanbaner-note-editor .bn-editor {
  min-height: 220px;
  padding-inline: 0.5rem;
  overflow-wrap: anywhere;
  line-height: 1.65;
  outline: none;
}

.kanbaner-note-editor .bn-block-content,
.kanbaner-note-editor .bn-inline-content {
  max-width: 100%;
}

.kanbaner-note-editor .bn-block-content[data-content-type="paragraph"] {
  margin-block: 0.2rem;
}

.kanbaner-note-editor h1,
.kanbaner-note-editor h2,
.kanbaner-note-editor h3 {
  color: var(--kne-fg);
  line-height: 1.25;
}

.kanbaner-note-editor a {
  color: var(--primary, inherit);
  text-underline-offset: 2px;
}

.kanbaner-note-editor pre,
.kanbaner-note-editor code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.kanbaner-note-editor pre {
  max-width: 100%;
  overflow-x: auto;
}

.kanbaner-note-editor img {
  max-width: 100%;
  height: auto;
}

.kanbaner-note-editor .kne-inline-image {
  display: inline-block;
  max-height: 2.5em;
  max-width: 100%;
  vertical-align: middle;
}

.kanbaner-note-editor table {
  max-width: 100%;
}

.kanbaner-note-editor .bn-side-menu button,
.kanbaner-note-editor .bn-formatting-toolbar button,
.kanbaner-note-editor [role="menuitem"],
.kanbaner-note-editor [role="option"] {
  touch-action: manipulation;
}

.kanbaner-note-editor button:focus-visible,
.kanbaner-note-editor input:focus-visible {
  outline: 2px solid var(--kne-ring);
  outline-offset: 2px;
}

.kne-loading {
  margin: 0;
  padding: 0.8rem;
  color: var(--kne-muted);
  font-size: 0.9em;
}

.kne-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px 10px;
  color: var(--kne-muted);
  font-size: 0.85em;
}

.kne-status:empty {
  display: none;
}

.kne-status-error {
  color: var(--kne-danger);
}

.kanbaner-note-editor[data-read-only="true"] .bn-editor,
.kanbaner-note-editor[data-disabled="true"] .bn-editor {
  cursor: default;
}

.kanbaner-note-editor[data-disabled="true"] {
  opacity: 0.7;
}

@media (max-width: 480px) {
  .kanbaner-note-editor .kne-surface {
    padding: 0.5rem 0.25rem;
  }

  .kanbaner-note-editor .bn-editor {
    min-height: 180px;
    padding-inline: 0.25rem;
  }

  .kanbaner-note-editor .bn-side-menu button {
    min-width: 32px;
    min-height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kanbaner-note-editor *,
  .kanbaner-note-editor *::before,
  .kanbaner-note-editor *::after {
    transition: none !important;
    animation: none !important;
  }
}
`;
