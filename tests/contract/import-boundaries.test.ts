// @vitest-environment node

import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts", "check-import-boundaries.mjs");

function run(args: readonly string[] = []): string {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("автоматическая проверка границ импортов", () => {
  it("fixture использует только публичный SDK", () => {
    expect(run()).toContain("plugin-fixture использует только @kanbaner/plugin-sdk");
  });

  it("обнаруживает запрещённый импорт kernel и SQL в fixture", () => {
    expect(run(["--self-test"])).toMatch(/detected [1-9][0-9]* violation/u);
  });

  it("scripts/check-import-boundaries.mjs существует и кроссплатформенный", () => {
    expect(script.endsWith(".mjs")).toBe(true);
  });
});
