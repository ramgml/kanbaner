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
  readonly position?: MarkdownPosition;
  readonly children?: readonly MarkdownNode[];
}

interface ImageReference {
  readonly url: string;
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

function images(markdown: string): readonly ImageReference[] {
  const references: ImageReference[] = [];

  visit(tree(markdown), (node) => {
    if (node.type !== "image" || typeof node.url !== "string") {
      return;
    }

    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;

    if (start !== undefined && end !== undefined && end > start) {
      references.push({ url: node.url, start, end });
    }
  });

  return references;
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
 * Заменяет URL только в AST image-узлах. Позиции узлов позволяют сохранить
 * остальной Markdown побайтово и не трогать похожий текст в коде/тексте.
 */
export function replaceMarkdownImageUrls(
  markdown: string,
  replace: (url: string) => string,
): string {
  let result = markdown;
  const replacements = images(markdown)
    .map((image) => {
      const nextUrl = replace(image.url);
      if (nextUrl === image.url) {
        return null;
      }

      const start = markdown.slice(image.start, image.end);
      const urlOffset = start.indexOf(image.url);
      if (urlOffset < 0) {
        return null;
      }

      return {
        start: image.start + urlOffset,
        end: image.start + urlOffset + image.url.length,
        nextUrl,
      };
    })
    .filter((value): value is { start: number; end: number; nextUrl: string } => value !== null)
    .sort((left, right) => right.start - left.start);

  for (const replacement of replacements) {
    result = `${result.slice(0, replacement.start)}${replacement.nextUrl}${result.slice(replacement.end)}`;
  }

  return result;
}
