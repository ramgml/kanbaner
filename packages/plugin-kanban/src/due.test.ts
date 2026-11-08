import { describe, expect, it } from "vitest";

import { describeDue } from "./ui/due.ts";

const NOW = new Date("2026-11-08T12:00:00.000Z");

describe("describeDue", () => {
  it("помечает просроченный срок и сохраняет полную дату в описании", () => {
    const due = describeDue("2026-11-07T00:00:00.000Z", NOW);

    expect(due).toMatchObject({ label: "Просрочено", tone: "overdue" });
    expect(due.ariaLabel).toContain("Просрочено");
    expect(due.ariaLabel).toContain("07.11.2026");
  });

  it("различает сегодня и завтра по UTC-дню", () => {
    expect(describeDue("2026-11-08T23:59:59.999Z", NOW)).toMatchObject({
      label: "Сегодня",
      tone: "today",
    });
    expect(describeDue("2026-11-09T00:00:00.000Z", NOW)).toMatchObject({
      label: "Завтра",
      tone: "tomorrow",
    });
  });

  it("показывает дату для дальнего срока и «Без срока» для пустого", () => {
    expect(describeDue("2030-01-10T00:00:00.000Z", NOW)).toMatchObject({
      label: "10.01.2030",
      tone: "later",
    });
    expect(describeDue(null, NOW)).toMatchObject({ label: "Без срока", tone: "none" });
    expect(describeDue("", NOW)).toMatchObject({ label: "Без срока", tone: "none" });
  });

  it("не падает на невалидном значении", () => {
    expect(describeDue("not-a-date", NOW)).toMatchObject({
      label: "not-a-date",
      tone: "later",
    });
  });
});
