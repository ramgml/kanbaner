import { describe, expect, it } from "vitest";

import { BOARD_COLORS } from "@kanbaner/plugin-tasks/contract";

import {
  BOARD_COLOR_OPTIONS,
  boardColorLabel,
  boardColorSurface,
  boardColorSwatchClassName,
  resolveBoardColor,
} from "./ui/board-colors.ts";

describe("палитра доски", () => {
  it("покрывает весь контракт в его порядке и даёт русские имена", () => {
    expect(BOARD_COLOR_OPTIONS.map((option) => option.value)).toEqual([...BOARD_COLORS]);
    expect(new Set(BOARD_COLOR_OPTIONS.map((option) => option.label)).size).toBe(
      BOARD_COLORS.length,
    );
    expect(boardColorLabel("blue")).toBe("Синий");
    expect(boardColorLabel(undefined)).toBe("По умолчанию");
  });

  it("не применяет неизвестный цвет из данных и откатывается к default", () => {
    expect(resolveBoardColor("#ff0000")).toBe("default");
    expect(resolveBoardColor("linear-gradient(red, blue)")).toBe("default");
    expect(resolveBoardColor("neon")).toBe("default");
    expect(resolveBoardColor(null)).toBe("default");
    expect(resolveBoardColor("purple")).toBe("purple");
  });

  it("сохраняет прежнее оформление доски для default и задаёт light/dark обоим уровням", () => {
    const fallback = boardColorSurface(undefined);

    expect(fallback.boardClassName).toContain("bg-[#e2e8f0]");
    expect(fallback.boardClassName).toContain("dark:bg-[#1e293b]");
    expect(fallback.columnClassName).toContain("bg-[#f1f5f9]");
    expect(fallback.columnClassName).toContain("dark:bg-[#263244]");

    for (const color of BOARD_COLORS) {
      const surface = boardColorSurface(color);

      expect(surface.boardClassName).toContain("dark:");
      expect(surface.boardFadeClassName).toContain("dark:from-");
      expect(surface.columnClassName).toContain("dark:");
    }

    expect(new Set(BOARD_COLORS.map((color) => boardColorSurface(color).boardClassName)).size).toBe(
      BOARD_COLORS.length,
    );
    expect(
      new Set(BOARD_COLORS.map((color) => boardColorSurface(color).columnClassName)).size,
    ).toBe(BOARD_COLORS.length);
  });

  it("даёт различимые кружки и fallback для неизвестного значения", () => {
    expect(new Set(BOARD_COLORS.map((color) => boardColorSwatchClassName(color))).size).toBe(
      BOARD_COLORS.length,
    );
    expect(boardColorSwatchClassName("neon" as never)).toBe(boardColorSwatchClassName("default"));
  });
});
