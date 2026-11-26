import { describe, expect, it } from "vitest";

import { parseTaskListQuery } from "../task-list/query-state.ts";
import { parseKanbanQuery } from "./query-state.ts";
import { parseWorkspaceResource } from "./resource-query.ts";

describe("разбор query-параметра resource", () => {
  it("переводит ResourceRef задачи в taskId", () => {
    expect(parseWorkspaceResource("kanbaner.tasks:task:task-1")).toEqual({
      taskId: "task-1",
    });
  });

  it("переводит ResourceRef проекта в projectId", () => {
    expect(parseWorkspaceResource("kanbaner.tasks:project:project-1")).toEqual({
      projectId: "project-1",
    });
  });

  it("игнорирует пустую строку, отсутствующее значение и пробелы", () => {
    expect(parseWorkspaceResource("")).toEqual({});
    expect(parseWorkspaceResource("   ")).toEqual({});
    expect(parseWorkspaceResource(null)).toEqual({});
    expect(parseWorkspaceResource(undefined)).toEqual({});
  });

  it("игнорирует повреждённую ссылку", () => {
    expect(parseWorkspaceResource("not-a-ref")).toEqual({});
    expect(parseWorkspaceResource("kanbaner.tasks:task")).toEqual({});
  });

  it("игнорирует ресурс чужого плагина", () => {
    expect(parseWorkspaceResource("kanbaner.notes:note:note-1")).toEqual({});
  });

  it("игнорирует поддерживаемый, но не открываемый тип ресурса", () => {
    expect(parseWorkspaceResource("kanbaner.tasks:task-column:column-1")).toEqual({});
  });

  it("обрезает пробелы вокруг значения", () => {
    expect(parseWorkspaceResource("  kanbaner.tasks:task:task-1  ")).toEqual({
      taskId: "task-1",
    });
  });
});

describe("resource в состоянии доски и списка", () => {
  it("доска открывает задачу из ResourceRef", () => {
    const query = parseKanbanQuery("?resource=kanbaner.tasks%3Atask%3Atask-1");

    expect(query.taskId).toBe("task-1");
    expect(query.projectId).toBe("");
  });

  it("доска открывает проект из ResourceRef", () => {
    expect(parseKanbanQuery("?resource=kanbaner.tasks%3Aproject%3Aproject-1").projectId).toBe(
      "project-1",
    );
  });

  it("явные ключи task и project имеют приоритет над resource", () => {
    const query = parseKanbanQuery(
      "?task=explicit-task&project=explicit-project&resource=kanbaner.tasks%3Atask%3Aother",
    );

    expect(query.taskId).toBe("explicit-task");
    expect(query.projectId).toBe("explicit-project");
  });

  it("список задач открывает задачу из ResourceRef", () => {
    const query = parseTaskListQuery("?resource=kanbaner.tasks%3Atask%3Atask-1");

    expect(query.taskId).toBe("task-1");
  });

  it("список задач открывает проект из ResourceRef", () => {
    expect(parseTaskListQuery("?resource=kanbaner.tasks%3Aproject%3Aproject-1").projectId).toBe(
      "project-1",
    );
  });

  it("список задач сохраняет явные ключи при наличии resource", () => {
    const query = parseTaskListQuery(
      "?project=explicit-project&task=explicit-task&resource=kanbaner.tasks%3Atask%3Aother",
    );

    expect(query.projectId).toBe("explicit-project");
    expect(query.taskId).toBe("explicit-task");
  });

  it("чужой ResourceRef не влияет на состояние", () => {
    const search = "?resource=kanbaner.notes%3Anote%3Anote-1";

    expect(parseKanbanQuery(search).taskId).toBeNull();
    expect(parseTaskListQuery(search).taskId).toBeNull();
  });
});
