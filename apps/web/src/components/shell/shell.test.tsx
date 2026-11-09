import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../../components/shell/app-shell";
import { PluginView } from "../../components/shell/plugin-view";
import { UiSlot } from "../../components/shell/ui-slot";
import type { UiPluginAvailability } from "../../lib/plugin-manager-types";
import { registerUiPlugin } from "../../ui/plugin-api";
import { createUiContributionRegistry } from "../../ui/registry";
import { brokenUiPlugin, testUiPlugin } from "../../ui/__fixtures__/test-ui-plugin";
import { UiRegistryProvider } from "../../ui/provider";

const navigation = vi.hoisted(() => ({ pathname: "/", search: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace }),
}));

function renderShell(
  availability?: UiPluginAvailability,
  register: (registry: ReturnType<typeof createUiContributionRegistry>) => void = (registry) => {
    registerUiPlugin(registry, testUiPlugin);
  },
): void {
  const registry = createUiContributionRegistry();
  register(registry);

  render(
    <UiRegistryProvider
      registry={registry}
      {...(availability === undefined ? {} : { availability })}
    >
      <AppShell>
        <div data-testid="page-content">Контент страницы</div>
        <UiSlot slot="app.main" />
      </AppShell>
    </UiRegistryProvider>,
  );
}

beforeEach(() => {
  navigation.pathname = "/";
  navigation.search = "";
});

afterEach(() => {
  cleanup();
});

