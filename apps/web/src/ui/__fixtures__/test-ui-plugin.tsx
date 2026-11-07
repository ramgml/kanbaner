import type { ReactNode } from "react";

import { defineUiPlugin, type UiPluginDefinition } from "../plugin-api";

function Section({ children }: { readonly children: ReactNode }) {
  return (
    <section data-testid="test-ui-view" className="rounded-lg border p-4">
      {children}
    </section>
  );
}

/**
 * Тестовый UI-плагин.
 *
 * Регистрируется только через публичный `defineUiPlugin` и не импортирует
 * внутренности shell, ядра или чужие DOM-узлы.
 */
export const testUiPlugin: UiPluginDefinition = defineUiPlugin({
  id: "example.test-ui",
  contributions: [
    {
      metadata: {
        id: "example.test-ui.view",
        slot: "app.main",
        kind: "view",
        priority: 50,
        title: "Тестовое представление",
        description: "Проверка маршрутизации UI-вкладов",
        route: "/view/test-ui",
      },
      render: () => (
        <Section>
          <h1 className="text-xl font-semibold">Тестовое представление</h1>
          <p className="text-sm text-muted-foreground">
            Вклад зарегистрирован через публичный API UI-плагина.
          </p>
        </Section>
      ),
    },
    {
      metadata: {
        id: "example.test-ui.navigation",
        slot: "app.sidebar",
        kind: "navigation",
        priority: 20,
        title: "Тест UI",
        route: "/view/test-ui",
      },
      render: () => null,
    },
    {
      metadata: {
        id: "example.test-ui.main-panel",
        slot: "app.main",
        kind: "panel",
        priority: 5,
        title: "Панель обзора",
      },
      render: () => (
        <Section>
          <h2 className="font-medium">Панель обзора</h2>
        </Section>
      ),
    },
    {
      metadata: {
        id: "example.test-ui.settings",
        slot: "app.settings",
        kind: "settings",
        priority: 10,
        title: "Настройки тестового плагина",
      },
      render: () => (
        <Section>
          <h2 className="font-medium">Настройки тестового плагина</h2>
        </Section>
      ),
    },
    {
      metadata: {
        id: "example.test-ui.details",
        slot: "app.details",
        kind: "panel",
        priority: 10,
        title: "Детали теста",
      },
      render: () => (
        <Section>
          <h2 className="font-medium">Детали теста</h2>
        </Section>
      ),
    },
    {
      metadata: {
        id: "example.test-ui.overlay",
        slot: "app.overlays",
        kind: "notification",
        priority: 10,
        title: "Уведомление теста",
      },
      render: () => (
        <div data-testid="test-ui-overlay" className="rounded-md border bg-background p-3 shadow">
          Уведомление тестового плагина
        </div>
      ),
    },
  ],
});

/** Вклад, который падает при рендере; нужен только тестам границ ошибок. */
export const brokenUiPlugin: UiPluginDefinition = defineUiPlugin({
  id: "example.broken-ui",
  contributions: [
    {
      metadata: {
        id: "example.broken-ui.view",
        slot: "app.main",
        kind: "view",
        priority: 1,
        title: "Сломанный вклад",
      },
      render: () => {
        throw new Error("/secret/path: тестовое падение");
      },
    },
  ],
});
