import { describe, expect, it } from "vitest";

import { validateWithSchema } from "@kanbaner/plugin-sdk";

import { BOARD_COLORS, BoardColorSchema } from "./board-color.ts";

describe("board color schema", () => {
  it("фиксирует общую палитру проекта и колонок без дублей", () => {
    expect(BOARD_COLORS).toEqual([
      "default",
      "slate",
      "blue",
      "green",
      "yellow",
      "orange",
      "red",
      "purple",
    ]);
    expect(new Set(BOARD_COLORS).size).toBe(BOARD_COLORS.length);
  });

  it("принимает каждое значение палитры", () => {
    for (const color of BOARD_COLORS) {
      expect(validateWithSchema(BoardColorSchema, color).ok).toBe(true);
    }
  });

  it("отклоняет произвольные CSS-значения и неизвестные имена", () => {
    for (const color of ["#ff0000", "rgb(255,0,0)", "", "Default", "pink"]) {
      expect(validateWithSchema(BoardColorSchema, color).ok).toBe(false);
    }
  });
});