describe("адаптивный app shell", () => {
  it("показывает desktop sidebar и mobile bottom navigation с клавиатурными ссылками", () => {
    renderShell();

    const desktop = screen.getByTestId("desktop-sidebar");
    const mobile = screen.getByTestId("mobile-navigation");

    expect(desktop).toHaveClass("hidden", "md:flex");
    expect(mobile).toHaveClass("md:hidden");
    expect(desktop).toHaveAttribute("aria-label", "Боковая панель");
    expect(mobile).toHaveAttribute("aria-label", "Мобильная навигация");
    expect(screen.getAllByRole("link", { name: "Обзор" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Плагины" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Настройки" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Настройки" })[0]).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getAllByRole("link", { name: "Настройки" })[1]).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getAllByRole("link", { name: "Тест UI" })).toHaveLength(2);
  });

  it("делает основные действия доступными на ширине 360 px", () => {
    window.innerWidth = 360;
    renderShell();

    expect(screen.getByTestId("mobile-navigation")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Обзор" })[1]).toHaveAttribute("href", "/");
    expect(screen.getByTestId("settings-link-mobile")).toHaveAttribute("href", "/settings");
    expect(screen.getByTestId("settings-link-mobile")).toHaveAccessibleName("Настройки");
    expect(screen.queryAllByRole("link", { name: "Плагины" })).toHaveLength(0);

    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("href");
    }
  });

  it("поддерживает skip link, main landmark и активный пункт настройки", () => {
    navigation.pathname = "/settings/plugins";
    renderShell();

    expect(screen.getByRole("link", { name: "К содержимому" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("link", { name: "Настройки" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("link", { name: "Настройки" })[1]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("link", { name: "Обзор" })[0]).not.toHaveAttribute("aria-current");
  });

  it("ведёт safe mode ссылки в настройки плагинов", () => {
    navigation.pathname = "/settings/plugins";

    const registry = createUiContributionRegistry();
    registerUiPlugin(registry, testUiPlugin);

    render(
      <UiRegistryProvider registry={registry}>
        <AppShell safeMode problemCount={2}>
          <div>Контент страницы</div>
        </AppShell>
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("safe-mode-notice")).toBeInTheDocument();
    expect(screen.getByTestId("settings-link-desktop")).toHaveAttribute("href", "/settings");
    expect(screen.getByTestId("settings-link-mobile")).toHaveAttribute("href", "/settings");

    const pluginManagerLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href") === "/settings/plugins");

    // safe mode notice, desktop sidebar и mobile navigation.
    expect(pluginManagerLinks).toHaveLength(3);
  });

  it("рендерит слоты app.details и app.overlays", () => {
    renderShell();

    expect(screen.getByTestId("details-slot")).toBeInTheDocument();
    expect(screen.getByText("Детали теста")).toBeInTheDocument();
    expect(screen.getByTestId("overlays-slot")).toBeInTheDocument();
    expect(screen.getByTestId("test-ui-overlay")).toBeInTheDocument();
  });

  it("показывает details aside только на маршруте вклада", () => {
    const registerRoutedDetails = (
      registry: ReturnType<typeof createUiContributionRegistry>,
    ): void => {
      registerUiPlugin(registry, {
        id: "example.routed-details",
        contributions: [
          {
            metadata: {
              id: "example.routed-details.panel",
              slot: "app.details",
              kind: "panel",
              priority: 1,
              route: "/view/tasks",
            },
            render: () => <div>Детали по маршруту</div>,
          },
        ],
      });
    };

    renderShell(undefined, registerRoutedDetails);

    expect(screen.queryByTestId("details-slot")).not.toBeInTheDocument();

    cleanup();
    navigation.pathname = "/view/tasks";
    renderShell(undefined, registerRoutedDetails);

    expect(screen.getByTestId("details-slot")).toBeInTheDocument();
    expect(screen.getByText("Детали по маршруту")).toBeInTheDocument();
  });

  it("держит main и details соседями горизонтального flex, колонка только у main", () => {
    renderShell();

    const main = screen.getByRole("main");
    const details = screen.getByTestId("details-slot");

    expect(details.parentElement).toBe(main.parentElement);
    expect(main.parentElement).toHaveClass("flex");
    expect(main).toHaveClass("flex", "flex-col");
  });

  it("скрывает вклад отключённого плагина", () => {
    renderShell({
      activePluginIds: [],
      unavailablePluginIds: ["example.test-ui"],
      safeMode: false,
      problemCount: 0,
    });

    expect(screen.queryByText("Тест UI")).not.toBeInTheDocument();
    expect(screen.queryByTestId("test-ui-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText("Детали теста")).not.toBeInTheDocument();
  });

  it("скрывает вклад плагина, которого нет в allowlist активных", () => {
    renderShell({
      activePluginIds: ["other.plugin"],
      unavailablePluginIds: [],
      safeMode: false,
      problemCount: 0,
    });

    // Плагин не входит ни в active, ни в unavailable: это unknown/removed ID,
    // поэтому его вклады не должны попасть в shell.
    expect(screen.queryByText("Тест UI")).not.toBeInTheDocument();
    expect(screen.queryByTestId("test-ui-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText("Детали теста")).not.toBeInTheDocument();
  });

  it("скрывает все вклады при пустом allowlist активных", () => {
    renderShell({
      activePluginIds: [],
      unavailablePluginIds: [],
      safeMode: false,
      problemCount: 0,
    });

    expect(screen.queryByText("Тест UI")).not.toBeInTheDocument();
    expect(screen.queryByTestId("test-ui-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText("Детали теста")).not.toBeInTheDocument();
  });

  it("показывает вклады только из allowlist активных", () => {
    renderShell({
      activePluginIds: ["example.test-ui"],
      unavailablePluginIds: [],
      safeMode: false,
      problemCount: 0,
    });

    expect(screen.getAllByRole("link", { name: "Тест UI" })).toHaveLength(2);
    expect(screen.getByTestId("test-ui-overlay")).toBeInTheDocument();
    expect(screen.getByText("Детали теста")).toBeInTheDocument();
  });
});

describe("маршрутизация представлений плагинов", () => {
  it("открывает зарегистрированный маршрут", () => {
    const registry = createUiContributionRegistry();
    registerUiPlugin(registry, testUiPlugin);

    render(
      <UiRegistryProvider registry={registry}>
        <PluginView pathname="/view/test-ui" />
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("test-ui-view")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Тестовое представление" })).toBeInTheDocument();
  });

  it("показывает пустое состояние для неизвестного маршрута", () => {
    const registry = createUiContributionRegistry();
    registerUiPlugin(registry, testUiPlugin);

    render(
      <UiRegistryProvider registry={registry}>
        <PluginView pathname="/view/unknown" />
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("plugin-view-empty")).toBeInTheDocument();
    expect(screen.getByText("Представление не найдено")).toBeInTheDocument();
  });

  it("не открывает маршрут отключённого плагина", () => {
    const registry = createUiContributionRegistry();
    registerUiPlugin(registry, testUiPlugin);

    render(
      <UiRegistryProvider
        registry={registry}
        availability={{
          activePluginIds: [],
          unavailablePluginIds: ["example.test-ui"],
          safeMode: false,
          problemCount: 0,
        }}
      >
        <PluginView pathname="/view/test-ui" />
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("plugin-view-empty")).toBeInTheDocument();
  });
});

describe("границы ошибок UI-вкладов", () => {
  it("изолирует падение одного вклада и сохраняет shell", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    function register(registry: ReturnType<typeof createUiContributionRegistry>): void {
      registerUiPlugin(registry, testUiPlugin);
      registerUiPlugin(registry, brokenUiPlugin);
    }

    renderShell(undefined, register);

    expect(screen.getByTestId("contribution-error")).toBeInTheDocument();
    expect(screen.getByText("Не удалось показать вклад")).toBeInTheDocument();
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
    expect(screen.getByText("Панель обзора")).toBeInTheDocument();
    expect(screen.queryByText("/secret/path")).not.toBeInTheDocument();

    errorSpy.mockRestore();
  });

  it("рендерит каждый слот внутри собственной границы ошибок", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = createUiContributionRegistry();
    registerUiPlugin(registry, brokenUiPlugin);

    render(
      <UiRegistryProvider registry={registry}>
        <UiSlot slot="app.main" />
      </UiRegistryProvider>,
    );

    expect(screen.getAllByTestId("contribution-error")).toHaveLength(1);
    errorSpy.mockRestore();
  });
});
