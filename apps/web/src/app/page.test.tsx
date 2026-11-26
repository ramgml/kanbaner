import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiRegistryProvider } from "../ui/provider";
import HomePage from "./page";

describe("HomePage", () => {
  it("показывает обзор shell-а и доступные разделы", () => {
    render(
      <UiRegistryProvider>
        <HomePage />
      </UiRegistryProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Обзор" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Плагины/ })).toHaveAttribute("href", "/plugins");
    expect(screen.getByRole("link", { name: /Настройки/ })).toHaveAttribute("href", "/settings");
    expect(screen.getByText("Локально")).toBeInTheDocument();
    expect(screen.getByText(/Пока нет активных UI-вкладов/)).toBeInTheDocument();
  });
});
