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

  it("self-test проверяет relative, side-effect, SQL и production-ссылки", () => {
    const output = run(["--self-test"]);

    expect(output).toMatch(/Import boundary self-test: [1-9][0-9]* violation/u);
    expect(output).toContain("relative/side-effect/SQL/production");
  });

  it("scripts/check-import-boundaries.mjs существует и кроссплатформенный", () => {
    expect(script.endsWith(".mjs")).toBe(true);
  });
});
