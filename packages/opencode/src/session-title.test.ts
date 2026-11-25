// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
  SESSION_TITLE_MAX_POINTS,
} from "./session-title.ts";

function points(value: string): string[] {
  return Array.from(value);
}

describe("deriveSessionTitle", () => {
  it("берёт обычный текст как есть", () => {
    expect(deriveSessionTitle("Обнови задачу и проверь отчёт")).toBe(
      "Обнови задачу и проверь отчёт",
    );
  });

  it("схлопывает пробелы и переносы в одну строку", () => {
    expect(deriveSessionTitle("  Обнови\n\n задачу\t —  проверь  ")).toBe(
      "Обнови задачу — проверь",
    );
    expect(deriveSessionTitle("\n\r\nПочинить\tбаг\n")).toBe("Починить баг");
  });

  it("снимает heading, blockquote, list и checkbox маркеры", () => {
    expect(deriveSessionTitle("## Заголовок\n- пункт\n> цитата\n- [x] готово")).toBe(
      "Заголовок пункт цитата готово",
    );
  });

  it("раскрывает ссылки и убирает inline code/bold маркеры, сохраняя текст", () => {
    expect(
      deriveSessionTitle("Смотри [документацию](https://example.invalid/doc) и `npm run test`"),
    ).toBe("Смотри документацию и npm run test");
    expect(deriveSessionTitle("**Важно**: __исправить__ ~~старое~~ и _новое_")).toBe(
      "Важно: исправить старое и новое",
    );
  });

  it("сохраняет label изображения и убирает fenced code block", () => {
    expect(deriveSessionTitle("```ts\nconst answer = 42;\n```\nПосле кода")).toBe("После кода");
    expect(deriveSessionTitle("![схема](image.png) и текст")).toBe("схема и текст");
  });

  it("удаляет HTML-разметку, комментарии и raw script/style", () => {
    expect(
      deriveSessionTitle("<b>Задача</b> <!-- скрыто --><script>alert(1)</script> и хвост"),
    ).toBe("Задача и хвост");
  });

  it("удаляет controls и нормализует суррогаты без падения", () => {
    expect(deriveSessionTitle("\u0000\u0007 Привет\u0000 мир\u001B")).toBe("Привет мир");
    expect(deriveSessionTitle("\uD800")).toBeNull();
    expect(deriveSessionTitle("Задача \uD83D")).toBe("Задача");
  });

  it("сохраняет emoji в смешанном тексте", () => {
    expect(deriveSessionTitle("🚀 Запусти релиз 🎉")).toBe("🚀 Запусти релиз 🎉");
  });

  it("оставляет ровно 60 code points на границе и обрезает 61+", () => {
    const exact = "я".repeat(SESSION_TITLE_MAX_POINTS);
    expect(deriveSessionTitle(exact)).toBe(exact);

    const longer = `${exact} ещё`;
    const title = deriveSessionTitle(longer);
    expect(title).not.toBeNull();
    expect(points(title ?? "").length).toBeLessThanOrEqual(SESSION_TITLE_MAX_POINTS);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("обрезает длинный текст по границе слова", () => {
    const title = deriveSessionTitle("Слово ".repeat(20));
    expect(title).toBe(`${"Слово ".repeat(9).trimEnd()}…`);
    expect(points(title ?? "").length).toBeLessThanOrEqual(SESSION_TITLE_MAX_POINTS);
  });

  it("не разрывает surrogate pair при обрезке emoji", () => {
    const title = deriveSessionTitle("🚀".repeat(80));
    expect(title).not.toBeNull();
    const result = points(title ?? "");
    expect(result.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_POINTS);
    expect(result.at(-1)).toBe("…");
    expect(result.every((point) => point === "🚀" || point === "…")).toBe(true);
  });

  it("возвращает null для пустого текста, разметки и пунктуации", () => {
    for (const value of [
      "",
      "   \n\t",
      "###",
      "- [ ]",
      "```ts\n```",
      "****",
      "...",
      "!?—",
      "<div></div>",
      "\u0000\u0007",
    ]) {
      expect(deriveSessionTitle(value)).toBeNull();
    }
  });

  it("возвращает null для стандартного названия в любом регистре", () => {
    expect(deriveSessionTitle(DEFAULT_SESSION_TITLE)).toBeNull();
    expect(deriveSessionTitle("  kanbaner   CHAT ")).toBeNull();
  });

  it("детерминирован и не зависит от контекстной преамбулы", () => {
    const text = "Контекст: kanbaner.notes:note:1\n\nПерепиши заметку";
    expect(deriveSessionTitle(text)).toBe(deriveSessionTitle(text));
    expect(deriveSessionTitle("Перепиши заметку")).toBe("Перепиши заметку");
  });
});
