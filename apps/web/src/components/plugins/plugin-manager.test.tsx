import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PluginManagerEntry,
  PluginManagerActionResult,
  PluginManagerState,
} from "../../lib/plugin-manager-types";
import { PluginManager } from "./plugin-manager";

const actions = vi.hoisted(() => ({
  setPluginEnabled: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../server/plugin-actions", () => ({
  setPluginEnabledAction: actions.setPluginEnabled,
  refreshPluginsAction: actions.refresh,
}));

function plugin(overrides: Partial<PluginManagerEntry> = {}): PluginManagerEntry {
  return {
    id: "example.one",
    source: "root#0/one/plugin.json",
    name: "Example One",
    version: "1.2.3",
    hostApi: "^1.0.0",
    status: "active",
    configuredEnabled: true,
    activated: true,
    canToggle: true,
    requires: [{ id: "example.base", range: "^2.0.0" }],
    consumes: [],
    provides: [],
    permissions: ["events"],
    diagnostics: [],
    lastError: null,
    ...overrides,
  };
}

function state(overrides: Partial<PluginManagerState> = {}): PluginManagerState {
  return {
    mode: "normal",
    safeMode: false,
    started: true,
    plugins: [plugin()],
    problems: [],
    disabledPluginIds: [],
    checkedAt: "2026-11-06T12:00:00.000Z",
    ...overrides,
  };
}

function result(nextState: PluginManagerState): PluginManagerActionResult {
  return { ok: true, state: nextState, error: null };
}

