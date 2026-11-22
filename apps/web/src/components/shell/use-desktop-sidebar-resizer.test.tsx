import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_SIDEBAR_DEFAULT_WIDTH,
  APP_SIDEBAR_MAX_WIDTH,
  APP_SIDEBAR_MIN_WIDTH,
  APP_SIDEBAR_STORAGE_KEY,
  clampSidebarWidth,
  readStoredSidebarWidth,
  sidebarMaxWidthFor,
  useDesktopSidebarResizer,
} from "./use-desktop-sidebar-resizer.ts";

function Harness() {
  const resizer = useDesktopSidebarResizer();

  return (
    <>
      <div data-testid="sidebar" style={resizer.asideStyle} />
      <div {...resizer.separatorProps} />
    </>
  );
}

function sidebarWidth(): number {
  return Number.parseInt(screen.getByTestId("sidebar").style.width, 10);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("useDesktopSidebarResizer", () => {
  it("изменяет ширину pointer drag, сохраняет её и восстанавливает после remount", async () => {
    const first = render(<Harness />);
    const handle = screen.getByRole("separator");

    expect(sidebarWidth()).toBe(APP_SIDEBAR_DEFAULT_WIDTH);
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerType: "mouse",
      pointerId: 7,
      clientX: 100,
    });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 220 });
    expect(sidebarWidth()).toBe(APP_SIDEBAR_DEFAULT_WIDTH + 120);
    expect(handle).toHaveAttribute("data-resizing", "true");
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 220 });

    expect(handle).not.toHaveAttribute("data-resizing");
    expect(window.localStorage.getItem(APP_SIDEBAR_STORAGE_KEY)).toBe("408");
    first.unmount();

    render(<Harness />);
    await waitFor(() => expect(sidebarWidth()).toBe(408));
  });

  it("при недоступном Pointer Capture завершает drag на window без зависания", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    const setPointerCapture = vi.fn(() => {
      throw new Error("Pointer Capture unavailable");
    });
    Object.assign(handle, { setPointerCapture });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerType: "mouse",
      pointerId: 7,
      clientX: 100,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(handle).toHaveAttribute("data-resizing", "true");

    fireEvent.pointerMove(document.body, { pointerId: 7, clientX: 220 });
    expect(sidebarWidth()).toBe(APP_SIDEBAR_DEFAULT_WIDTH + 120);
    fireEvent.pointerUp(document.body, { pointerId: 7, clientX: 220 });

    expect(handle).not.toHaveAttribute("data-resizing");
    expect(window.localStorage.getItem(APP_SIDEBAR_STORAGE_KEY)).toBe("408");

    // Listeners удалены: повторный move вне handle не меняет ширину.
    fireEvent.pointerMove(document.body, { pointerId: 7, clientX: 400 });
    expect(sidebarWidth()).toBe(APP_SIDEBAR_DEFAULT_WIDTH + 120);
  });

  it("поддерживает клавиатуру, пределы и double-click reset", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "304");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "352");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", String(APP_SIDEBAR_MIN_WIDTH));
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", String(APP_SIDEBAR_MAX_WIDTH));
    expect(window.localStorage.getItem(APP_SIDEBAR_STORAGE_KEY)).toBe("560");
    fireEvent.doubleClick(handle);

    expect(handle).toHaveAttribute("aria-valuenow", String(APP_SIDEBAR_DEFAULT_WIDTH));
    expect(window.localStorage.getItem(APP_SIDEBAR_STORAGE_KEY)).toBe("288");
  });

  it("ужимает максимум по viewport и отбрасывает повреждённое хранилище", async () => {
    window.localStorage.setItem(APP_SIDEBAR_STORAGE_KEY, "560");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    render(<Harness />);
    const handle = screen.getByRole("separator");

    await waitFor(() => expect(handle).toHaveAttribute("aria-valuemax", "384"));
    expect(handle).toHaveAttribute("aria-valuenow", "384");
    expect(window.localStorage.getItem(APP_SIDEBAR_STORAGE_KEY)).toBe("560");

    for (const broken of ["408junk", "100.5", "-1", "NaN", ""]) {
      window.localStorage.setItem(APP_SIDEBAR_STORAGE_KEY, broken);
      expect(readStoredSidebarWidth()).toBe(APP_SIDEBAR_DEFAULT_WIDTH);
    }

    expect(clampSidebarWidth(100)).toBe(APP_SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(APP_SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(APP_SIDEBAR_DEFAULT_WIDTH);
    expect(sidebarMaxWidthFor(1440)).toBe(APP_SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidthFor(800)).toBe(384);
    expect(sidebarMaxWidthFor(400)).toBe(APP_SIDEBAR_MIN_WIDTH);
  });
});
