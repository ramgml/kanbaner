import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionHistory, type SessionSwitchResult } from "./session-history.tsx";
import type { OpenCodeSessionSummary } from "./types.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const items: readonly OpenCodeSessionSummary[] = [
  { id: "ses-1", title: "Старое имя", updatedAt: Date.UTC(2026, 10, 24, 11, 0) },
  { id: "ses-abcdef123456", title: "Первая", updatedAt: Date.UTC(2026, 10, 24, 10, 30) },
  { id: "ses-2", title: null, updatedAt: Date.UTC(2026, 10, 23, 9, 5) },
];

function history(): HTMLDetailsElement {
  const details = screen.getByTestId("opencode-session-history");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("history is missing");
  return details;
}

function open(): void {
  if (!history().open) fireEvent.click(within(history()).getByText("История сессий"));
  expect(history().open).toBe(true);
}

function selectTarget(name: string): void {
  fireEvent.click(within(history()).getByRole("button", { name: new RegExp(`^${name}`) }));
}

function renderHistory(overrides: {
  readonly loadSessions?: (signal: AbortSignal) => Promise<readonly OpenCodeSessionSummary[]>;
  readonly onSelect?: (sessionID: string) => Promise<SessionSwitchResult>;
  readonly busy?: boolean;
  readonly version?: number;
  readonly currentID?: string | null;
  readonly currentTitle?: string | null;
}) {
  const loadSessions = overrides.loadSessions ?? vi.fn(async () => items);
  const onSelect = overrides.onSelect ?? vi.fn(async () => ({ ok: true as const }));
  const view = render(
    <SessionHistory
      currentID={overrides.currentID === undefined ? "ses-1" : overrides.currentID}
      currentTitle={overrides.currentTitle === undefined ? "Текущая" : overrides.currentTitle}
      busy={overrides.busy ?? false}
      version={overrides.version ?? 0}
      loadSessions={loadSessions}
      onSelect={onSelect}
    />,
  );
  return { ...view, loadSessions, onSelect };
}

describe("SessionHistory", () => {
  it("не загружает список до раскрытия и рендерит текущий title, дату и суффикс ID", async () => {
    const { loadSessions } = renderHistory({});

    expect(loadSessions).not.toHaveBeenCalled();
    open();
    await waitFor(() => expect(loadSessions).toHaveBeenCalledOnce());
    expect(await screen.findByText("Первая")).toBeVisible();
    expect(screen.getByText("Без названия")).toBeVisible();
    expect(screen.getByText(/123456/)).toBeVisible();
    expect(within(history()).getByRole("button", { name: /^Текущая/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("кэширует список на 30 секунд и сбрасывает кэш по version", async () => {
    const loadSessions = vi.fn(async () => items);
    const { rerender } = renderHistory({ loadSessions });

    open();
    await screen.findByText("Первая");
    history().open = false;
    open();
    expect(loadSessions).toHaveBeenCalledOnce();

    rerender(
      <SessionHistory
        currentID="ses-1"
        currentTitle="Текущая"
        busy={false}
        version={1}
        loadSessions={loadSessions}
        onSelect={async () => ({ ok: true })}
      />,
    );
    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(2));
  });

  it("показывает ошибку загрузки и повторяет запрос по кнопке", async () => {
    const loadSessions = vi
      .fn<(signal: AbortSignal) => Promise<readonly OpenCodeSessionSummary[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(items);
    renderHistory({ loadSessions });

    open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить историю сессий");

    fireEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Первая")).toBeVisible();
    expect(loadSessions).toHaveBeenCalledTimes(2);
  });

  it("удаляет только not-found запись и не меняет текущую сессию", async () => {
    const onSelect = vi.fn(async () => ({ ok: false as const, reason: "not-found" as const }));
    renderHistory({ onSelect });

    open();
    await screen.findByText("Первая");
    selectTarget("Первая");

    await waitFor(() => expect(screen.queryByText("Первая")).toBeNull());
    expect(screen.getByText("Без названия")).toBeVisible();
    expect(within(history()).getByRole("button", { name: /^Текущая/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(onSelect).toHaveBeenCalledWith("ses-abcdef123456");
  });

  it("показывает switch-ошибку и повторяет выбор без потери списка", async () => {
    const onSelect = vi
      .fn<(sessionID: string) => Promise<SessionSwitchResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true });
    renderHistory({ onSelect });

    open();
    await screen.findByText("Первая");
    selectTarget("Первая");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось открыть сессию");
    expect(screen.getByText("Первая")).toBeVisible();

    fireEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(history().open).toBe(false));
  });

  it("блокирует выбор при busy и не вызывает onSelect", async () => {
    const onSelect = vi.fn(async () => ({ ok: true as const }));
    renderHistory({ onSelect, busy: true });

    open();
    const first = await within(history()).findByRole("button", { name: /^Первая/ });
    expect(first).toBeDisabled();
    fireEvent.click(first);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Escape закрывает историю и возвращает фокус на summary", async () => {
    renderHistory({});
    open();
    await screen.findByText("Первая");

    fireEvent.keyDown(history(), { key: "Escape" });

    expect(history().open).toBe(false);
    expect(within(history()).getByText("История сессий").closest("summary")).toHaveFocus();
  });

  it("показывает Открываем… на выбранной записи до завершения switch", async () => {
    let finish: ((result: SessionSwitchResult) => void) | undefined;
    const onSelect = vi.fn(
      () =>
        new Promise<SessionSwitchResult>((resolve) => {
          finish = resolve;
        }),
    );
    renderHistory({ onSelect });

    open();
    await screen.findByText("Первая");
    selectTarget("Первая");

    expect(screen.getByText(/Открываем…/u)).toBeVisible();
    expect(within(history()).getByRole("button", { name: /^Без названия/ })).toBeDisabled();
    finish?.({ ok: false, reason: "unavailable" });
    await screen.findByRole("alert");
  });
});
