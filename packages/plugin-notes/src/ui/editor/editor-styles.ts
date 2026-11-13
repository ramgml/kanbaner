/**
 * CSS редактора заметок. Строка встраивается в собственный DOM компонента,
 * поэтому пакет не требует отдельной точки подключения стилей у потребителя.
 */
export const NOTE_EDITOR_STYLES = `
.kanbaner-note-editor {
  --kne-bg: var(--background, #ffffff);
  --kne-fg: var(--foreground, #18181b);
  --kne-muted: var(--muted-foreground, #6b7280);
  --kne-border: var(--border, #d4d4d8);
  --kne-surface: var(--muted, #f4f4f5);
  --kne-accent: var(--accent, #eef2ff);
  --kne-accent-fg: var(--accent-foreground, #1f2937);
  --kne-primary: var(--primary, #1f2937);
  --kne-primary-fg: var(--primary-foreground, #ffffff);
  --kne-ring: var(--ring, #6366f1);
  --kne-danger: var(--destructive, #b91c1c);
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--kne-border);
  border-radius: 0.75rem;
  background: var(--kne-bg);
  color: var(--kne-fg);
  overflow: hidden;
}

.kanbaner-note-editor *,
.kanbaner-note-editor *::before,
.kanbaner-note-editor *::after {
  box-sizing: border-box;
}

.kanbaner-note-editor:focus-within {
  border-color: var(--kne-ring);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--kne-ring) 22%, transparent);
}

.kne-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px;
  border-bottom: 1px solid var(--kne-border);
  background: var(--kne-surface);
  min-width: 0;
}

.kne-toolbar button,
.kne-toolbar .kne-toolbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: 0.45rem;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
}

.kne-toolbar button:hover:not(:disabled),
.kne-toolbar .kne-toolbar-button:hover {
  background: var(--kne-bg);
  border-color: var(--kne-border);
}

.kne-toolbar button[data-active="true"] {
  background: var(--kne-accent);
  border-color: var(--kne-border);
  color: var(--kne-accent-fg);
}

.kne-toolbar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.kne-toolbar button:focus-visible,
.kne-toolbar .kne-toolbar-button:focus-visible,
.kne-slash button:focus-visible,
.kne-slash input:focus-visible,
.kne-link-dialog button:focus-visible,
.kne-link-dialog input:focus-visible {
  outline: 2px solid var(--kne-ring);
  outline-offset: 2px;
}

.kne-toolbar svg,
.kne-slash svg {
  width: 18px;
  height: 18px;
  flex: none;
}

.kne-separator {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--kne-border);
  flex: none;
}

.kne-surface {
  position: relative;
  min-width: 0;
  padding: 14px 16px;
}

.kne-content {
  min-height: 220px;
  max-width: 100%;
  outline: none;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.65;
}

.kne-content * {
  max-width: 100%;
}

.kne-content > *:first-child {
  margin-top: 0;
}

.kne-content > *:last-child {
  margin-bottom: 0;
}

.kne-content p {
  margin: 0.55em 0;
}

.kne-content h1,
.kne-content h2,
.kne-content h3,
.kne-content h4,
.kne-content h5,
.kne-content h6 {
  margin: 1.1em 0 0.45em;
  font-weight: 650;
  line-height: 1.25;
}

.kne-content h1 { font-size: 1.75em; }
.kne-content h2 { font-size: 1.4em; }
.kne-content h3 { font-size: 1.18em; }
.kne-content h4,
.kne-content h5,
.kne-content h6 { font-size: 1em; }

.kne-content ul,
.kne-content ol {
  margin: 0.55em 0;
  padding-left: 1.6em;
}

.kne-content li {
  margin: 0.2em 0;
}

.kne-content li > p {
  margin: 0.15em 0;
}

.kne-content blockquote {
  margin: 0.8em 0;
  padding: 0.15em 0 0.15em 0.9em;
  border-left: 3px solid var(--kne-border);
  color: var(--kne-muted);
}

.kne-content a {
  color: var(--kne-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}

.kne-content code {
  padding: 0.1em 0.35em;
  border-radius: 0.3em;
  background: var(--kne-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  overflow-wrap: anywhere;
}

.kne-content pre {
  max-width: 100%;
  margin: 0.8em 0;
  padding: 0.8em 1em;
  border: 1px solid var(--kne-border);
  border-radius: 0.55rem;
  background: var(--kne-surface);
  overflow-x: auto;
}

.kne-content pre code {
  padding: 0;
  background: transparent;
  white-space: pre;
  overflow-wrap: normal;
}

.kne-content hr {
  margin: 1.2em 0;
  border: 0;
  border-top: 1px solid var(--kne-border);
}

.kne-content img {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
}

.kne-content table,
.kne-content .tableWrapper {
  width: 100%;
  max-width: 100%;
}

.kne-content .tableWrapper {
  overflow-x: auto;
}

.kne-content table {
  margin: 0.8em 0;
  border-collapse: collapse;
  table-layout: fixed;
}

.kne-content th,
.kne-content td {
  padding: 0.4em 0.6em;
  border: 1px solid var(--kne-border);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.kne-content th {
  background: var(--kne-surface);
  font-weight: 600;
}

.kne-content li[data-item-type="task"] {
  position: relative;
  list-style: none;
  padding-left: 1.7em;
}

.kne-content li[data-item-type="task"]::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.34em;
  width: 1em;
  height: 1em;
  border: 1.5px solid var(--kne-muted);
  border-radius: 0.25em;
  background: transparent;
  cursor: pointer;
}

.kne-content li[data-item-type="task"][data-checked="true"]::before {
  border-color: var(--kne-primary);
  background: var(--kne-primary);
}

.kne-content li[data-item-type="task"][data-checked="true"]::after {
  content: "";
  position: absolute;
  left: 0.31em;
  top: 0.48em;
  width: 0.38em;
  height: 0.2em;
  border-left: 2px solid var(--kne-primary-fg);
  border-bottom: 2px solid var(--kne-primary-fg);
  transform: rotate(-45deg);
  pointer-events: none;
}

.kne-content li[data-item-type="task"][data-checked="true"] > p {
  color: var(--kne-muted);
  text-decoration: line-through;
}

.kne-slash {
  position: absolute;
  z-index: 20;
  top: 8px;
  left: 8px;
  width: min(320px, calc(100% - 16px));
  max-height: min(360px, 60vh);
  display: flex;
  flex-direction: column;
  overflow: auto;
  border: 1px solid var(--kne-border);
  border-radius: 0.65rem;
  background: var(--kne-bg);
  box-shadow: 0 16px 40px rgb(15 23 42 / 18%);
}

.kne-slash input,
.kne-link-dialog input {
  width: 100%;
  min-width: 0;
  padding: 0.55em 0.7em;
  border: 1px solid var(--kne-border);
  border-radius: 0.45rem;
  background: var(--kne-bg);
  color: var(--kne-fg);
  font: inherit;
}

.kne-slash-search {
  padding: 8px;
  border-bottom: 1px solid var(--kne-border);
  background: var(--kne-surface);
}

.kne-slash-list {
  margin: 0;
  padding: 4px;
  list-style: none;
}

.kne-slash-option {
  display: flex;
  align-items: center;
  gap: 0.6em;
  padding: 0.55em 0.65em;
  border-radius: 0.45rem;
  cursor: pointer;
  font-size: 0.92em;
}

.kne-slash-option[aria-selected="true"] {
  background: var(--kne-accent);
  color: var(--kne-accent-fg);
}

.kne-slash-empty {
  padding: 0.8em;
  color: var(--kne-muted);
  font-size: 0.9em;
}

.kne-link-dialog {
  position: absolute;
  z-index: 30;
  top: 8px;
  left: 8px;
  width: min(420px, calc(100% - 16px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--kne-border);
  border-radius: 0.65rem;
  background: var(--kne-bg);
  box-shadow: 0 16px 40px rgb(15 23 42 / 18%);
}

.kne-link-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.kne-link-dialog button {
  padding: 0.45em 0.7em;
  border: 1px solid var(--kne-border);
  border-radius: 0.45rem;
  background: var(--kne-surface);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.kne-link-dialog button[data-primary="true"] {
  border-color: var(--kne-primary);
  background: var(--kne-primary);
  color: var(--kne-primary-fg);
}

.kne-link-error {
  margin: 0;
  color: var(--kne-danger);
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

.kne-status-error {
  color: var(--kne-danger);
}

.kne-status-error:empty {
  display: none;
}

.kne-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.kanbaner-note-editor[data-read-only="true"] .kne-content,
.kanbaner-note-editor[data-disabled="true"] .kne-content {
  cursor: default;
}

.kanbaner-note-editor[data-disabled="true"] {
  opacity: 0.7;
}

@media (max-width: 480px) {
  .kne-toolbar {
    gap: 1px;
    padding: 4px;
  }

  .kne-toolbar button {
    min-width: 34px;
    min-height: 34px;
  }

  .kne-surface {
    padding: 10px 12px;
  }

  .kne-content {
    min-height: 180px;
  }

  .kne-separator {
    margin: 0 2px;
  }
}

@media (prefers-color-scheme: dark) {
  .kanbaner-note-editor {
    --kne-bg: var(--background, #18181b);
    --kne-fg: var(--foreground, #f4f4f5);
    --kne-muted: var(--muted-foreground, #a1a1aa);
    --kne-border: var(--border, #3f3f46);
    --kne-surface: var(--muted, #27272a);
    --kne-accent: var(--accent, #312e81);
    --kne-accent-fg: var(--accent-foreground, #eef2ff);
    --kne-primary: var(--primary, #e4e4e7);
    --kne-primary-fg: var(--primary-foreground, #18181b);
    --kne-ring: var(--ring, #818cf8);
    --kne-danger: var(--destructive, #f87171);
  }
}

.dark .kanbaner-note-editor {
  --kne-bg: var(--background, #18181b);
  --kne-fg: var(--foreground, #f4f4f5);
  --kne-muted: var(--muted-foreground, #a1a1aa);
  --kne-border: var(--border, #3f3f46);
  --kne-surface: var(--muted, #27272a);
  --kne-accent: var(--accent, #312e81);
  --kne-accent-fg: var(--accent-foreground, #eef2ff);
  --kne-primary: var(--primary, #e4e4e7);
  --kne-primary-fg: var(--primary-foreground, #18181b);
  --kne-ring: var(--ring, #818cf8);
  --kne-danger: var(--destructive, #f87171);
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
