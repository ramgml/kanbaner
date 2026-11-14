import { markdownToHTML, type BlockNoteEditor } from "@blocknote/core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { normalizeMarkdownDocument, validateLinkHref } from "./editor-markdown.ts";

interface MarkdownPosition {
  readonly start?: { readonly offset?: number };
  readonly end?: { readonly offset?: number };
}

interface MarkdownNode {
  readonly type?: string;
  readonly identifier?: string;
  readonly url?: string;
  readonly title?: string | null;
  readonly alt?: string | null;
  readonly value?: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?: MarkdownPosition;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const INLINE_IMAGE_TYPE = "inlineImage";
const LINKED_IMAGE_TYPE = "linkedImage";

function parseMarkdown(markdown: string): MarkdownNode {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MarkdownNode;
}

function offsets(node: MarkdownNode): readonly [number, number] | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined || end <= start ? null : [start, end];
}

function visit(node: MarkdownNode, callback: (node: MarkdownNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

/** Экранирует alt так, чтобы image оставался разбираемым Markdown. */
export function escapeImageAlt(alt: string): string {
  return alt.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}

/** Нормализует alt/имя файла так, чтобы Markdown оставался разбираемым. */
export function sanitizeImageAlt(name: string): string {
  const normalized = name
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/[\\[\]()`<>]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return normalized.length > 0 ? normalized.slice(0, 240) : "image";
}

function escapeDestination(url: string): string {
  return /[\s()]/u.test(url) ? `<${url.replace(/</gu, "%3C").replace(/>/gu, "%3E")}>` : url;
}

function inlineImageMarkdown(alt: string, url: string, title: string | null | undefined): string {
  const titlePart =
    title === null || title === undefined ? "" : ` "${title.replace(/"/gu, '\\"')}"`;
  return `![${escapeImageAlt(alt)}](${escapeDestination(url)}${titlePart})`;
}

function codeSpan(source: string): string {
  const fence = "`".repeat(
    Math.max(1, ...Array.from(source.matchAll(/`+/gu), (m) => m[0].length)) + 1,
  );
  const padding =
    source.startsWith("`") ||
    source.endsWith("`") ||
    source.startsWith(" ") ||
    source.endsWith(" ") ||
    source.startsWith("\n") ||
    source.endsWith("\n")
      ? " "
      : "";

  return `${fence}${padding}${source}${padding}${fence}`;
}

function fencedCode(source: string): string {
  const matches = Array.from(source.matchAll(/^(`{3,}|~{3,})/gmu), (m) => m[0]);
  const longest = matches.reduce((length, match) => Math.max(length, match.length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${source}\n${fence}`;
}

/**
 * HTML нельзя отдать BlockNote: он его выбрасывает, и при следующем
 * автосохранении исходный текст исчезает. Показываем HTML литеральным кодом,
 * который не исполняется браузером и переживает сериализацию.
 */
function literalHtml(source: string): string {
  return source.includes("\n") ? fencedCode(source) : codeSpan(source);
}

function definitionsOf(root: MarkdownNode): Map<string, MarkdownNode> {
  const definitions = new Map<string, MarkdownNode>();
  visit(root, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string" &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node);
    }
  });
  return definitions;
}

/**
 * BlockNote не разрешает imageReference через definition и показывает такую
 * конструкцию literal-текстом. Подставляем фактический URL до BlockNote;
 * освободившиеся definition удаляем, если на них не ссылаются обычные ссылки.
 */
function resolveImageReferences(root: MarkdownNode): Replacement[] {
  const definitions = definitionsOf(root);
  const replacements: Replacement[] = [];
  const usedByImages = new Set<string>();
  const usedByLinks = new Set<string>();

  visit(root, (node) => {
    if (node.type === "linkReference" && typeof node.identifier === "string") {
      usedByLinks.add(node.identifier);
      return;
    }

    if (node.type !== "imageReference" || typeof node.identifier !== "string") return;
    const definition = definitions.get(node.identifier);
    const range = offsets(node);
    if (definition === undefined || definition.url === undefined || range === null) return;

    usedByImages.add(node.identifier);
    replacements.push({
      start: range[0],
      end: range[1],
      value: inlineImageMarkdown(node.alt ?? "", definition.url, definition.title),
    });
  });

  for (const identifier of usedByImages) {
    if (usedByLinks.has(identifier)) continue;
    const definition = definitions.get(identifier);
    const range = definition === undefined ? null : offsets(definition);
    if (range !== null) replacements.push({ start: range[0], end: range[1], value: "" });
  }

  return replacements;
}

/** Превращает raw HTML из Markdown в литеральный код. */
function literalizeHtml(root: MarkdownNode, markdown: string): Replacement[] {
  const replacements: Replacement[] = [];

  visit(root, (node) => {
    if (node.type !== "html") return;
    const range = offsets(node);
    if (range === null) return;
    replacements.push({
      start: range[0],
      end: range[1],
      value: literalHtml(markdown.slice(...range)),
    });
  });

  return replacements;
}

/**
 * Ссылка, внутри которой кроме image есть текст, не представима ни inline
 * image, ни image-блоком: BlockNote link допускает только текст. Чтобы не
 * отправить в onChange повреждённый Markdown, сохраняем такую ссылку целиком
 * литеральным кодом.
 */
function literalizeUnsupportedLinks(root: MarkdownNode, markdown: string): Replacement[] {
  const replacements: Replacement[] = [];

  visit(root, (node) => {
    if (node.type !== "link") return;
    const children = node.children ?? [];
    const hasImage = children.some((child) => {
      let found = false;
      visit(child, (candidate) => {
        if (candidate.type === "image" || candidate.type === "imageReference") found = true;
      });
      return found;
    });
    if (!hasImage) return;

    const hasOtherContent = children.some((child) => {
      if (child.type === "image" || child.type === "imageReference") return false;
      if (child.type === "text") return (child.value ?? "").trim().length > 0;
      return true;
    });
    if (!hasOtherContent) return;

    const range = offsets(node);
    if (range === null) return;
    replacements.push({
      start: range[0],
      end: range[1],
      value: literalHtml(markdown.slice(...range)),
    });
  });

  return replacements;
}

function isInside(replacement: Replacement, range: readonly [number, number]): boolean {
  return replacement.start >= range[0] && replacement.end <= range[1];
}

function applyReplacements(markdown: string, replacements: readonly Replacement[]): string {
  if (replacements.length === 0) return markdown;

  const ordered = [...replacements].sort((left, right) =>
    left.start === right.start ? right.end - left.end : right.start - left.start,
  );

  let result = markdown;
  for (const replacement of ordered) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

/**
 * Готовит Markdown к BlockNote: разрешает reference image, а raw HTML
 * сохраняет как литеральный текст. Inline image не выносится из структуры —
 * его представлением занимается схема редактора.
 */
export function prepareMarkdownForBlockNote(markdown: string): string {
  if (markdown.length === 0) return markdown;
  const root = parseMarkdown(markdown);
  const linkReplacements = literalizeUnsupportedLinks(root, markdown);
  const linkRanges = linkReplacements.map(
    (replacement) => [replacement.start, replacement.end] as const,
  );
  const innerReplacements = [
    ...resolveImageReferences(root),
    ...literalizeHtml(root, markdown),
  ].filter((replacement) => !linkRanges.some((range) => isInside(replacement, range)));

  return applyReplacements(markdown, [...linkReplacements, ...innerReplacements]);
}

function isStandaloneBlockImage(image: Element): boolean {
  const paragraph = image.parentElement;
  if (paragraph?.tagName !== "P" || paragraph.parentElement?.tagName !== "BODY") return false;
  if (paragraph.children.length !== 1) return false;
  return (paragraph.textContent ?? "").trim().length === 0;
}

function inlineImageSpan(
  document: Document,
  type: string,
  url: string,
  name: string,
  href?: string,
) {
  const span = document.createElement("span");
  span.setAttribute("data-inline-content-type", type);
  span.setAttribute("data-url", url);
  span.setAttribute("data-name", name);
  if (href !== undefined) span.setAttribute("data-href", href);
  return span;
}

/**
 * Переписывает HTML от `markdownToHTML`: одиночный image верхнего уровня
 * остаётся image-блоком, остальные image становятся inline-контентом схемы,
 * чтобы не потерять окружение — emphasis, ссылку, список, цитату или таблицу.
 */
function rewriteImageHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const anchor of Array.from(document.querySelectorAll("a"))) {
    const images = anchor.querySelectorAll("img");
    if (images.length !== 1) continue;
    if ((anchor.textContent ?? "").trim().length > 0) continue;
    if (anchor.children.length !== 1) continue;

    const image = images[0];
    if (image === undefined || image.parentElement !== anchor) continue;

    const href = anchor.getAttribute("href") ?? "";
    const validation = validateLinkHref(href);
    const url = image.getAttribute("src") ?? "";
    const name = image.getAttribute("alt") ?? "";
    anchor.replaceWith(
      validation.ok
        ? inlineImageSpan(document, LINKED_IMAGE_TYPE, url, name, validation.href)
        : inlineImageSpan(document, INLINE_IMAGE_TYPE, url, name),
    );
  }

  for (const image of Array.from(document.querySelectorAll("img"))) {
    if (isStandaloneBlockImage(image)) continue;
    image.replaceWith(
      inlineImageSpan(
        document,
        INLINE_IMAGE_TYPE,
        image.getAttribute("src") ?? "",
        image.getAttribute("alt") ?? "",
      ),
    );
  }

  return document.body.innerHTML;
}

function sanitizeImageNames(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) sanitizeImageNames(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const record = value as Record<string, unknown>;
  if (
    (record.type === "image" || record.type === "inlineImage" || record.type === "linkedImage") &&
    typeof record.props === "object" &&
    record.props !== null
  ) {
    const props = record.props as Record<string, unknown>;
    if (typeof props.name === "string") props.name = sanitizeImageAlt(props.name);
  }

  for (const child of Object.values(record)) {
    if (typeof child === "object" && child !== null) sanitizeImageNames(child);
  }
}

// BlockNote 0.54 делает generic-типы редактора инвариантными, а собственный
// helper работает с любым schema; конкретная схема остаётся в note-editor-schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NoteEditorInstance = BlockNoteEditor<any, any, any>;

/**
 * Единственный путь Markdown → блоки. Reference image разрешаются, raw HTML
 * становится литеральным кодом, inline image сохраняют окружение.
 */
export function markdownToEditorBlocks<E extends NoteEditorInstance>(
  editor: E,
  markdown: string,
): ReturnType<E["tryParseHTMLToBlocks"]> {
  const prepared = prepareMarkdownForBlockNote(markdown);
  const html = prepared.length === 0 ? "" : rewriteImageHtml(markdownToHTML(prepared));
  const blocks = editor.tryParseHTMLToBlocks(html) as ReturnType<E["tryParseHTMLToBlocks"]>;
  sanitizeImageNames(blocks);
  return blocks;
}

/** Убирает служебный trailing newline пустого документа BlockNote. */
export function serializeBlockNoteMarkdown(markdown: string): string {
  return normalizeMarkdownDocument(markdown);
}
