import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "./ui/markdown-content.tsx";

describe("MarkdownContent", () => {
  it("рендерит CommonMark и GFM с безопасными ссылками и без raw HTML", () => {
    const source = [
      "## Заголовок",
      "",
      "**Жирный**, *курсив* и ~~удалённый~~ текст.",
      "",
      "- [x] Готово",
      "- [ ] Сделать",
      "",
      "> Цитата",
      "",
      "`inline code`",
      "",
      "```js",
      "const value = 1;",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "[Документация](https://example.com/docs)",
      "[Опасная ссылка](javascript:alert(1))",
      "",
      "![Схема](https://example.com/image.png)",
      "",
      "<script>window.__markdownXss = true</script>",
    ].join("\n");

    const { container } = render(<MarkdownContent source={source} />);

    expect(screen.getByRole("heading", { name: "Заголовок" })).toBeInTheDocument();
    expect(screen.getByText("Жирный")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("курсив")).toHaveProperty("tagName", "EM");
    expect(screen.getByText("удалённый")).toHaveProperty("tagName", "DEL");
    expect(screen.getByText("Цитата").closest("blockquote")).not.toBeNull();
    expect(screen.getByText("inline code")).toHaveProperty("tagName", "CODE");
    expect(screen.getByText("const value = 1;")).toHaveProperty("tagName", "CODE");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "A" })).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox");

    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[0]).toBeDisabled();
    expect(checkboxes[1]).not.toBeChecked();
    expect(checkboxes[1]).toBeDisabled();

    const safeLink = screen.getByRole("link", { name: "Документация" });

    expect(safeLink).toHaveAttribute("href", "https://example.com/docs");
    expect(safeLink).toHaveAttribute("target", "_blank");
    expect(safeLink).toHaveAttribute("rel", "noreferrer nofollow");
    expect(screen.getByText("Опасная ссылка")).toHaveProperty("tagName", "SPAN");
    expect(screen.getByText("Опасная ссылка")).not.toHaveAttribute("href");

    const image = screen.getByRole("img", { name: "Схема" });

    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(container.querySelector("script")).toBeNull();
    expect(container).not.toHaveTextContent("window.__markdownXss");
    expect(container).not.toHaveTextContent("## Заголовок");
  });
});
