import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("открывает страницу-заглушку каркаса", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", { level: 1, name: "Kanbaner" })).toBeInTheDocument();
    expect(screen.getByText("Приложение запущено")).toBeVisible();
  });
});