beforeEach(() => {
  actions.setPluginEnabled.mockReset();
  actions.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("plugin manager", () => {
  it("показывает версии, зависимости, состояние и последние ошибки", () => {
    render(
      <PluginManager
        initialState={state({
          plugins: [
            plugin({
              diagnostics: [
                {
                  code: "activation_failed",
                  severity: "error",
                  phase: "server_activation",
                  message: "Серверная активация плагина завершилась ошибкой",
                },
              ],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByRole("heading", { name: "Плагины" })).toBeInTheDocument();
    expect(screen.getByText("Example One")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText(/example\.base/)).toBeInTheDocument();
    expect(screen.getByText("Активен")).toBeInTheDocument();
    expect(screen.getAllByText("activation_failed").length).toBeGreaterThan(0);
    expect(screen.getByText("Серверная активация плагина завершилась ошибкой")).toBeInTheDocument();
  });

  it("показывает safe mode с проблемными плагинами и причинами", () => {
    render(
      <PluginManager
        initialState={state({
          mode: "safe_mode",
          safeMode: true,
          problems: [
            {
              pluginId: "example.broken",
              source: "root#0/broken/plugin.json",
              status: "failed",
              code: "activation_failed",
              message: "Серверная активация плагина завершилась ошибкой",
            },
          ],
        })}
      />,
    );

    const panel = screen.getByTestId("safe-mode-panel");

    expect(panel).toHaveTextContent("Safe mode");
    expect(panel).toHaveTextContent("example.broken");
    expect(panel).toHaveTextContent("activation_failed");
    expect(panel).toHaveTextContent("Серверная активация плагина завершилась ошибкой");
  });

  it("отключает плагин через действие и показывает актуальное состояние без перезагрузки", async () => {
    const initial = state();
    const updated = state({
      plugins: [
        plugin({
          status: "disabled",
          configuredEnabled: false,
          activated: false,
        }),
      ],
      disabledPluginIds: ["example.one"],
    });

    actions.setPluginEnabled.mockResolvedValue(result(updated));

    render(<PluginManager initialState={initial} />);

    const control = screen.getByRole("switch", { name: "Включить плагин Example One" });

    control.focus();
    expect(control).toHaveFocus();

    fireEvent.click(control);

    await waitFor(() => {
      expect(actions.setPluginEnabled).toHaveBeenCalledWith("example.one", false);
    });

    expect(await screen.findByText("Активных: 0")).toBeInTheDocument();
    expect(screen.getAllByText("Отключён").length).toBeGreaterThan(0);
    expect(screen.getByText("Отключено в конфигурации: 1")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-action-error")).not.toBeInTheDocument();
  });

  it("включает плагин обратно", async () => {
    const initial = state({
      plugins: [
        plugin({
          status: "disabled",
          configuredEnabled: false,
          activated: false,
        }),
      ],
      disabledPluginIds: ["example.one"],
    });

    actions.setPluginEnabled.mockResolvedValue(result(state()));

    render(<PluginManager initialState={initial} />);

    fireEvent.click(screen.getByRole("switch", { name: "Включить плагин Example One" }));

    await waitFor(() => {
      expect(actions.setPluginEnabled).toHaveBeenCalledWith("example.one", true);
    });

    expect(await screen.findByText("Активных: 1")).toBeInTheDocument();
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });

  it("показывает безопасную ошибку, если действие не выполнено", async () => {
    actions.setPluginEnabled.mockResolvedValue({
      ok: false,
      state: null,
      error: { code: "INTERNAL_ERROR", message: "Не удалось изменить состояние плагина" },
    });

    render(<PluginManager initialState={state()} />);

    fireEvent.click(screen.getByRole("switch", { name: "Включить плагин Example One" }));

    expect(await screen.findByTestId("plugin-action-error")).toHaveTextContent(
      "Не удалось изменить состояние плагина",
    );
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });

  it("показывает stopped snapshot, если действие завершилось ошибкой деактивации", async () => {
    actions.setPluginEnabled.mockResolvedValue({
      ok: false,
      state: state({
        started: false,
        safeMode: true,
        mode: "safe_mode",
        plugins: [
          plugin({
            status: "failed",
            activated: false,
            diagnostics: [
              {
                code: "deactivation_failed",
                severity: "error",
                phase: "deactivation",
                message: "Серверная деактивация плагина завершилась ошибкой",
              },
            ],
          }),
        ],
        problems: [
          {
            pluginId: "example.one",
            source: "root#0/one/plugin.json",
            status: "failed",
            code: "deactivation_failed",
            message: "Серверная деактивация плагина завершилась ошибкой",
          },
        ],
      }),
      error: {
        code: "DEACTIVATION_FAILED",
        message: "Плагин не удалось безопасно деактивировать",
      },
    });

    render(<PluginManager initialState={state()} />);

    fireEvent.click(screen.getByRole("switch", { name: "Включить плагин Example One" }));

    expect(await screen.findByTestId("plugin-action-error")).toHaveTextContent(
      "Плагин не удалось безопасно деактивировать",
    );
    expect(screen.getByTestId("safe-mode-panel")).toBeInTheDocument();
    expect(screen.getByText("deactivation_failed")).toBeInTheDocument();
    expect(screen.getByText("Runtime остановлен")).toBeInTheDocument();
  });

  it("перехватывает rejected toggle и снимает pending", async () => {
    actions.setPluginEnabled.mockRejectedValue(new Error("server action failed"));

    render(<PluginManager initialState={state()} />);

    const control = screen.getByRole("switch", { name: "Включить плагин Example One" });

    fireEvent.click(control);

    expect(await screen.findByTestId("plugin-action-error")).toHaveTextContent(
      "Не удалось изменить состояние плагина",
    );
    await waitFor(() => {
      expect(control).not.toBeDisabled();
    });
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });

  it("перехватывает rejected refresh и снимает pending", async () => {
    actions.refresh.mockRejectedValue(new Error("server action failed"));

    render(<PluginManager initialState={state()} />);

    const button = screen.getByRole("button", { name: "Обновить" });

    fireEvent.click(button);

    expect(await screen.findByTestId("plugin-action-error")).toHaveTextContent(
      "Не удалось изменить состояние плагина",
    );
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it("рендерит обе карточки с одинаковым ID и разными источниками после refresh", async () => {
    actions.refresh.mockResolvedValue(
      result(
        state({
          plugins: [
            plugin({ source: "root#0/a/plugin.json" }),
            plugin({ source: "root#1/b/plugin.json", name: "Example Two" }),
          ],
        }),
      ),
    );

    render(<PluginManager initialState={state()} />);

    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("plugin-card")).toHaveLength(2);
    });

    expect(screen.getByText("root#0/a/plugin.json")).toBeInTheDocument();
    expect(screen.getByText("root#1/b/plugin.json")).toBeInTheDocument();
    expect(screen.getAllByText("example.one")).toHaveLength(2);
  });

  it("обновляет снимок состояния кнопкой «Обновить»", async () => {
    actions.refresh.mockResolvedValue(
      result(
        state({
          checkedAt: "2026-11-06T12:30:00.000Z",
          plugins: [plugin({ name: "Example Updated" })],
        }),
      ),
    );

    render(<PluginManager initialState={state()} />);

    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));

    await waitFor(() => {
      expect(actions.refresh).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText("Example Updated")).toBeInTheDocument();
    expect(screen.getByText(/2026-11-06 12:30:00 UTC/)).toBeInTheDocument();
  });

  it("показывает пустое состояние и single-column раскладку для 360 px", () => {
    window.innerWidth = 360;

    render(<PluginManager initialState={state({ plugins: [] })} />);

    expect(screen.getByTestId("plugins-empty")).toBeInTheDocument();

    cleanup();
    render(<PluginManager initialState={state()} />);

    const grid = screen.getByTestId("plugin-card").parentElement;

    expect(grid).toHaveClass("grid-cols-1");
    expect(grid).toHaveClass("lg:grid-cols-2");
  });
});
