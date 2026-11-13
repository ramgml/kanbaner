const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:", "blob:", "attachment:"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** Сравнивает документы, не считая различием CRLF и хвостовые переводы строк. */
export function markdownDocumentsEqual(left: string, right: string): boolean {
  return normalizeMarkdownDocument(left) === normalizeMarkdownDocument(right);
}

export function normalizeMarkdownDocument(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").replace(/\n+$/u, "");
}

function withoutControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

function hasScheme(value: string): boolean {
  return URL_SCHEME.test(value);
}

function protocolOf(value: string): string | null {
  const match = URL_SCHEME.exec(value);
  return match?.[1] ? `${match[1].toLowerCase()}:` : null;
}

export interface LinkValidationSuccess {
  readonly ok: true;
  readonly href: string;
}

export interface LinkValidationFailure {
  readonly ok: false;
  readonly error: string;
}

export type LinkValidation = LinkValidationSuccess | LinkValidationFailure;

/**
 * Разрешает абсолютные http(s), mailto и tel, а также относительные ссылки.
 * `javascript:`, `vbscript:` и прочие схемы отклоняются.
 */
export function validateLinkHref(rawHref: string): LinkValidation {
  const href = withoutControlCharacters(rawHref.trim());

  if (href.length === 0) {
    return { ok: false, error: "Введите адрес ссылки." };
  }

  if (!hasScheme(href)) {
    return { ok: true, href };
  }

  const protocol = protocolOf(href);

  if (protocol !== null && SAFE_LINK_PROTOCOLS.has(protocol)) {
    return { ok: true, href };
  }

  return {
    ok: false,
    error: "Поддерживаются ссылки http, https, mailto и tel, а также относительные адреса.",
  };
}

/** Проверяет адрес изображения до вставки, чтобы не создать broken image. */
export function sanitizeImageSource(rawSource: string): string | null {
  const source = withoutControlCharacters(rawSource.trim());

  if (source.length === 0) {
    return null;
  }

  if (SAFE_DATA_IMAGE.test(source)) {
    return source;
  }

  if (!hasScheme(source)) {
    return source;
  }

  const protocol = protocolOf(source);

  if (protocol !== null && SAFE_IMAGE_PROTOCOLS.has(protocol)) {
    return source;
  }

  return null;
}

export function imageUploadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();

    if (message.length > 0 && message.length <= 240) {
      return `Не удалось загрузить изображение: ${message}`;
    }
  }

  return "Не удалось загрузить изображение. Попробуйте ещё раз.";
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
