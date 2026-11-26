import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownContent } from "./markdown-content.tsx";

function CopyAction({ code }: { readonly code: string }) {
  return (
    <button type="button" data-testid="code-action" onClick={() => undefined}>
      {code}
    </button>
  );
}

afterEach(cleanup);

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

  it("без codeBlockAction не добавляет action и сохраняет прежнюю разметку pre", () => {
    const { container } = render(
      <MarkdownContent
        source={["Текст", "", "```ts", "const a = 1;", "const b = 2;", "```", "", "`inline`"].join(
          "\n",
        )}
      />,
    );

    expect(screen.queryByTestId("code-action")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("inline")).toHaveProperty("tagName", "CODE");

    const pre = container.querySelector("pre");

    expect(pre).not.toBeNull();
    expect(pre?.className).toContain("overflow-x-auto");
    expect(pre?.className).toContain("my-2");
    expect(pre?.parentElement).toHaveProperty("tagName", "DIV");
    expect(pre?.parentElement?.getAttribute("data-markdown-content")).not.toBeNull();
    expect(container.querySelectorAll("pre")).toHaveLength(1);
  });

  it("передаёт точный plain text fenced code block без renderer trailing newline", () => {
    const source = [
      "```ts",
      "const a = 1;",
      "  const b = 2;",
      "",
      "// <b>не HTML</b> & символы",
      "```",
    ].join("\n");

    render(<MarkdownContent source={source} codeBlockAction={CopyAction} />);

    const action = screen.getByTestId("code-action");

    expect(action.textContent).toBe("const a = 1;\n  const b = 2;\n\n// <b>не HTML</b> & символы");
    expect(document.querySelectorAll("[data-testid='code-action']")).toHaveLength(1);
  });

  it("inline code не получает action", () => {
    render(
      <MarkdownContent
        source="Только `inline` и ``двойной `код` ``."
        codeBlockAction={CopyAction}
      />,
    );

    expect(screen.queryByTestId("code-action")).toBeNull();
    expect(screen.getByText("inline")).toHaveProperty("tagName", "CODE");
  });

  it("пустой fence и fence из одного newline не получают action", () => {
    const { rerender } = render(
      <MarkdownContent source={"```\n```"} codeBlockAction={CopyAction} />,
    );

    expect(screen.queryByTestId("code-action")).toBeNull();
    expect(document.querySelector("pre")).not.toBeNull();

    rerender(<MarkdownContent source={"```\n\n```"} codeBlockAction={CopyAction} />);
    expect(screen.queryByTestId("code-action")).toBeNull();
  });

  it("сохраняет skipHtml и не пропускает raw HTML в code action", () => {
    const onAction = vi.fn();
    function SpyAction({ code }: { readonly code: string }) {
      onAction(code);
      return (
        <button type="button" data-testid="code-action">
          copy
        </button>
      );
    }
    const { container } = render(
      <MarkdownContent
        source={[
          "<script>window.__codeXss = true</script>",
          "",
          "```html",
          "<img src=x onerror=alert(1)>",
          "```",
        ].join("\n")}
        codeBlockAction={SpyAction}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(onAction).toHaveBeenCalledWith("<img src=x onerror=alert(1)>");
    expect(screen.getByTestId("code-action")).toBeInTheDocument();
  });
});
