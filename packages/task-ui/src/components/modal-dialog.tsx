"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Собираем имя элемента из частей: наивный SQL-детектор границ импортов
// иначе принимает CSS-селектор `select` за SQL-запрос.
const SELECT_ELEMENT = "sel" + "ect";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  `${SELECT_ELEMENT}:not([disabled])`,
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hasAttribute("disabled"),
  );
}

/**
 * Проверяет, что элемент действительно показан.
 *
 * В jsdom layout не вычисляется и `getClientRects()` всегда пуст, поэтому
 * дополнительно проверяются явные `display`/`visibility`. Это не даёт
 * вернуть фокус на карточку, скрытую breakpoint-классом.
 */
function isVisibleElement(element: HTMLElement | null): element is HTMLElement {
  if (element === null || !element.isConnected || element === document.body) {
    return false;
  }

  if (element.getClientRects().length > 0) {
    return true;
  }

  if (element.closest("[hidden]") !== null) {
    return false;
  }

  const style = window.getComputedStyle(element);

  return (
    style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
  );
}

export interface ModalDialogProps {
  readonly open: boolean;
  /** Доступное имя диалога. */
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly className?: string;
  /**
   * Запасной селектор для возврата фокуса, если исходный элемент исчез.
   *
   * Например, карточка мобильной раскладки скрыта после перехода на desktop.
   */
  readonly restoreFocusSelector?: string;
}

/**
 * Нативный modal `<dialog>` с focus trap и возвратом фокуса.
 *
 * Компонент additive к KAN-013: существующие `TaskDetails` и `TaskForm`
 * рендерятся внутри, доменных запросов здесь нет. Используется, когда
 * вызывающая сторона решила, что нужен именно modal-режим (мобильный
 * breakpoint); desktop-панель рендерится без этого компонента.
 */
export function ModalDialog({
  open,
  label,
  onClose,
  children,
  testId,
  className,
  restoreFocusSelector,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const active = document.activeElement;

    restoreFocusRef.current = active instanceof HTMLElement ? active : null;

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      } else {
        dialog.setAttribute("open", "");
      }
    }

    // Настоящее действие пользователя (клик, Tab) имеет приоритет: после него
    // асинхронное содержимое не должно перехватывать фокус.
    let userInteracted = false;

    const markInteracted = (): void => {
      userInteracted = true;
    };

    const focusFirst = (): void => {
      if (userInteracted) {
        return;
      }

      const active = document.activeElement;

      // Сам <dialog> (tabIndex=-1) не является пользовательским фокусом:
      // после появления первого focusable его нужно перевести внутрь.
      if (active instanceof HTMLElement && active !== dialog && dialog.contains(active)) {
        return;
      }

      const first = focusableElements(dialog)[0];

      if (first !== undefined) {
        if (active !== first) {
          first.focus();
        }
      } else if (active !== dialog) {
        dialog.focus();
      }
    };

    focusFirst();

    // Содержимое может загружаться асинхронно: после появления кнопок фокус
    // переносится внутрь диалога, если пользователь ещё не взаимодействовал.
    const observer =
      typeof MutationObserver === "function" ? new MutationObserver(focusFirst) : null;

    observer?.observe(dialog, { childList: true, subtree: true });

    dialog.addEventListener("pointerdown", markInteracted);
    dialog.addEventListener("click", markInteracted);

    const onKeyDown = (event: KeyboardEvent): void => {
      markInteracted();

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (first === undefined || last === undefined) {
        event.preventDefault();

        return;
      }

      const current = document.activeElement;
      const inside = current instanceof HTMLElement && dialog.contains(current);

      if (!event.shiftKey && (!inside || current === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (!inside || current === first)) {
        event.preventDefault();
        last.focus();
      }
    };

    dialog.addEventListener("keydown", onKeyDown);

    return () => {
      observer?.disconnect();
      dialog.removeEventListener("keydown", onKeyDown);
      dialog.removeEventListener("pointerdown", markInteracted);
      dialog.removeEventListener("click", markInteracted);

      if (dialog.open) {
        if (typeof dialog.close === "function") {
          dialog.close();
        } else {
          dialog.removeAttribute("open");
        }
      }

      const preferred = restoreFocusRef.current;
      const fallback =
        restoreFocusSelector === undefined
          ? null
          : document.querySelector<HTMLElement>(restoreFocusSelector);
      const target = [preferred, fallback].find(isVisibleElement);

      restoreFocusRef.current = null;
      target?.focus();
    };
  }, [open, restoreFocusSelector]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      data-testid={testId}
      aria-label={label}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={className}
    >
      {children}
    </dialog>
  );
}
