import { describe, expect, it } from "vitest";

import {
  JSON_SCHEMA_DIALECT,
  PluginManifestSchema,
  isHostApiRange,
  isPluginId,
  isSemVer,
  validatePluginManifest,
  type PluginManifest,
} from "./index.ts";

const fullManifest: PluginManifest = {
  id: "kanbaner.kanban",
  name: "Kanban",
  version: "1.0.0",
  hostApi: "^1.0.0",
  entrypoints: {
    server: "./dist/server.js",
    client: "./dist/client.js",
  },
  requires: {
    "kanbaner.tasks": "^1.0.0",
  },
  consumes: ["kanbaner.tasks.commands.v1", "kanbaner.tasks.queries.v1", "kanbaner.tasks.events.v1"],
  provides: ["kanbaner.kanban.ui.v1"],
  permissions: ["commands", "events", "ui", "storage"],
  migrations: "./migrations",
};

function expectInvalid(result: ReturnType<typeof validatePluginManifest>): void {
  expect(result.ok).toBe(false);
}

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

describe("PluginManifest", () => {
  it("принимает полный манифест Plugin Contract v1", () => {
    const result = validatePluginManifest(fullManifest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(fullManifest);
    }
  });

  it("принимает минимальный манифест без необязательных migrations", () => {
    const result = validatePluginManifest({
      id: "acme.calendar",
      name: "Calendar",
      version: "0.1.0-dev.0",
      hostApi: ">=1.0.0 <2.0.0",
      entrypoints: { client: "./dist/client.js" },
      requires: {},
      consumes: [],
      provides: [],
      permissions: [],
    });

    expect(result.ok).toBe(true);
  });

  it("отклоняет манифест без обязательного поля id с понятной ошибкой", () => {
    const result = validatePluginManifest(without(fullManifest, "id"));

    expectInvalid(result);
    if (!result.ok) {
      const required = result.errors.find((issue) => issue.keyword === "required");
      expect(required?.path).toBe("/");
      expect(required?.params).toMatchObject({ missingProperty: "id" });
    }
  });

  it("отклоняет манифест без обязательного поля name", () => {
    const result = validatePluginManifest(without(fullManifest, "name"));

    expectInvalid(result);
    if (!result.ok) {
      expect(
        result.errors.some(
          (issue) => issue.keyword === "required" && issue.params.missingProperty === "name",
        ),
      ).toBe(true);
    }
  });

  it("отклоняет некорректный Plugin ID", () => {
    for (const id of ["Kanbaner.Tasks", "kanbaner", "kanbaner..tasks", "kanbaner.tasks/create"]) {
      const result = validatePluginManifest({ ...fullManifest, id });

      expectInvalid(result);
      if (!result.ok) {
        expect(result.errors.some((issue) => issue.path === "/id")).toBe(true);
      }
    }
  });

  it("проверяет Plugin ID отдельным предикатом", () => {
    expect(isPluginId("kanbaner.tasks")).toBe(true);
    expect(isPluginId("acme.calendar")).toBe(true);
    expect(isPluginId("kanbaner")).toBe(false);
    expect(isPluginId("kanbaner.tasks.extra")).toBe(false);
    expect(isPluginId(42)).toBe(false);
  });

  it("принимает корректный SemVer и отклоняет некорректный", () => {
    expect(isSemVer("1.0.0")).toBe(true);
    expect(isSemVer("0.1.0-dev.0")).toBe(true);
    expect(isSemVer("1.0.0+build.7")).toBe(true);
    expect(isSemVer("1.0")).toBe(false);
    expect(isSemVer("v1.0.0")).toBe(false);
    expect(isSemVer("01.0.0")).toBe(false);

    const result = validatePluginManifest({ ...fullManifest, version: "1.0" });
    expectInvalid(result);
  });

  it("принимает разумные диапазоны Host API и отклоняет мусор", () => {
    for (const range of ["^1.0.0", "~1.2.0", ">=1.0.0 <2.0.0", "1.x", "*", "1.0.0 || 2.0.0"]) {
      expect(isHostApiRange(range)).toBe(true);
    }

    for (const range of ["", "banana", "^^1.0.0", "1.0.0.0"]) {
      expect(isHostApiRange(range)).toBe(false);
    }

    expectInvalid(validatePluginManifest({ ...fullManifest, hostApi: "banana" }));
  });

  it("требует хотя бы одну точку входа и не принимает неизвестные entrypoints", () => {
    expectInvalid(validatePluginManifest({ ...fullManifest, entrypoints: {} }));
    expectInvalid(
      validatePluginManifest({
        ...fullManifest,
        entrypoints: { worker: "./dist/worker.js" },
      }),
    );
  });

  it("проверяет ключи requires и значения диапазонов", () => {
    expectInvalid(
      validatePluginManifest({
        ...fullManifest,
        requires: { "Kanbaner.Tasks": "^1.0.0" },
      }),
    );
    expectInvalid(
      validatePluginManifest({
        ...fullManifest,
        requires: { "kanbaner.tasks": "not-a-range" },
      }),
    );
  });

  it("проверяет идентификаторы контрактов и уникальность consumes", () => {
    expectInvalid(
      validatePluginManifest({
        ...fullManifest,
        consumes: ["kanbaner.tasks.commands"],
      }),
    );
    expectInvalid(
      validatePluginManifest({
        ...fullManifest,
        consumes: ["kanbaner.tasks.commands.v1", "kanbaner.tasks.commands.v1"],
      }),
    );
  });

  it("проверяет тип migrations", () => {
    expectInvalid(
      validatePluginManifest({
        ...fullManifest,
        migrations: 42,
      }),
    );
  });

  it("публикует TypeBox-схему как Draft 2020-12", () => {
    expect(PluginManifestSchema.$schema).toBe(JSON_SCHEMA_DIALECT);
    expect(PluginManifestSchema.type).toBe("object");
    expect(PluginManifestSchema.required).toContain("id");
  });
});
