/**
 * Детерминированное название OpenCode-сессии из первого запроса. Без вызова
 * модели, без зависимостей и без полноценного Markdown parser: текст один раз
 * ограничивается, нормализуется в одну строку, очищается от типичной разметки
 * и обрезается до 60 Unicode code points.
 */

/** Стандартное название, которое gateway ставит при создании сессии. */
export const DEFAULT_SESSION_TITLE = "Kanbaner chat";

/** Максимум code points автоматического названия, включая `…`. */
export const SESSION_TITLE_MAX_POINTS = 60;

const SESSION_TITLE_AUTO_FALLBACK_TITLE = DEFAULT_SESSION_TITLE;
const TITLE_SOURCE_MAX_UNITS = 8_192;
const TITLE_WORD_BOUNDARY_MIN_RATIO = 0.4;
const ELLIPSIS = "…";

const FENCED_CODE = /(?:```|~~~)[\s\S]*?(?:```|~~~)/gu;
const UNTERMINATED_FENCE = /(?:```|~~~)[\s\S]*$/u;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const HTML_RAW_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu;
const HTML_TAG = /<[^>\n]{0,500}>/gu;
const IMAGE_LINK = /!\[([^\]\n]{0,200})\]\([^)\n]{0,1000}\)/gu;
const TEXT_LINK = /\[([^\]\n]{0,300})\]\([^)\n]{0,1000}\)/gu;
const LINE_MARKER = /^[ \t>]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+|\[[ xX]\][ \t]+)/u;
const HORIZONTAL_RULE = /^[ \t]*(?:[-*_][ \t]*){3,}$/u;
const SPACE_CONTROLS = /[\t\n\r\f\u000B]+/gu;
const INVISIBLE_CONTROLS =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;
const LEADING_UNDERSCORES = /(^|[\s([{])_+/gu;
const TRAILING_UNDERSCORES = /_+(?=$|[\s)\]}.,!?;:])/gu;
const TRAILING_TITLE_PUNCTUATION = /[\s,;:.!?…\-–—/|]+$/u;
const WORD_BOUNDARY = /\s/u;
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * Ограничивает вход до обработки. Не оставляет висячий high surrogate, чтобы
 * последующая нормализация не превратила его в U+FFFD на конце.
 */
function boundedSource(text: string): string {
  if (text.length <= TITLE_SOURCE_MAX_UNITS) return text;
  const truncated = text.slice(0, TITLE_SOURCE_MAX_UNITS);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

/**
 * Снимает типичные строчные маркеры: heading, blockquote, list, task checkbox.
 * Полноценный CommonMark не поддерживается намеренно.
 */
function stripLineMarker(line: string): string {
  let current = line.replace(/^[ \t]*(?:>[ \t]?)+/u, "");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current.replace(LINE_MARKER, "");
    if (next === current) break;
    current = next;
  }
  return HORIZONTAL_RULE.test(current) ? "" : current;
}

/** Убирает Markdown/HTML-шум, сохраняя текст ссылок и содержимое inline code. */
function cleanMarkdown(value: string): string {
  let clean = value
    .toWellFormed()
    .replace(FENCED_CODE, " ")
    .replace(UNTERMINATED_FENCE, " ")
    .replace(HTML_COMMENT, " ")
    .replace(HTML_RAW_BLOCK, " ")
    .replace(HTML_TAG, " ")
    .replace(IMAGE_LINK, "$1")
    .replace(TEXT_LINK, "$1");
  clean = clean
    .split(/\r\n|\r|\n/u)
    .map(stripLineMarker)
    .join("\n");
  clean = clean
    .replace(/[`*~]+/gu, "")
    .replace(LEADING_UNDERSCORES, "$1")
    .replace(TRAILING_UNDERSCORES, "")
    .replace(SPACE_CONTROLS, " ")
    .replace(INVISIBLE_CONTROLS, "")
    .replace(/\uFFFD/gu, "")
    .replace(/\s+/gu, " ");
  return clean.trim();
}

/**
 * Обрезка до 60 code points включая `…`. По возможности режет по последнему
 * пробелу в разумной части строки, не разрывая surrogate pair.
 */
function truncateTitle(value: string): string | null {
  const points = Array.from(value);
  if (points.length <= SESSION_TITLE_MAX_POINTS) return value;

  const limit = SESSION_TITLE_MAX_POINTS - 1;
  let cut = limit;
  const minBoundary = Math.floor(limit * TITLE_WORD_BOUNDARY_MIN_RATIO);
  for (let index = limit - 1; index >= minBoundary; index -= 1) {
    if (WORD_BOUNDARY.test(points[index] ?? "")) {
      cut = index;
      break;
    }
  }

  let head = points.slice(0, cut).join("").replace(TRAILING_TITLE_PUNCTUATION, "").trim();
  if (head.length === 0) {
    head = points.slice(0, limit).join("").replace(TRAILING_TITLE_PUNCTUATION, "").trim();
  }
  return head.length === 0 ? null : `${head}${ELLIPSIS}`;
}

/**
 * Возвращает короткое название или null, если текст пуст, состоит только из
 * разметки/пунктуации или совпадает со стандартным названием.
 */
export function deriveSessionTitle(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const clean = cleanMarkdown(boundedSource(text));
  if (clean.length === 0 || !MEANINGFUL_CHARACTER.test(clean)) return null;
  if (clean.toLowerCase() === SESSION_TITLE_AUTO_FALLBACK_TITLE.toLowerCase()) return null;
  return truncateTitle(clean);
}
