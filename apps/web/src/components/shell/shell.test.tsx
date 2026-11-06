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

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
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
    expect(screen.getAllByRole("link", { name: "Плагины" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Настройки" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Тест UI" })).toHaveLength(2);
  });

  it("делает основные действия доступными на ширине 360 px", () => {
    window.innerWidth = 360;
    renderShell();

    expect(screen.getByTestId("mobile-navigation")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Плагины" })[1]).toHaveAttribute("href", "/plugins");

    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("href");
    }
  });

  it("поддерживает skip link, main landmark и активный пункт навигации", () => {
    navigation.pathname = "/plugins";
    renderShell();

    expect(screen.getByRole("link", { name: "К содержимому" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("link", { name: "Плагины" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("link", { name: "Обзор" })[0]).not.toHaveAttribute("aria-current");
  });

  it("рендерит слоты app.details и app.overlays", () => {
    renderShell();

    expect(screen.getByTestId("details-slot")).toBeInTheDocument();
    expect(screen.getByText("Детали теста")).toBeInTheDocument();
    expect(screen.getByTestId("overlays-slot")).toBeInTheDocument();
    expect(screen.getByTestId("test-ui-overlay")).toBeInTheDocument();
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
