// @vitest-environment node

import { describe, expect, it } from "vitest";

import { describeOperation as describeOperationFixture } from "./testing/fixtures.ts";
import {
  annotationsFor,
  buildToolCatalog,
  describeOperation,
  MAX_TOOL_NAME_LENGTH,
  supportsStructuredOutput,
  toolNameForOperation,
} from "./tools.ts";

describe("tool naming", () => {
  it("приводит operation ID к стабильному lowercase-имени", () => {
    expect(toolNameForOperation("kanbaner.tasks.task.list")).toBe("kanbaner_tasks_task_list");
    expect(toolNameForOperation("Kanbaner.Notes.Note.Create")).toBe("kanbaner_notes_note_create");
    expect(toolNameForOperation("a/b:c d")).toBe("a_b_c_d");
    expect(toolNameForOperation("__leading__and__trailing__")).toBe("leading__and__trailing");
  });

  it("нормализует camelCase как lowercase без вставки разделителей", () => {
    expect(toolNameForOperation("kanbaner.tasks.task.moveMany")).toBe(
      "kanbaner_tasks_task_movemany",
    );
  });

  it("отклоняет пустые и слишком длинные имена", () => {
    expect(toolNameForOperation("...")).toBeNull();
    expect(toolNameForOperation("a".repeat(MAX_TOOL_NAME_LENGTH + 1))).toBeNull();
    expect(toolNameForOperation("a".repeat(MAX_TOOL_NAME_LENGTH))).toHaveLength(
      MAX_TOOL_NAME_LENGTH,
    );
  });
});

describe("tool catalog", () => {
  it("публикует только http && mcp", () => {
    const catalog = buildToolCatalog(
      [
        describeOperationFixture({ id: "kanbaner.a.mcp" }),
        describeOperationFixture({
          id: "kanbaner.b.no-mcp",
          exposure: { ui: true, http: true, mcp: false },
        }),
        describeOperationFixture({
          id: "kanbaner.c.no-http",
          exposure: { ui: true, http: false, mcp: true },
        }),
        describeOperationFixture({
          id: "kanbaner.d.ui-only",
          exposure: { ui: true, http: false, mcp: false },
        }),
      ],
      { allowDestructive: false },
    );

    expect(catalog.map((tool) => tool.name)).toEqual(["kanbaner_a_mcp"]);
  });

  it("сортирует каталог по имени и видит новый descriptor без правок кода", () => {
    const before = buildToolCatalog([describeOperationFixture({ id: "kanbaner.z.query" })], {
      allowDestructive: false,
    });
    const after = buildToolCatalog(
      [
        describeOperationFixture({ id: "kanbaner.z.query" }),
        describeOperationFixture({ id: "kanbaner.a.new", kind: "mutation" }),
      ],
      { allowDestructive: false },
    );

    expect(before.map((tool) => tool.name)).toEqual(["kanbaner_z_query"]);
    expect(after.map((tool) => tool.name)).toEqual(["kanbaner_a_new", "kanbaner_z_query"]);
  });

  it("исключает обе стороны коллизии", () => {
    const diagnostics: string[] = [];
    const catalog = buildToolCatalog(
      [
        describeOperationFixture({ id: "kanbaner.a.b" }),
        describeOperationFixture({ id: "kanbaner.a:b" }),
        describeOperationFixture({ id: "kanbaner.safe.operation" }),
      ],
      { allowDestructive: false, onDiagnostic: (message) => diagnostics.push(message) },
    );

    expect(catalog.map((tool) => tool.name)).toEqual(["kanbaner_safe_operation"]);
    expect(diagnostics.join("\n")).toContain("kanbaner.a.b");
    expect(diagnostics.join("\n")).toContain("kanbaner.a:b");
  });

  it("скрывает destructive по умолчанию и показывает с явным флагом", () => {
    const operations = [
      describeOperationFixture({
        id: "kanbaner.tasks.task.delete",
        kind: "mutation",
        risk: "destructive",
      }),
    ];

    expect(buildToolCatalog(operations, { allowDestructive: false })).toEqual([]);

    const [tool] = buildToolCatalog(operations, { allowDestructive: true });

    expect(tool?.name).toBe("kanbaner_tasks_task_delete");
    expect(tool?.description.startsWith("DESTRUCTIVE.")).toBe(true);
    expect(tool?.annotations.destructiveHint).toBe(true);
  });

  it("описывает operation, risk и expectedVersion", () => {
    const tool = buildToolCatalog(
      [
        describeOperationFixture({
          id: "kanbaner.tasks.task.update",
          kind: "mutation",
          description: "Обновить задачу",
          inputSchema: {
            type: "object",
            properties: { expectedVersion: { type: "integer" } },
            required: ["expectedVersion"],
          },
        }),
      ],
      { allowDestructive: false },
    )[0];

    expect(tool?.description).toContain("Обновить задачу");
    expect(tool?.description).toContain("Operation: kanbaner.tasks.task.update");
    expect(tool?.description).toContain("Risk: write");
    expect(tool?.description).toContain("Requires expectedVersion.");
    expect(tool?.requiresExpectedVersion).toBe(true);
  });

  it("не подставляет expectedVersion, если его нет в схеме", () => {
    const tool = buildToolCatalog(
      [describeOperationFixture({ id: "kanbaner.tasks.task.create", kind: "mutation" })],
      { allowDestructive: false },
    )[0];

    expect(tool?.requiresExpectedVersion).toBe(false);
    expect(tool?.description).not.toContain("Requires expectedVersion.");
  });

  it("ставит annotations по kind и risk", () => {
    const query = describeOperationFixture({ id: "kanbaner.query" });
    const mutation = describeOperationFixture({ id: "kanbaner.mutation", kind: "mutation" });

    expect(annotationsFor(query)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotationsFor(mutation)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("пропускает некомпилируемую schema", () => {
    const diagnostics: string[] = [];
    const catalog = buildToolCatalog(
      [
        describeOperationFixture({
          id: "kanbaner.bad.schema",
          inputSchema: { type: "object", properties: { id: { type: "nope" } } },
        }),
      ],
      { allowDestructive: false, onDiagnostic: (message) => diagnostics.push(message) },
    );

    expect(catalog).toEqual([]);
    expect(diagnostics.join("\n")).toContain("kanbaner.bad.schema");
  });

  it("объявляет structuredContent только для object output", () => {
    const objectTool = buildToolCatalog(
      [describeOperationFixture({ id: "kanbaner.object.output" })],
      { allowDestructive: false },
    )[0];
    const arrayTool = buildToolCatalog(
      [
        describeOperationFixture({
          id: "kanbaner.array.output",
          outputSchema: null,
        }),
      ],
      { allowDestructive: false },
    )[0];

    expect(objectTool === undefined ? false : supportsStructuredOutput(objectTool)).toBe(true);
    expect(arrayTool === undefined ? true : supportsStructuredOutput(arrayTool)).toBe(false);
  });

  it("описание без description использует operation ID", () => {
    const operation = describeOperationFixture({ id: "kanbaner.plain.operation" });

    expect(describeOperation(operation)).toContain("kanbaner.plain.operation");
  });
});
