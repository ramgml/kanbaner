import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText, legacyCopyText } from "./clipboard.ts";

interface ClipboardMock {
  readonly writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
}

function installClipboard(
  writeText: (text: string) => Promise<void> = () => Promise.resolve(),
): ClipboardMock {
  const mock: ClipboardMock = { writeText: vi.fn(writeText) };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: mock,
  });
  return mock;
}

function removeClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
}

function installExecCommand(command: (name: string) => boolean): ReturnType<typeof vi.fn> {
  const mock = vi.fn(command);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: mock,
  });
  return mock;
}

function removeExecCommand(): void {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  removeClipboard();
  removeExecCommand();
  vi.useRealTimers();
});

describe("copyText", () => {
  it("копирует точный текст через Clipboard API без legacy fallback", async () => {
    const clipboard = installClipboard();
    const execCommand = installExecCommand(() => true);
    const text = "const a = 1;\n  строка & <tag>";

    await expect(copyText(text)).resolves.toBe(true);

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith(text);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("использует legacy execCommand, когда Clipboard API отсутствует", async () => {
    removeClipboard();
    let copied: string | null = null;
    const execCommand = installExecCommand(() => {
      const textarea = document.querySelector("textarea");
      copied = textarea?.value ?? null;
      return true;
    });

    await expect(copyText("exact\ncode")).resolves.toBe(true);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copied).toBe("exact\ncode");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("использует legacy fallback при отказе Clipboard API и сохраняет exact text", async () => {
    const clipboard = installClipboard(() => Promise.reject(new Error("denied")));
    let copied: string | null = null;
    installExecCommand(() => {
      copied = document.querySelector("textarea")?.value ?? null;
      return true;
    });

    await expect(copyText("точный текст")).resolves.toBe(true);

    expect(clipboard.writeText).toHaveBeenCalledWith("точный текст");
    expect(copied).toBe("точный текст");
  });

  it("возвращает false при false от execCommand, throw и пустом тексте без unhandled rejection", async () => {
    removeClipboard();
    installExecCommand(() => false);
    await expect(copyText("code")).resolves.toBe(false);

    installExecCommand(() => {
      throw new Error("copy failed");
    });
    await expect(copyText("code")).resolves.toBe(false);

    installExecCommand(() => {
      throw "string failure";
    });
    await expect(copyText("code")).resolves.toBe(false);

    const clipboard = installClipboard();
    const execCommand = installExecCommand(() => true);
    await expect(copyText("")).resolves.toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("не копирует пустую строку и не трогает DOM", async () => {
    removeClipboard();
    const execCommand = installExecCommand(() => true);

    await expect(copyText("")).resolves.toBe(false);
    expect(legacyCopyText("")).toBe(false);

    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("восстанавливает activeElement и Selection ranges, удаляя textarea в finally", async () => {
    document.body.innerHTML = '<textarea id="composer"></textarea><p id="paragraph">Текст</p>';
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    const paragraph = document.querySelector<HTMLElement>("#paragraph");
    if (composer === null || paragraph === null) throw new Error("fixtures are missing");

    composer.value = "черновик";
    composer.focus();
    composer.setSelectionRange(2, 5, "forward");
    expect(document.activeElement).toBe(composer);

    installExecCommand(() => true);

    await expect(copyText("stored")).resolves.toBe(true);

    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(2);
    expect(composer.selectionEnd).toBe(5);
    expect(composer.selectionDirection).toBe("forward");
    expect(document.querySelector("textarea:not(#composer)")).toBeNull();
  });

  it("восстанавливает document Selection после legacy копирования", async () => {
    document.body.innerHTML = '<p id="paragraph">Выделенный текст</p>';
    const paragraph = document.querySelector<HTMLElement>("#paragraph");
    if (paragraph === null) throw new Error("fixture is missing");
    const textNode = paragraph.firstChild;
    if (textNode === null) throw new Error("text is missing");

    const selection = document.getSelection();
    if (selection === null) throw new Error("selection is missing");
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 8);
    selection.removeAllRanges();
    selection.addRange(range);

    installExecCommand(() => true);
    await expect(copyText("stored")).resolves.toBe(true);

    const restored = document.getSelection();
    expect(restored?.rangeCount).toBe(1);
    expect(restored?.getRangeAt(0).startOffset).toBe(2);
    expect(restored?.getRangeAt(0).endOffset).toBe(8);
    expect(restored?.toString()).toBe("деленн");
  });

  it("очищает временную textarea даже при throw внутри execCommand", async () => {
    installExecCommand(() => {
      expect(document.querySelector("textarea")).not.toBeNull();
      throw new Error("boom");
    });

    await expect(copyText("code")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("legacyCopyText возвращает false без execCommand", () => {
    removeExecCommand();
    expect(legacyCopyText("code")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
