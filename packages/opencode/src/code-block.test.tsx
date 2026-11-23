import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CODE_COPY_RESET_MS, CodeBlockCopyAction } from "./code-block.tsx";

const { copyTextMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock("./clipboard.ts", () => ({
  copyText: copyTextMock,
}));

beforeEach(() => {
  copyTextMock.mockReset();
  copyTextMock.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function action(): HTMLElement {
  return screen.getByTestId("opencode-copy-code");
}

describe("CodeBlockCopyAction", () => {
  it("копирует exact code и показывает Copy → Check → сброс через 2s", async () => {
    vi.useFakeTimers();
    render(<CodeBlockCopyAction code={"const a = 1;\n  return a;"} />);

    expect(action()).toHaveAttribute("aria-label", "Копировать код");
    expect(action()).toHaveAttribute("title", "Копировать код");
    expect(action()).toHaveAttribute("type", "button");

    await act(async () => {
      fireEvent.click(action());
      await Promise.resolve();
    });

    expect(copyTextMock).toHaveBeenCalledWith("const a = 1;\n  return a;");
    expect(action()).toHaveAttribute("aria-label", "Код скопирован");
    expect(action()).toHaveAttribute("title", "Код скопирован");

    await act(async () => {
      vi.advanceTimersByTime(CODE_COPY_RESET_MS - 1);
    });
    expect(action()).toHaveAttribute("aria-label", "Код скопирован");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(action()).toHaveAttribute("aria-label", "Копировать код");
  });

  it("показывает ошибку при отказе clipboard и не добавляет live-region", async () => {
    copyTextMock.mockResolvedValue(false);
    render(<CodeBlockCopyAction code="code" />);

    await act(async () => {
      fireEvent.click(action());
      await Promise.resolve();
    });

    expect(action()).toHaveAttribute("aria-label", "Не удалось скопировать код");
    expect(action()).toHaveAttribute("title", "Не удалось скопировать код");
    expect(action()).not.toHaveAttribute("aria-live");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("сбрасывает предыдущий таймер при повторном копировании", async () => {
    vi.useFakeTimers();
    render(<CodeBlockCopyAction code="code" />);

    await act(async () => {
      fireEvent.click(action());
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    copyTextMock.mockResolvedValue(false);
    await act(async () => {
      fireEvent.click(action());
      await Promise.resolve();
    });
    expect(action()).toHaveAttribute("aria-label", "Не удалось скопировать код");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // Первый таймер не сбросил новый статус раньше времени.
    expect(action()).toHaveAttribute("aria-label", "Не удалось скопировать код");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(action()).toHaveAttribute("aria-label", "Копировать код");
  });

  it("StrictMode: копирование и cleanup таймера не дают ошибок после unmount", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveCopy: (value: boolean) => void = () => {};
    copyTextMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const view = render(
      <StrictMode>
        <CodeBlockCopyAction code="code" />
      </StrictMode>,
    );

    fireEvent.click(action());
    view.unmount();
    await act(async () => {
      resolveCopy(true);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(CODE_COPY_RESET_MS + 1000);
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("StrictMode: успешный статус и reset работают после двойного mount", async () => {
    vi.useFakeTimers();
    render(
      <StrictMode>
        <CodeBlockCopyAction code="strict" />
      </StrictMode>,
    );

    await act(async () => {
      fireEvent.click(action());
      await Promise.resolve();
    });

    expect(action()).toHaveAttribute("aria-label", "Код скопирован");
    await act(async () => {
      vi.advanceTimersByTime(CODE_COPY_RESET_MS);
    });
    expect(action()).toHaveAttribute("aria-label", "Копировать код");
  });
});
