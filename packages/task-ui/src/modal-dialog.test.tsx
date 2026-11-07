import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ModalDialog } from "./components/modal-dialog.tsx";

afterEach(() => {
  cleanup();
});

function Harness({
  initiallyOpen = false,
  restoreFocusSelector,
}: {
  readonly initiallyOpen?: boolean;
  readonly restoreFocusSelector?: string;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Открыть
      </button>
      <button type="button" data-testid="fallback">
        Запасной
      </button>
      <ModalDialog
        open={open}
        label="Детали задачи"
        testId="dialog"
        onClose={() => setOpen(false)}
        {...(restoreFocusSelector === undefined ? {} : { restoreFocusSelector })}
      >
        <button type="button" data-testid="first">
          Первая
        </button>
        <button type="button" data-testid="last">
          Последняя
        </button>
      </ModalDialog>
    </div>
  );
}

describe("ModalDialog", () => {
  it("открывается нативным dialog, удерживает фокус и закрывается Escape", async () => {
    render(<Harness />);

    screen.getByTestId("opener").focus();
    fireEvent.click(screen.getByTestId("opener"));

    const dialog = screen.getByTestId("dialog");

    expect(dialog).toBeInTheDocument();
    expect(dialog.tagName).toBe("DIALOG");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("first"));
    });

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("last"));

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("first"));

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByTestId("dialog")).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("opener"));
    });
  });

  it("фокусирует первую кнопку, когда детали появились после загрузки", async () => {
    const view = render(
      <ModalDialog open label="Детали задачи" testId="dialog" onClose={() => undefined}>
        <div data-testid="loading">Загрузка деталей…</div>
      </ModalDialog>,
    );

    expect(screen.getByTestId("dialog")).toBeInTheDocument();

    view.rerender(
      <ModalDialog open label="Детали задачи" testId="dialog" onClose={() => undefined}>
        <button type="button" data-testid="close">
          Закрыть
        </button>
        <button type="button" data-testid="last">
          Последняя
        </button>
      </ModalDialog>,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("close"));
    });
  });

  it("не перехватывает фокус после реального действия пользователя", async () => {
    const view = render(
      <ModalDialog open label="Детали задачи" testId="dialog" onClose={() => undefined}>
        <button type="button" data-testid="first">
          Первая
        </button>
        <button type="button" data-testid="last">
          Последняя
        </button>
      </ModalDialog>,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("first"));
    });

    const last = screen.getByTestId("last");

    last.focus();
    fireEvent.click(last);

    view.rerender(
      <ModalDialog open label="Детали задачи" testId="dialog" onClose={() => undefined}>
        <button type="button" data-testid="first">
          Первая
        </button>
        <button type="button" data-testid="last">
          Последняя
        </button>
        <button type="button" data-testid="extra">
          Ещё
        </button>
      </ModalDialog>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("extra")).toBeInTheDocument();
    });
    expect(document.activeElement).toBe(last);
  });

  it("возвращает фокус на запасной элемент, если исходный недоступен", async () => {
    render(<Harness initiallyOpen restoreFocusSelector='[data-testid="fallback"]' />);

    expect(screen.getByTestId("dialog")).toBeInTheDocument();

    // Исходный активный элемент (body) не отмечен как видимый кандидат,
    // поэтому cleanup выбирает fallback по селектору.
    fireEvent.keyDown(screen.getByTestId("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("fallback"));
    });
  });
});
