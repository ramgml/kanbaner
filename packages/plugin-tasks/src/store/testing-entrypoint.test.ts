import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function resolvePackageRoot(): string {
  const fromRepositoryRoot = path.resolve(process.cwd(), "packages", "plugin-tasks");

  return existsSync(path.join(fromRepositoryRoot, "package.json"))
    ? fromRepositoryRoot
    : process.cwd();
}

const packageRoot = resolvePackageRoot();
const testingDist = path.join(packageRoot, "dist", "testing.js");

describe("subpath @kanbaner/plugin-tasks/testing", () => {
  it("публикует только testing entrypoint и не меняет production export", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      readonly exports?: Readonly<Record<string, unknown>>;
    };

    expect(manifest.exports?.["./testing"]).toEqual({
      types: "./dist/testing.d.ts",
      import: "./dist/testing.js",
    });
    expect(manifest.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(manifest.exports?.["./contract"]).toEqual({
      types: "./dist/contract.d.ts",
      import: "./dist/contract.js",
    });
  });

  it("импортируется в runtime и не тянет kernel, SQLite или Vitest", async () => {
    expect(
      existsSync(testingDist),
      "Соберите пакет: pnpm --filter @kanbaner/plugin-tasks build",
    ).toBe(true);

    const source = readFileSync(testingDist, "utf8");

    expect(source).not.toMatch(/@kanbaner\/kernel/u);
    expect(source).not.toMatch(/@kanbaner\/storage-sqlite/u);
    expect(source).not.toMatch(/from\s+["']vitest["']/u);

    const testing = (await import("@kanbaner/plugin-tasks/testing")) as Record<string, unknown>;

    expect(testing.createTasksStoreConformanceSuite).toBeTypeOf("function");

    const suite = (
      testing.createTasksStoreConformanceSuite as (options: {
        readonly createStore: () => never;
      }) => readonly { readonly name: string }[]
    )({
      createStore: () => {
        throw new Error("createStore не вызывается при построении suite");
      },
    });

    expect(suite.length).toBeGreaterThan(0);
  });
});
