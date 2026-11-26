import { fromMarkdown } from "mdast-util-from-markdown";

export const NOTE_ATTACHMENT_URL_PREFIX = "attachment://" as const;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface MarkdownPosition {
  readonly start?: { readonly offset?: number };
  readonly end?: { readonly offset?: number };
}

interface MarkdownNode {
  readonly type?: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly position?: MarkdownPosition;
  readonly children?: readonly MarkdownNode[];
}

interface ImageReference {
  readonly url: string;
  readonly range: UrlRange | null;
}

interface DefinitionReference {
  readonly url: string;
  readonly range: UrlRange | null;
}

interface UrlRange {
  readonly start: number;
  readonly end: number;
}

function tree(markdown: string): MarkdownNode {
  return fromMarkdown(markdown) as unknown as MarkdownNode;
}

function visit(node: MarkdownNode, callback: (node: MarkdownNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) {
    visit(child, callback);
  }
}

/**
 * Находит диапазон destination внутри reference definition.
 *
 * Формат `[label]: url "title"` не даёт позиции URL, поэтому метка
 * пропускается с учётом escape-последовательностей, а destination разбирается
 * так же, как inline-destination изображения.
 */
function locateDefinitionDestination(source: string): UrlRange | null {
  if (!source.startsWith("[")) {
    return null;
  }

  let index = 1;

  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (character === "]") {
      index += 1;
      break;
    }

    index += 1;
  }

  if (source[index] !== ":") {
    return null;
  }

  index += 1;
  while (index < source.length && /\s/.test(source[index] ?? "")) {
    index += 1;
  }

  return locateUrl(source, index, false);
}

/**
 * Разбирает destination с позиции `index`.
 *
 * `stopAtParenthesis` нужен для inline `![alt](url)`: незакрытая скобка
 * завершает destination. В definition `)` допустима, поэтому там ограничителем
 * служит только пробел или конец строки.
 */
function locateUrl(source: string, from: number, stopAtParenthesis: boolean): UrlRange | null {
  let index = from;

  if (source[index] === "<") {
    const close = source.indexOf(">", index + 1);
    return close < 0 ? null : { start: index + 1, end: close };
  }

  const start = index;
  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (
      character === undefined ||
      /\s/.test(character) ||
      (stopAtParenthesis && character === ")")
    ) {
      break;
    }

    index += 1;
  }

  return index <= start ? null : { start, end: index };
}

function definitionsOf(markdown: string): ReadonlyMap<string, DefinitionReference> {
  const root = tree(markdown);
  const definitions = new Map<string, DefinitionReference>();

  visit(root, (node) => {
    if (
      node.type !== "definition" ||
      typeof node.url !== "string" ||
      typeof node.identifier !== "string" ||
      definitions.has(node.identifier)
    ) {
      return;
    }

    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    const range =
      start === undefined || end === undefined || end <= start
        ? null
        : locateDefinitionDestination(markdown.slice(start, end));

    definitions.set(node.identifier, {
      url: node.url,
      range:
        range === null || start === undefined
          ? null
          : { start: start + range.start, end: start + range.end },
    });
  });

  return definitions;
}

function images(markdown: string): readonly ImageReference[] {
  const root = tree(markdown);
  const definitions = definitionsOf(markdown);
  const references: ImageReference[] = [];

  visit(root, (node) => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;

    if (start === undefined || end === undefined || end <= start) {
      return;
    }

    if (node.type === "image" && typeof node.url === "string") {
      const range = locateDestination(markdown.slice(start, end));
      references.push({
        url: node.url,
        range: range === null ? null : { start: start + range.start, end: start + range.end },
      });
      return;
    }

    if (node.type === "imageReference" && typeof node.identifier === "string") {
      const definition = definitions.get(node.identifier);

      if (definition !== undefined) {
        references.push(definition);
      }
    }
  });

  return references;
}

/**
 * Находит диапазон destination внутри исходного текста inline image-узла.
 *
 * `mdast` сообщает URL, но не его позицию. Простой `indexOf` ошибается, если
 * тот же текст встречается в alt или title, поэтому разбирается `![alt](...)`
 * с учётом вложенных скобок в alt и escape-последовательностей.
 */
function locateDestination(source: string): UrlRange | null {
  if (!source.startsWith("![")) {
    return null;
  }

  let index = 2;
  let depth = 1;

  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (character === "[") {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === "]") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        break;
      }
      continue;
    }

    index += 1;
  }

  if (depth !== 0 || source[index] !== "(") {
    return null;
  }

  index += 1;
  while (index < source.length && /\s/.test(source[index] ?? "")) {
    index += 1;
  }

  if (source[index] === "<") {
    const close = source.indexOf(">", index + 1);
    return close < 0 ? null : { start: index + 1, end: close };
  }

  const start = index;
  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (character === undefined || /\s/.test(character) || character === ")") {
      break;
    }

    index += 1;
  }

  return index <= start ? null : { start, end: index };
}

export function attachmentUrl(id: string): string {
  if (!ATTACHMENT_ID_PATTERN.test(id)) {
    throw new TypeError("Некорректный идентификатор вложения");
  }

  return `${NOTE_ATTACHMENT_URL_PREFIX}${id}`;
}

export function attachmentIdFromUrl(url: string): string | null {
  if (!url.startsWith(NOTE_ATTACHMENT_URL_PREFIX)) {
    return null;
  }

  const id = url.slice(NOTE_ATTACHMENT_URL_PREFIX.length);
  return ATTACHMENT_ID_PATTERN.test(id) ? id : null;
}

/** Возвращает URL всех реальных image-узлов, игнорируя code block и inline code. */
export function markdownImageUrls(markdown: string): readonly string[] {
  return images(markdown).map((image) => image.url);
}

export function extractAttachmentIds(markdown: string): readonly string[] {
  const ids = new Set<string>();

  for (const url of markdownImageUrls(markdown)) {
    const id = attachmentIdFromUrl(url);
    if (id !== null) {
      ids.add(id);
    }
  }

  return [...ids];
}

/**
 * Заменяет URL только в AST image-узлах и reference definitions. Позиции
 * узлов позволяют сохранить остальной Markdown побайтово и не трогать похожий
 * текст в коде/тексте. Несколько ссылок на один definition заменяются один раз.
 *
 * Если URL изменился, но destination не удалось найти, выбрасывается
 * `TypeError`: молча вернуть документ с невстроенным вложением нельзя.
 */
export function replaceMarkdownImageUrls(
  markdown: string,
  replace: (url: string) => string,
): string {
  let result = markdown;
  const replacements = new Map<string, { start: number; end: number; nextUrl: string }>();

  for (const image of images(markdown)) {
    const nextUrl = replace(image.url);
    if (nextUrl === image.url) {
      continue;
    }

    if (image.range === null) {
      throw new TypeError("Не удалось заменить URL изображения в Markdown");
    }

    const key = `${image.range.start}:${image.range.end}`;
    if (!replacements.has(key)) {
      replacements.set(key, {
        start: image.range.start,
        end: image.range.end,
        nextUrl,
      });
    }
  }

  const ordered = [...replacements.values()].sort((left, right) => right.start - left.start);

  for (const replacement of ordered) {
    result = `${result.slice(0, replacement.start)}${replacement.nextUrl}${result.slice(replacement.end)}`;
  }

  return result;
}
