/**
 * Нормализация поискового текста для FTS5.
 *
 * Провайдер не обещает русский стемминг. Нормализация ограничена Unicode
 * NFKC и приведением регистра; токенизация — буквы и цифры Unicode. FTS5
 * использует токенизатор `unicode61`, поэтому документ и запрос проходят
 * одинаковую предварительную обработку.
 */
export const SEARCH_NORMALIZER_VERSION = 1 as const;

/** Приводит текст к сравнимому виду без изменения смысла токенов. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Разбивает текст на токены Unicode без стемминга. */
export function tokenizeSearchText(value: string): readonly string[] {
  return normalizeSearchText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

export interface NormalizedSearchQuery {
  /** Выражение для `MATCH` без фильтра по колонке. */
  readonly match: string;
  /** Нормализованные термины для построения excerpt. */
  readonly terms: readonly string[];
}

function escapeFtsToken(token: string): string {
  return `"${token}"`;
}

/**
 * Строит безопасное FTS5-выражение из пользовательского запроса.
 *
 * Поддерживаются:
 * - кириллица и произвольный Unicode-регистр (нормализуется);
 * - явные фразы в кавычках: `"первый виджет"`;
 * - prefix-запросы: `виджет*`;
 * - несколько терминов вне кавычек объединяются через неявный `AND`.
 *
 * Возвращает `null`, если после нормализации не осталось терминов.
 */
export function normalizeSearchQuery(value: string): NormalizedSearchQuery | null {
  const parts: string[] = [];
  const terms: string[] = [];
  let buffer = "";

  const flush = (): void => {
    const raw = buffer.trim();
    buffer = "";

    if (raw.length === 0) {
      return;
    }

    const prefix = raw.endsWith("*");
    const tokens = tokenizeSearchText(prefix ? raw.replace(/\*+$/u, "") : raw);

    if (tokens.length === 0) {
      return;
    }

    if (prefix) {
      const lastIndex = tokens.length - 1;
      const last = tokens[lastIndex];

      for (let index = 0; index < lastIndex; index += 1) {
        const token = tokens[index];

        if (token !== undefined) {
          parts.push(escapeFtsToken(token));
          terms.push(token);
        }
      }

      if (last !== undefined) {
        parts.push(`${escapeFtsToken(last)}*`);
        terms.push(last);
      }

      return;
    }

    for (const token of tokens) {
      parts.push(escapeFtsToken(token));
      terms.push(token);
    }
  };

  let index = 0;

  while (index < value.length) {
    const character = value.charAt(index);

    if (character === '"') {
      const end = value.indexOf('"', index + 1);
      const phrase = end < 0 ? value.slice(index + 1) : value.slice(index + 1, end);
      const tokens = tokenizeSearchText(phrase);

      if (tokens.length > 0) {
        parts.push(`"${tokens.join(" ")}"`);
        terms.push(...tokens);
      }

      index = end < 0 ? value.length : end + 1;
      continue;
    }

    if (/\s/u.test(character)) {
      flush();
      index += 1;
      continue;
    }

    buffer += character;
    index += 1;
  }

  flush();

  if (parts.length === 0) {
    return null;
  }

  return { match: parts.join(" "), terms };
}

/** Ограничивает excerpt вокруг первого найденного термина. */
export function buildSearchExcerpt(title: string, text: string, terms: readonly string[]): string {
  const source = `${title}\n${text}`;
  const normalized = normalizeSearchText(source);
  let position = -1;

  for (const term of terms) {
    const found = normalized.indexOf(term);

    if (found >= 0 && (position < 0 || found < position)) {
      position = found;
    }
  }

  // NFKC может изменить длину строки. В этом случае точка входа неизвестна,
  // поэтому excerpt строится с начала, а не по неверному индексу.
  const anchor = normalized.length === source.length && position >= 0 ? position : 0;
  const start = Math.max(0, anchor - 40);
  const end = Math.min(source.length, anchor + 120);

  return source.slice(start, end).replace(/\s+/gu, " ").trim();
}
