import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./app-shell";
import { UiSlot } from "./ui-slot";
import type { UiComponent } from "../../ui/registry";
import { createUiContributionRegistry } from "../../ui/registry";
import { registerUiPlugin } from "../../ui/plugin-api";
import { UiRegistryProvider } from "../../ui/provider";

const navigation = vi.hoisted(() => ({
  pathname: "/view/notes",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));

const openTask: UiComponent = ({ openResource }) => (
  <button
    type="button"
    onClick={() => {
      openResource?.("kanbaner.tasks:task:task-1");
    }}
  >
    Открыть задачу
  </button>
);

const openUnknown: UiComponent = ({ openResource }) => (
  <button
    type="button"
    onClick={() => {
      openResource?.("kanbaner.unknown:task:missing");
    }}
  >
    Открыть неизвестный ресурс
  </button>
);

const nestedParent: UiComponent = ({ renderSlot }) => (
  <div>
    {renderSlot?.("example.child.slot", {
      resourceRef: "kanbaner.tasks:task:task-1",
    })}
  </div>
);

const nestedChild: UiComponent = ({ context }) => (
  <p data-testid="nested-slot-content">{String(context?.resourceRef ?? "")}</p>
);

const contextReader: UiComponent = ({ context }) => (
  <p data-testid="slot-context">{String(context?.resourceRef ?? "none")}</p>
);

function registerPlugins(registry: ReturnType<typeof createUiContributionRegistry>): void {
  registerUiPlugin(registry, {
    id: "example.resource-ui",
    contributions: [
      {
        metadata: {
          id: "example.resource-ui.opener.task",
          slot: "app.main",
          kind: "resource-opener",
          priority: 90,
          title: "Открыть задачу",
          route: "/view/notes",
          resourcePluginId: "kanbaner.tasks",
          resourceType: "task",
        },
        render: () => null,
      },
      {
        metadata: {
          id: "example.resource-ui.open-task",
          slot: "app.main",
          kind: "panel",
          priority: 80,
          title: "Открыть задачу",
        },
        render: openTask,
      },
      {
        metadata: {
          id: "example.resource-ui.open-unknown",
          slot: "app.main",
          kind: "panel",
          priority: 70,
          title: "Неизвестный ресурс",
        },
        render: openUnknown,
      },
      {
        metadata: {
          id: "example.resource-ui.nested-parent",
          slot: "app.main",
          kind: "panel",
          priority: 60,
          title: "Родительский слот",
        },
        render: nestedParent,
      },
    ],
  });

  registerUiPlugin(registry, {
    id: "example.child",
    contributions: [
      {
        metadata: {
          id: "example.child.panel",
          slot: "example.child.slot",
          kind: "panel",
          priority: 10,
          title: "Дочерний вклад",
        },
        render: nestedChild,
      },
    ],
  });
}

beforeEach(() => {
  navigation.push.mockClear();
  navigation.replace.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ResourceRef и вложенные слоты в shell", () => {
  it("открывает ресурс маршрутом вклада и router-aware навигацией", () => {
    const registry = createUiContributionRegistry();

    registerPlugins(registry);

    render(
      <UiRegistryProvider registry={registry}>
        <AppShell>
          <UiSlot slot="app.main" />
        </AppShell>
      </UiRegistryProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Открыть задачу" }));

    expect(navigation.push).toHaveBeenCalledWith(
      "/view/notes?resource=kanbaner.tasks%3Atask%3Atask-1",
      { scroll: false },
    );
  });

  it("показывает notice вместо падения при неизвестном ресурсе", () => {
    const registry = createUiContributionRegistry();

    registerPlugins(registry);

    render(
      <UiRegistryProvider registry={registry}>
        <AppShell>
          <UiSlot slot="app.main" />
        </AppShell>
      </UiRegistryProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Открыть неизвестный ресурс" }));

    expect(screen.getByTestId("resource-open-notice")).toHaveTextContent(
      "Для этого ресурса нет доступного способа открытия",
    );
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
  });

  it("передаёт вложенному вкладу сериализуемый контекст слота", () => {
    const registry = createUiContributionRegistry();

    registerPlugins(registry);

    render(
      <UiRegistryProvider registry={registry}>
        <AppShell>
          <UiSlot slot="app.main" />
        </AppShell>
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("nested-slot-content")).toHaveTextContent(
      "kanbaner.tasks:task:task-1",
    );
  });
});

describe("контекст вложенного слота", () => {
  it("передаёт JSON-контекст каждому вкладу своего слота", () => {
    const registry = createUiContributionRegistry();

    registerUiPlugin(registry, {
      id: "example.context",
      contributions: [
        {
          metadata: {
            id: "example.context.panel",
            slot: "example.context.slot",
            kind: "panel",
            priority: 10,
            title: "Контекст",
          },
          render: contextReader,
        },
      ],
    });

    render(
      <UiRegistryProvider registry={registry}>
        <UiSlot
          slot="example.context.slot"
          context={{ resourceRef: "kanbaner.tasks:task:task-1" }}
        />
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("slot-context")).toHaveTextContent("kanbaner.tasks:task:task-1");
  });

  it("не передаёт контекст вкладам другого слота", () => {
    const registry = createUiContributionRegistry();

    registerUiPlugin(registry, {
      id: "example.context",
      contributions: [
        {
          metadata: {
            id: "example.context.without",
            slot: "example.other.slot",
            kind: "panel",
            priority: 10,
            title: "Без контекста",
          },
          render: contextReader,
        },
      ],
    });

    render(
      <UiRegistryProvider registry={registry}>
        <UiSlot
          slot="example.context.slot"
          context={{ resourceRef: "kanbaner.tasks:task:task-1" }}
        />
        <UiSlot slot="example.other.slot" />
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("slot-context")).toHaveTextContent("none");
  });

  it("передаёт вложенному слоту контекст, переданный родителем", () => {
    const registry = createUiContributionRegistry();

    registerUiPlugin(registry, {
      id: "example.parent",
      contributions: [
        {
          metadata: {
            id: "example.parent.panel",
            slot: "example.parent.slot",
            kind: "panel",
            priority: 10,
            title: "Родитель",
          },
          render: ({ renderSlot }) => (
            <div>
              {renderSlot?.("example.child.slot", {
                resourceRef: "kanbaner.tasks:task:child-task",
              })}
            </div>
          ),
        },
      ],
    });

    registerUiPlugin(registry, {
      id: "example.child",
      contributions: [
        {
          metadata: {
            id: "example.child.panel",
            slot: "example.child.slot",
            kind: "panel",
            priority: 10,
            title: "Дочерний вклад",
          },
          render: contextReader,
        },
      ],
    });

    render(
      <UiRegistryProvider registry={registry}>
        <UiSlot
          slot="example.parent.slot"
          context={{ resourceRef: "kanbaner.tasks:task:parent-task" }}
        />
      </UiRegistryProvider>,
    );

    expect(screen.getByTestId("slot-context")).toHaveTextContent("kanbaner.tasks:task:child-task");
  });
});
