import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiRegistryProvider } from "../../ui/provider";
import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("даёт вход в обзор с корневого маршрута и сохраняет plugin manager", () => {
    render(
      <UiRegistryProvider>
        <SettingsPage />
      </UiRegistryProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Настройки" })).toBeInTheDocument();
    expect(screen.getByText("Оформление")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Размер шрифта" })).toHaveValue("100");
    expect(screen.getByRole("link", { name: "Открыть обзор" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Открыть plugin manager" })).toHaveAttribute(
      "href",
      "/settings/plugins",
    );
  });
});
