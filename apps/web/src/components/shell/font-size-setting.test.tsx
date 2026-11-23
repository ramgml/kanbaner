import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FontSizeSetting } from "./font-size-setting";
import { FONT_SCALE_STORAGE_KEY } from "./font-scale";

function renderSetting() {
  const view = render(<FontSizeSetting />);
  return {
    ...view,
    select: screen.getByRole("combobox", { name: "Размер шрифта" }) as HTMLSelectElement,
  };
}

function rootFontSize(): string {
  return document.documentElement.style.fontSize;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.fontSize = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("FontSizeSetting", () => {
  it("показывает native select с allowlist, значением 100% и helper-текстом", () => {
    const { select } = renderSetting();

    expect(select.tagName).toBe("SELECT");
    expect(select).toBeEnabled();
    expect(select).toHaveValue("100");
    expect(screen.getByLabelText("Размер шрифта")).toBe(select);
    expect(select).toHaveAccessibleDescription("Применяется сразу и сохраняется в этом браузере.");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "90%",
      "100%",
      "110%",
      "125%",
    ]);
    expect(rootFontSize()).toBe("100%");
  });

  it("применяет выбор к root font-size и сохраняет его в localStorage", () => {
    const { select } = renderSetting();

    fireEvent.change(select, { target: { value: "125" } });

    expect(select).toHaveValue("125");
    expect(rootFontSize()).toBe("125%");
    expect(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe("125");
  });

  it("восстанавливает сохранённое значение при монтировании после reload", () => {
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, "110");

    const { select } = renderSetting();

    expect(select).toHaveValue("110");
    expect(rootFontSize()).toBe("110%");
  });

  it.each(["150", "abc", ""])("невалидное сохранённое значение %j даёт 100%%", (stored) => {
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, stored);

    const { select } = renderSetting();

    expect(select).toHaveValue("100");
    expect(rootFontSize()).toBe("100%");
  });

  it("невалидное значение из события выбора даёт 100%", () => {
    const { select } = renderSetting();

    fireEvent.change(select, { target: { value: "150" } });

    expect(select).toHaveValue("100");
    expect(rootFontSize()).toBe("100%");
  });

  it("при недоступном localStorage чтение даёт 100% и не роняет UI", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage запрещён", "SecurityError");
    });

    const { select } = renderSetting();

    expect(select).toHaveValue("100");
    expect(rootFontSize()).toBe("100%");
  });

  it("ошибка записи в localStorage не отменяет применённый размер", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Квота исчерпана", "QuotaExceededError");
    });

    const { select } = renderSetting();

    fireEvent.change(select, { target: { value: "110" } });

    expect(select).toHaveValue("110");
    expect(rootFontSize()).toBe("110%");
  });

  it("доступен с клавиатуры как обычный select с label", () => {
    const { select } = renderSetting();

    select.focus();

    expect(document.activeElement).toBe(select);
    expect(select).toHaveAttribute("id");
    expect(screen.getByLabelText("Размер шрифта")).toHaveAttribute("id", select.id);
  });
});
