import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_ASSISTANT_DEFAULT_WIDTH,
  APP_ASSISTANT_MAX_WIDTH,
  APP_ASSISTANT_MIN_WIDTH,
  APP_ASSISTANT_STORAGE_KEY,
  assistantMaxWidthFor,
  clampAssistantPanelWidth,
  readStoredAssistantPanelWidth,
  useDesktopAssistantResizer,
} from "./use-desktop-assistant-resizer.ts";

function Harness() {
  const resizer = useDesktopAssistantResizer();

  return (
    <>
      <div data-testid="panel" style={resizer.asideStyle} />
      <div {...resizer.separatorProps} />
    </>
  );
}

function panelWidth(): number {
  return Number.parseInt(screen.getByTestId("panel").style.width, 10);
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.localStorage.clear();
  // Достаточно широкий viewport, чтобы максимум не упирался в clamp.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("useDesktopAssistantResizer", () => {
  it("изменяет ширину pointer drag левой границы, сохраняет и восстанавливает её", async () => {
    const first = render(<Harness />);
    const handle = screen.getByRole("separator");

    expect(panelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH);
    expect(handle).toHaveAttribute("aria-valuenow", String(APP_ASSISTANT_DEFAULT_WIDTH));
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerType: "mouse",
      pointerId: 7,
      clientX: 500,
    });
    // Движение влево расширяет прижатую к правому краю панель.
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 380 });
    expect(panelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH + 120);
    expect(handle).toHaveAttribute("data-resizing", "true");
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 380 });

    expect(handle).not.toHaveAttribute("data-resizing");
    expect(window.localStorage.getItem(APP_ASSISTANT_STORAGE_KEY)).toBe("504");
    first.unmount();

    render(<Harness />);
    await waitFor(() => expect(panelWidth()).toBe(504));
  });

  it("не выходит за min/max и не перехватывает события после drag", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerType: "mouse",
      pointerId: 3,
      clientX: 500,
    });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 900 });
    expect(panelWidth()).toBe(APP_ASSISTANT_MIN_WIDTH);
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: -500 });
    expect(panelWidth()).toBe(APP_ASSISTANT_MAX_WIDTH);
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: -500 });

    expect(window.localStorage.getItem(APP_ASSISTANT_STORAGE_KEY)).toBe("640");
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 500 });
    expect(panelWidth()).toBe(APP_ASSISTANT_MAX_WIDTH);

    // Второй pointer во время drag игнорируется.
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerType: "mouse",
      pointerId: 4,
      clientX: 500,
    });
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerType: "mouse",
      pointerId: 5,
      clientX: 500,
    });
    fireEvent.pointerUp(handle, { pointerId: 5 });
    expect(handle).toHaveAttribute("data-resizing", "true");
    fireEvent.pointerUp(handle, { pointerId: 4 });
    expect(handle).not.toHaveAttribute("data-resizing");
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
      clientX: 500,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(handle).toHaveAttribute("data-resizing", "true");

    fireEvent.pointerMove(document.body, { pointerId: 7, clientX: 380 });
    expect(panelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH + 120);
    fireEvent.pointerUp(document.body, { pointerId: 7, clientX: 380 });

    expect(handle).not.toHaveAttribute("data-resizing");
    expect(window.localStorage.getItem(APP_ASSISTANT_STORAGE_KEY)).toBe("504");

    // Listeners удалены: повторный move вне handle не меняет ширину.
    fireEvent.pointerMove(document.body, { pointerId: 7, clientX: 100 });
    expect(panelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH + 120);
  });

  it("поддерживает клавиатуру, пределы и double-click reset", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "400");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "448");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "432");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", String(APP_ASSISTANT_MIN_WIDTH));
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", String(APP_ASSISTANT_MAX_WIDTH));
    expect(window.localStorage.getItem(APP_ASSISTANT_STORAGE_KEY)).toBe("640");
    fireEvent.doubleClick(handle);

    expect(handle).toHaveAttribute("aria-valuenow", String(APP_ASSISTANT_DEFAULT_WIDTH));
    expect(window.localStorage.getItem(APP_ASSISTANT_STORAGE_KEY)).toBe("384");
  });

  it("ужимает максимум по viewport и отбрасывает повреждённое хранилище", async () => {
    window.localStorage.setItem(APP_ASSISTANT_STORAGE_KEY, "640");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    render(<Harness />);
    const handle = screen.getByRole("separator");

    await waitFor(() => expect(handle).toHaveAttribute("aria-valuemax", "384"));
    expect(handle).toHaveAttribute("aria-valuenow", "384");
    // Сохранённое желаемое значение не перезаписывается clamp-ом.
    expect(window.localStorage.getItem(APP_ASSISTANT_STORAGE_KEY)).toBe("640");

    for (const broken of ["408junk", "100.5", "-1", "NaN", ""]) {
      window.localStorage.setItem(APP_ASSISTANT_STORAGE_KEY, broken);
      expect(readStoredAssistantPanelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH);
    }

    expect(clampAssistantPanelWidth(100)).toBe(APP_ASSISTANT_MIN_WIDTH);
    expect(clampAssistantPanelWidth(9999)).toBe(APP_ASSISTANT_MAX_WIDTH);
    expect(clampAssistantPanelWidth(Number.NaN)).toBe(APP_ASSISTANT_DEFAULT_WIDTH);
    expect(assistantMaxWidthFor(1440)).toBe(APP_ASSISTANT_MAX_WIDTH);
    expect(assistantMaxWidthFor(1024)).toBe(384);
    expect(assistantMaxWidthFor(800)).toBe(APP_ASSISTANT_MIN_WIDTH);
  });

  it("работает при недоступном localStorage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    render(<Harness />);
    const handle = screen.getByRole("separator");

    expect(panelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH);
    expect(() => fireEvent.keyDown(handle, { key: "ArrowLeft" })).not.toThrow();
    expect(panelWidth()).toBe(APP_ASSISTANT_DEFAULT_WIDTH + 16);
  });

  it("не задаёт inline width вне desktop", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(
        () =>
          ({
            matches: false,
            media: "(min-width: 768px)",
            addEventListener,
            removeEventListener,
          }) as unknown as MediaQueryList,
      ),
    });

    render(<Harness />);

    expect(screen.getByTestId("panel").style.width).toBe("");
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
