import "@testing-library/jest-dom/vitest";

import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoteTitleField } from "./note-title-field.tsx";

const LONG_TITLE = `Заголовок ${"сверхдлинноесловобезпробелов".repeat(2)}`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NoteTitleField", () => {
  it("показывает заголовок многострочным полем и растягивается по содержимому", () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(148);

    render(<NoteTitleField value={LONG_TITLE} onChange={() => undefined} />);
    const field = screen.getByTestId<HTMLTextAreaElement>("note-title");

    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveAttribute("aria-label", "Заголовок заметки");
    expect(field).toHaveValue(LONG_TITLE);
    expect(field).toHaveAttribute("rows", "1");
    expect(field.style.height).toBe("148px");
  });

  it("пересчитывает высоту после смены значения и снимает disabled", () => {
    const scrollHeight = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(48);
    const { rerender } = render(
      <NoteTitleField value="Короткий" disabled onChange={() => undefined} />,
    );
    const field = screen.getByTestId<HTMLTextAreaElement>("note-title");
    expect(field).toBeDisabled();
    expect(field.style.height).toBe("48px");

    scrollHeight.mockReturnValue(132);
    rerender(<NoteTitleField value={LONG_TITLE} onChange={() => undefined} />);

    expect(field).not.toBeDisabled();
    expect(field.style.height).toBe("132px");
  });

  it("по Enter не вставляет перевод строки и завершает редактирование", () => {
    const onChange = vi.fn();
    render(<NoteTitleField value="Заголовок" onChange={onChange} />);
    const field = screen.getByTestId<HTMLTextAreaElement>("note-title");
    field.focus();
    expect(field).toHaveFocus();

    const enter = createEvent.keyDown(field, { key: "Enter" });
    fireEvent(field, enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(field).not.toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("схлопывает вставленные переводы строк", () => {
    const onChange = vi.fn();
    render(<NoteTitleField value="" onChange={onChange} />);

    fireEvent.change(screen.getByTestId("note-title"), {
      target: { value: "Первая строка\r\nВторая строка\nТретья" },
    });

    expect(onChange).toHaveBeenCalledWith("Первая строка Вторая строка Третья");
  });
});
