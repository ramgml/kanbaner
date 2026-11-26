import { describe, expect, it } from "vitest";

import {
  FONT_SCALE_BOOTSTRAP_SCRIPT,
  FONT_SCALE_DEFAULT,
  FONT_SCALE_OPTIONS,
  FONT_SCALE_STORAGE_KEY,
  normalizeFontScale,
  readStoredFontScale,
} from "./font-scale";

describe("font-scale", () => {
  it("пропускает только значения allowlist", () => {
    for (const option of FONT_SCALE_OPTIONS) {
      expect(normalizeFontScale(option)).toBe(option);
      expect(normalizeFontScale(String(option))).toBe(option);
    }

    for (const invalid of [89, 101, 0, -100, 1.5, Number.NaN, "", "90%", "abc", null, undefined]) {
      expect(normalizeFontScale(invalid)).toBe(FONT_SCALE_DEFAULT);
    }
  });

  it("не делает numeric coercion неканонических строк", () => {
    for (const invalid of ["090", " 90 ", "9e1", "0x5a", "+90", "90.0", "1e2"]) {
      expect(normalizeFontScale(invalid)).toBe(FONT_SCALE_DEFAULT);
    }

    expect(normalizeFontScale(90)).toBe(90);
    expect(normalizeFontScale("90")).toBe(90);
    expect(normalizeFontScale(125)).toBe(125);
    expect(normalizeFontScale("125")).toBe(125);
  });

  it("читает сохранённое значение и безопасно падает в 100%", () => {
    expect(readStoredFontScale({ getItem: () => "110" })).toBe(110);
    expect(readStoredFontScale({ getItem: () => null })).toBe(FONT_SCALE_DEFAULT);
    expect(readStoredFontScale({ getItem: () => "150" })).toBe(FONT_SCALE_DEFAULT);
    expect(
      readStoredFontScale({
        getItem: () => {
          throw new Error("storage недоступен");
        },
      }),
    ).toBe(FONT_SCALE_DEFAULT);
    expect(readStoredFontScale(null)).toBe(FONT_SCALE_DEFAULT);
  });

  it("bootstrap читает только ключ размера и не содержит eval", () => {
    expect(FONT_SCALE_BOOTSTRAP_SCRIPT).toContain(FONT_SCALE_STORAGE_KEY);
    expect(FONT_SCALE_BOOTSTRAP_SCRIPT).toContain("localStorage.getItem");
    expect(FONT_SCALE_BOOTSTRAP_SCRIPT).toContain(String(FONT_SCALE_DEFAULT));
    expect(FONT_SCALE_BOOTSTRAP_SCRIPT).not.toMatch(/eval|new Function/u);
  });
});
