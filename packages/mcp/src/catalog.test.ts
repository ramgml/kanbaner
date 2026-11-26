// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseDiscoveryDocument } from "./discovery.ts";
import { discoveryEnvelope, rawOperation } from "./testing/fixtures.ts";
import { buildToolCatalog } from "./tools.ts";

function catalogOf(operations: readonly unknown[], allowDestructive = false) {
  return buildToolCatalog(parseDiscoveryDocument(discoveryEnvelope(operations)), {
    allowDestructive,
  });
}

describe("catalog from discovery", () => {
  it("строит tools только из http && mcp и видит synthetic descriptor", () => {
    const base = [
      rawOperation({ id: "kanbaner.tasks.task.list" }),
      rawOperation({
        id: "kanbaner.tasks.task.delete",
        kind: "mutation",
        risk: "destructive",
      }),
      rawOperation({
        id: "kanbaner.internal.operation",
        exposure: { ui: true, http: true, mcp: false },
      }),
      rawOperation({
        id: "kanbaner.ui.only",
        exposure: { ui: true, http: false, mcp: true },
      }),
    ];

    expect(catalogOf(base).map((tool) => tool.name)).toEqual(["kanbaner_tasks_task_list"]);

    const withSynthetic = [
      ...base,
      rawOperation({
        id: "kanbaner.search.query",
        description: "Глобальный поиск",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      }),
    ];

    expect(catalogOf(withSynthetic).map((tool) => tool.name)).toEqual([
      "kanbaner_search_query",
      "kanbaner_tasks_task_list",
    ]);
  });

  it("исключает коллизии имён, полученные нормализацией", () => {
    const catalog = catalogOf([
      rawOperation({ id: "kanbaner.note.link" }),
      rawOperation({ id: "kanbaner.note:link" }),
      rawOperation({ id: "kanbaner.note.unlink" }),
    ]);

    expect(catalog.map((tool) => tool.name)).toEqual(["kanbaner_note_unlink"]);
  });

  it("не публикует destructive неявно", () => {
    const operations = [
      rawOperation({
        id: "kanbaner.notes.note.delete",
        kind: "mutation",
        risk: "destructive",
      }),
    ];

    expect(catalogOf(operations)).toEqual([]);
    expect(catalogOf(operations, true).map((tool) => tool.name)).toEqual([
      "kanbaner_notes_note_delete",
    ]);
  });
});
