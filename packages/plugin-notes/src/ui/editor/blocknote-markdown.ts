import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { normalizeMarkdownDocument } from "./editor-markdown.ts";

interface MarkdownPosition {
  readonly start?: { readonly offset?: number };
  readonly end?: { readonly offset?: number };
}

interface MarkdownNode {
  readonly type?: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?: MarkdownPosition;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const BLOCK_CONTAINERS = new Set(["list", "listItem", "footnoteDefinition"]);

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

function isImage(node: MarkdownNode): boolean {
  return node.type === "image" || node.type === "imageReference";
}

/** Собирает image-узлы в порядке документа вместе с исходным Markdown-фрагментом. */
function collectImages(
  node: MarkdownNode,
  markdown: string,
  images: { readonly start: number; readonly end: number; readonly source: string }[],
): void {
  if (isImage(node)) {
    const range = offsets(node);
    if (range !== null) {
      images.push({ start: range[0], end: range[1], source: markdown.slice(range[0], range[1]) });
    }
    return;
  }

  for (const child of node.children ?? []) collectImages(child, markdown, images);
}

function lineStartOf(markdown: string, offset: number): number {
  const newline = markdown.lastIndexOf("\n", Math.max(0, offset - 1));
  return newline + 1;
}

/**
 * Префикс, которым продолжается тот же блок. Маркеры списка заменяются пробелами,
 * чтобы вложенный абзац остался внутри своего list item: `  - ` → `    `.
 */
function continuationPrefix(markdown: string, offset: number): string {
  const prefix = markdown.slice(lineStartOf(markdown, offset), offset);
  return prefix.replace(/(^|\s)(?:[-*+]|\d{1,9}[.)])\s+/gu, (match) => " ".repeat(match.length));
}

/** Префикс родительского блока без маркеров цитаты: картинка выносится из blockquote. */
function hoistPrefix(markdown: string, offset: number): string {
  return continuationPrefix(markdown, offset).replace(/>[ \t]?/gu, "");
}

/** Убирает служебные префиксы строк и возвращает их в нужном контейнере. */
function normalizeLines(value: string, prefix: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\n[ \t>]*/gu, `\n${prefix}`)
    .trim();
}

function splitParagraph(node: MarkdownNode, markdown: string, replacements: Replacement[]): void {
  const range = offsets(node);
  if (range === null) return;

  const images: { readonly start: number; readonly end: number; readonly source: string }[] = [];
  collectImages(node, markdown, images);
  if (images.length === 0) return;

  const [start, end] = range;
  const prefix = continuationPrefix(markdown, start);
  const parts: string[] = [];
  let cursor = start;

  for (const image of images) {
    if (image.start < cursor || image.end > end) continue;
    const before = normalizeLines(markdown.slice(cursor, image.start), prefix);
    if (before.length > 0) parts.push(before);
    parts.push(image.source);
    cursor = image.end;
  }

  const after = normalizeLines(markdown.slice(cursor, end), prefix);
  if (after.length > 0) parts.push(after);
  if (parts.length < 2) return;

  replacements.push({ start, end, value: parts.join(`\n\n${prefix}`) });
}

/**
 * Вынимает картинки из контейнера, который BlockNote не умеет хранить блоком:
 * blockquote, таблица и заголовок допускают только inline-содержимое либо один
 * тип блока. Картинки удаляются из контейнера и добавляются сразу после него.
 */
function hoistFromContainer(
  node: MarkdownNode,
  markdown: string,
  replacements: Replacement[],
): void {
  const range = offsets(node);
  if (range === null) return;

  const images: { readonly start: number; readonly end: number; readonly source: string }[] = [];
  collectImages(node, markdown, images);
  const own = images.filter((image) => image.start >= range[0] && image.end <= range[1]);
  if (own.length === 0) return;

  for (const image of own) {
    replacements.push({ start: image.start, end: image.end, value: "" });
  }

  const prefix = hoistPrefix(markdown, range[0]);
  const hoisted = own.map((image) => image.source).join(`\n\n${prefix}`);
  replacements.push({ start: range[1], end: range[1], value: `\n\n${prefix}${hoisted}` });
}

function collectReplacements(
  node: MarkdownNode,
  markdown: string,
  replacements: Replacement[],
): void {
  for (const child of node.children ?? []) {
    if (child.type === "paragraph") {
      splitParagraph(child, markdown, replacements);
      continue;
    }

    if (child.type === "heading") {
      hoistFromContainer(child, markdown, replacements);
      continue;
    }

    if (child.type === "blockquote" || child.type === "table") {
      hoistFromContainer(child, markdown, replacements);
      continue;
    }

    if (child.type !== undefined && BLOCK_CONTAINERS.has(child.type)) {
      collectReplacements(child, markdown, replacements);
    }
  }
}

/**
 * BlockNote 0.54 импортирует Markdown в блочную модель и теряет image, если тот
 * стоит внутри абзаца с текстом, заголовка, цитаты или ячейки таблицы. Заранее
 * выносим такие image в самостоятельные блоки, не затрагивая code, link
 * destinations и прочие конструкции Markdown.
 */
export function prepareMarkdownForBlockNote(markdown: string): string {
  const replacements: Replacement[] = [];
  collectReplacements(parseMarkdown(markdown), markdown, replacements);
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

/** Убирает служебный trailing newline пустого документа BlockNote. */
export function serializeBlockNoteMarkdown(markdown: string): string {
  return normalizeMarkdownDocument(markdown);
}
