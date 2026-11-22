import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OPENCODE_CATALOG_TOOLS } from "./tool-metadata.ts";
import type { OpenCodeCatalog, OpenCodeSessionView, OpenCodeStreamEvent } from "./types.ts";
import { OpenCodePanel } from "./ui.tsx";

const catalog: OpenCodeCatalog = {
  providers: [
    { id: "provider-1", name: "Provider One", activation: "enabled" },
    { id: "provider-2", name: "Provider Two", activation: "enabled" },
  ],
  models: [
    {
      id: "model-1",
      providerID: "provider-1",
      name: "Model One",
      type: "chat",
      variants: ["low", "high"],
    },
    { id: "model-2", providerID: "provider-2", name: "Model Two", type: "chat", variants: ["max"] },
  ],
  agents: [{ id: "kanbaner", name: "Kanbaner", description: null }],
  tools: OPENCODE_CATALOG_TOOLS,
  defaultModel: { id: "model-1", providerID: "provider-1", variant: "high" },
};

function session(id = "ses-1"): OpenCodeSessionView {
  return {
    id,
    title: "Kanbaner chat",
    agent: "kanbaner",
    model: { id: "model-1", providerID: "provider-1", variant: "high" },
    messages: [],
  };
}

function success<T>(data: T): Response {
  return Response.json({ ok: true, data });
}

function failure(status: number, code = "DEPENDENCY_UNAVAILABLE"): Response {
  return Response.json(
    { ok: false, error: { code, message: "Временно недоступно", retryable: true } },
    { status },
  );
}

function stream(events: readonly OpenCodeStreamEvent[]): Response {
  return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function abortable(response: Response, signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    queueMicrotask(() => {
      if (!signal?.aborted) resolve(response);
    });
  });
}

class DeferredFileReader {
  static instances: DeferredFileReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;

  readAsDataURL(): void {
    DeferredFileReader.instances.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  finish(base64: string): void {
    this.result = `data:text/plain;base64,${base64}`;
    this.onload?.();
  }
}

function useDeferredFileReader(): DeferredFileReader[] {
  DeferredFileReader.instances = [];
  vi.stubGlobal("FileReader", DeferredFileReader);
  return DeferredFileReader.instances;
}

function requireReader(readers: readonly DeferredFileReader[]): DeferredFileReader {
  const reader = readers[0];
  if (reader === undefined) throw new Error("FileReader не был запущен");
  return reader;
}

function pendingFilesList(): HTMLElement | null {
  return screen.queryByRole("list", { name: "Выбранные файлы" });
}

function modelSummary(): HTMLElement {
  const summary = screen
    .getByText("Модель", { exact: true, selector: "summary span" })
    .closest("summary");
  if (summary === null) throw new Error("model summary is missing");
  return summary;
}

function modelDetails(): HTMLDetailsElement {
  const details = modelSummary().closest("details");
  if (details === null) throw new Error("model details is missing");
  return details;
}

function expandModelControls(): void {
  if (!modelDetails().open) fireEvent.click(modelSummary());
  expect(modelDetails().open).toBe(true);
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<Fetch>>;

let objectUrlSequence = 0;
const createObjectUrlMock = vi.fn<(file: Blob) => string>();
const revokeObjectUrlMock = vi.fn<(url: string) => void>();

function imageFile(name = "pixel.png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
    type: "image/png",
  });
}

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn<Fetch>();
  vi.stubGlobal("fetch", fetchMock);

  objectUrlSequence = 0;
  createObjectUrlMock.mockReset();
  revokeObjectUrlMock.mockReset();
  createObjectUrlMock.mockImplementation(() => {
    objectUrlSequence += 1;
    return `blob:mock-${objectUrlSequence}`;
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: createObjectUrlMock,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: revokeObjectUrlMock,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpenCodePanel", () => {
  it("обновляет один tool call по ID, заменяет delta финальным text и очищает attachment", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.endsWith("/prompt")) {
        return stream([
          {
            kind: "tool",
            id: "message-1:call-1",
            name: "task_update",
            status: "running",
            text: "",
          },
          { kind: "tool", id: "message-1:call-1", status: "running", text: '{"id":"task-1"}' },
          { kind: "tool", id: "message-1:call-1", status: "completed", text: "Обновлено" },
          { kind: "delta", id: "message-1:0", text: "Черновой" },
          { kind: "delta", id: "message-1:0", text: " ответ" },
          { kind: "text", id: "message-1:0", text: "Ответ целиком" },
          { kind: "done" },
        ]);
      }
      if (url === "/api/opencode/session/ses-1") return failure(503);
      throw new Error(`Unexpected fetch ${url}`);
    });
    const { rerender } = render(<OpenCodePanel search="?note=note-1" />);

    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    const attach = screen.getByRole("button", { name: "Прикрепить контекст" });
    fireEvent.click(attach);
    expect(attach).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(input, { target: { value: "Обнови задачу" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Ответ целиком")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Сообщение OpenCode" })).toBeEnabled(),
    );
    expect(screen.getAllByText("task_update")).toHaveLength(1);
    expect(screen.getByText("готово")).toBeVisible();
    expect(screen.getByText("Обновлено")).toBeVisible();
    expect(screen.queryByText("Черновой ответ")).toBeNull();

    const promptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/prompt"));
    expect(JSON.parse(String(promptCall?.[1]?.body))).toEqual({
      text: "Контекст: kanbaner.notes:note:note-1\n\nОбнови задачу",
    });
    expect(screen.queryByRole("button", { name: "Убрать контекст" })).toBeNull();

    rerender(<OpenCodePanel search="?note=note-2" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Прикрепить контекст" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });

  it("сворачивает блок модели по умолчанию и раскрывает controls нативным disclosure", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1/model") return success({ switched: true });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    expect(modelSummary()).toHaveTextContent("Не выбрана");
    await waitFor(() => expect(modelSummary()).toHaveTextContent("Model One"));
    expect(modelDetails().open).toBe(false);
    expect(within(modelSummary()).getByTitle("Model One")).toHaveTextContent("Model One");

    expandModelControls();
    expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-1");
    expect(screen.getByRole("combobox", { name: "Провайдер OpenCode" })).toHaveValue("provider-1");
    expect(screen.getByRole("combobox", { name: "Вариант модели OpenCode" })).toHaveValue("high");

    fireEvent.change(screen.getByRole("combobox", { name: "Провайдер OpenCode" }), {
      target: { value: "provider-2" },
    });
    await waitFor(() => expect(within(modelSummary()).getByTitle("Model Two")).toBeInTheDocument());
    expect(modelDetails().open).toBe(true);
  });

  it("переключает модель текущей сессии и сохраняет выбранный variant", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1/model") return success({ switched: true });
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    await waitFor(() => expect(modelSummary()).toHaveTextContent("Model One"));
    expandModelControls();

    const provider = screen.getByRole("combobox", { name: "Провайдер OpenCode" });
    await waitFor(() => expect(provider).toBeEnabled());
    fireEvent.change(provider, { target: { value: "provider-2" } });

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-2"),
    );
    expect(within(modelSummary()).getByTitle("Model Two")).toBeInTheDocument();
    const modelCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/model"));
    expect(JSON.parse(String(modelCall?.[1]?.body))).toEqual({
      model: { id: "model-2", providerID: "provider-2", variant: "max" },
    });
    expect(screen.getByRole("combobox", { name: "Вариант модели OpenCode" })).toHaveValue("max");
  });

  it("не удаляет сохранённую session ID при временном сбое восстановления", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-old");
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-old") return failure(503);
      if (url === "/api/opencode/session" && init?.method === "POST")
        return success(session("ses-new"));
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Временно недоступно");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-old");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === "/api/opencode/session" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("StrictMode не создаёт две сессии и не применяет aborted initialization", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return abortable(success(catalog), init?.signal);
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return abortable(success(session()), init?.signal);
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    render(
      <StrictMode>
        <OpenCodePanel />
      </StrictMode>,
    );

    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/opencode/session" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");
  });

  it("повреждённый NDJSON отменяет upstream и восстанавливает canonical history", async () => {
    let streamCancelled = false;
    let promptSignal: AbortSignal | null | undefined;
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{broken\n"));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return Promise.resolve(success(session()));
      }
      if (url === "/api/opencode/session/ses-1") {
        return Promise.resolve(
          success({
            ...session(),
            messages: [{ id: "assistant:canonical", role: "assistant", text: "Canonical" }],
          }),
        );
      }
      if (url.endsWith("/prompt")) {
        promptSignal = init?.signal;
        return Promise.resolve(new Response(malformed));
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    render(<OpenCodePanel />);

    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "Запрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Запрос OpenCode завершился с ошибкой",
    );
    expect(await screen.findByText("Canonical")).toBeVisible();
    await waitFor(() => expect(streamCancelled).toBe(true));
    expect(promptSignal?.aborted).toBe(true);
  });

  it("не удерживает composer на зависшем canonical refresh", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return Promise.resolve(success(session()));
      }
      if (url.endsWith("/prompt")) {
        return Promise.resolve(
          stream([{ kind: "text", id: "message-1:0", text: "Ответ" }, { kind: "done" }]),
        );
      }
      if (url === "/api/opencode/session/ses-1") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    render(<OpenCodePanel />);

    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "Запрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Ответ")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Сообщение OpenCode" })).toBeEnabled(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/opencode/session/ses-1" && init?.method === undefined,
      ),
    ).toBe(true);
  });

  it("не отправляет прежний ResourceRef при навигации до следующего animation frame", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return Promise.resolve(success(session()));
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "done" }]));
      if (url === "/api/opencode/session/ses-1") return Promise.resolve(success(session()));
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    const { rerender } = render(<OpenCodePanel search="?note=note-old" />);
    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить контекст" }));
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    rerender(<OpenCodePanel search="?note=note-new" />);
    fireEvent.change(input, { target: { value: "Без старого контекста" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const promptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/prompt"));
    expect(JSON.parse(String(promptCall?.[1]?.body))).toEqual({ text: "Без старого контекста" });
  });

  it("Stop aborts fetch, очищает optimistic stream и возвращает управление", async () => {
    let promptSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST")
        return Promise.resolve(success(session()));
      if (url === "/api/opencode/session/ses-1") return Promise.resolve(success(session()));
      if (url.endsWith("/prompt")) {
        promptSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    render(<OpenCodePanel />);

    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "Долгий запрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const stop = await screen.findByRole("button", { name: "Остановить OpenCode" });
    fireEvent.click(stop);

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Сообщение OpenCode" })).toBeEnabled(),
    );
    expect(promptSignal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Остановить OpenCode" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("показывает built-in и MCP инструменты отдельными группами с предупреждением", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const summary = await screen.findByText("Инструменты агента (25)");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Полный доступ: интернет, файлы и shell")).toBeInTheDocument();

    const builtin = screen.getByRole("list", { name: "Встроенные инструменты OpenCode" });
    expect(within(builtin).getAllByRole("listitem")).toHaveLength(11);
    for (const name of [
      "question",
      "websearch",
      "webfetch",
      "read",
      "glob",
      "grep",
      "edit",
      "shell",
      "subagent",
      "skill",
      "external_directory",
    ]) {
      expect(within(builtin).getByText(name, { selector: "code" })).toBeInTheDocument();
    }
    expect(within(builtin).queryByText("expectedVersion")).toBeNull();

    const mcp = screen.getByRole("list", { name: "Инструменты Kanbaner MCP" });
    expect(within(mcp).getAllByRole("listitem")).toHaveLength(14);
    expect(within(mcp).getByText("kanbaner_task_update", { selector: "code" })).toBeInTheDocument();
    expect(within(mcp).getAllByText("expectedVersion")).toHaveLength(5);
    expect(screen.getByText("Встроенные инструменты OpenCode (11)")).toBeInTheDocument();
    expect(screen.getByText("Инструменты Kanbaner MCP (14)")).toBeInTheDocument();

    expect(screen.queryByText(/delete|filesystem/u)).toBeNull();
    expect(screen.queryByText(/browser_|orenda_|webaccess-ai_/u)).toBeNull();
  });

  it("показывает attach-кнопку только иконкой с доступным именем и без лишнего текста", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());

    const attach = screen.getByRole("button", { name: "Прикрепить файлы" });
    expect(attach).toBeEnabled();
    expect(attach.textContent).toBe("");
    const title = attach.getAttribute("title") ?? "";
    expect(title).toContain("выбранной модели");
    expect(title).toContain("PDF");
    expect(screen.queryByText("Файл")).toBeNull();
    expect(screen.queryByText(/Файлы передаются только выбранной модели/u)).toBeNull();
  });

  it("держит полноразмерную textarea и icon-only кнопки в одной строке действий", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());

    expect(message.className).toMatch(/\bw-full\b/u);
    expect(message.style.resize).toBe("vertical");
    expect(Number.parseFloat(message.style.minHeight)).toBeGreaterThanOrEqual(96);
    expect(Number.parseFloat(message.style.maxHeight)).toBeGreaterThanOrEqual(
      Number.parseFloat(message.style.minHeight),
    );

    const form = message.closest("form");
    if (form === null) throw new Error("composer form is missing");
    const attach = screen.getByRole("button", { name: "Прикрепить файлы" });
    const send = screen.getByRole("button", { name: "Отправить" });
    expect(form).toContainElement(attach);
    expect(form).toContainElement(send);
    for (const button of [attach, send]) {
      expect(button.textContent).toBe("");
      expect(button.className).toMatch(/\bsize-9\b/u);
    }
    expect(screen.queryByText("Файл")).toBeNull();
  });

  it("рендерит assistant Markdown безопасно, а user и tool оставляет plain text", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            { id: "user:markdown", role: "user", text: "**не жирный**" },
            {
              id: "tool:markdown",
              role: "tool",
              name: "task_update",
              status: "completed",
              text: "**tool text**",
            },
            {
              id: "assistant:markdown",
              role: "assistant",
              text: [
                "## Итог",
                "",
                "**Важно**: список ниже.",
                "",
                "- Первый пункт",
                "- Второй пункт",
                "",
                "[Документация](https://example.com/docs)",
                "",
                "<script>window.__markdownXss = true</script>",
              ].join("\n"),
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    expect(await screen.findByRole("heading", { name: "Итог" })).toBeVisible();
    expect(screen.getByText("Важно")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("Первый пункт")).toHaveProperty("tagName", "LI");
    expect(screen.getByText("Второй пункт")).toHaveProperty("tagName", "LI");
    const link = screen.getByRole("link", { name: "Документация" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer nofollow");

    expect(screen.getByText("**не жирный**")).toBeVisible();
    expect(screen.getByText("**tool text**")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("window.__markdownXss");
    expect(document.body.querySelector("script")).toBeNull();
  });

  it("выбирает и удаляет файл, отправляет base64 и очищает chip после prompt", async () => {
    const promptBodies: unknown[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)));
        return stream([{ kind: "done" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    const fileInput = screen.getByLabelText("Файлы для OpenCode");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    expect(screen.getByText("5 B")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Удалить вложение notes.txt" }));
    expect(screen.queryByText("notes.txt")).toBeNull();

    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.change(message, { target: { value: "Посмотри файл" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(screen.queryByText("5 B")).toBeNull());
    expect(promptBodies).toEqual([
      {
        text: "Посмотри файл",
        files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
      },
    ]);
  });

  it("отклоняет неподдерживаемый тип и больше пяти файлов", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    const fileInput = screen.getByLabelText("Файлы для OpenCode");
    fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "malware.exe", { type: "application/x-msdownload" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Тип файла malware.exe не поддерживается",
    );
    expect(screen.queryByRole("button", { name: /Удалить вложение/u })).toBeNull();

    const many = Array.from(
      { length: 6 },
      (_value, index) => new File(["x"], `file-${index}.txt`, { type: "text/plain" }),
    );
    fireEvent.change(fileInput, { target: { files: many } });
    expect(await screen.findByRole("alert")).toHaveTextContent("не больше 5 файлов");
    expect(screen.queryByRole("button", { name: /Удалить вложение/u })).toBeNull();
  });

  it("показывает name и mime вложений из history без base64", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            {
              id: "user:history",
              role: "user",
              text: "Что на картинке?",
              attachments: [{ name: "history.png", mime: "image/png" }],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    expect(await screen.findByText("history.png")).toBeVisible();
    expect(screen.getByText("image/png")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("base64");
  });

  it("восстанавливает canonical image preview через authenticated same-origin endpoint", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const previewCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            {
              id: "user:message-0",
              role: "user",
              text: "Посмотри картинку",
              attachments: [{ name: "pixel.png", mime: "image/png" }],
            },
            { id: "assistant:message-1", role: "assistant", text: "Ответ" },
          ],
        });
      }
      const previewUrl = "/api/opencode/session/ses-1/messages/message-0/attachments/0";
      if (url === previewUrl) {
        previewCalls.push({ url, init });
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const { unmount } = render(<OpenCodePanel />);

    const image = await screen.findByRole("img", { name: "pixel.png" });
    expect(image).toHaveAttribute("src", "blob:mock-1");
    expect(image).toHaveAttribute("data-testid", "message-image-preview");
    await waitFor(() => expect(previewCalls).toHaveLength(1));
    expect(previewCalls[0]?.url).toBe(
      "/api/opencode/session/ses-1/messages/message-0/attachments/0",
    );
    expect(previewCalls[0]?.init?.headers).toEqual({ "x-kanbaner-client": "ui" });
    expect(screen.queryByText("image/png")).toBeNull();

    unmount();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-1");
  });

  it("оставляет chip, если canonical binary preview недоступен", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const preview = vi.fn(async () => failure(404, "NOT_FOUND"));
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            {
              id: "user:message-0",
              role: "user",
              text: "Посмотри картинку",
              attachments: [{ name: "pixel.png", mime: "image/png" }],
            },
          ],
        });
      }
      if (url === "/api/opencode/session/ses-1/messages/message-0/attachments/0") {
        return preview();
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("pixel.png")).toBeVisible();
    expect(screen.getByText("image/png")).toBeVisible();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });

  it("не запрашивает preview для text и PDF вложений", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            {
              id: "user:message-0",
              role: "user",
              text: "Файлы",
              attachments: [
                { name: "notes.txt", mime: "text/plain" },
                { name: "manual.pdf", mime: "application/pdf" },
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    expect(await screen.findByText("notes.txt")).toBeVisible();
    expect(screen.getByText("manual.pdf")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/attachments/"))).toBe(false);
  });

  it("отменяет canonical preview fetch при unmount и игнорирует stale response", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let previewSignal: AbortSignal | null | undefined;
    const gate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session/ses-1") {
        return Promise.resolve(
          success({
            ...session(),
            messages: [
              {
                id: "user:message-0",
                role: "user",
                text: "Посмотри картинку",
                attachments: [{ name: "pixel.png", mime: "image/png" }],
              },
            ],
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1/messages/message-0/attachments/0") {
        previewSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          gate.release = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    const { unmount } = render(<OpenCodePanel />);

    await waitFor(() => expect(previewSignal).toBeDefined());
    expect(previewSignal?.aborted).toBe(false);
    unmount();
    expect(previewSignal?.aborted).toBe(true);

    if (gate.release === null) throw new Error("preview fetch не был запущен");
    gate.release(new Response(png, { headers: { "content-type": "image/png" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });

  it("начинает prompt-операцию до чтения файла и не создаёт второй prompt", async () => {
    const promptBodies: unknown[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)));
        return stream([{ kind: "done" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const readers = useDeferredFileReader();
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Посмотри файл" } });
    const form = message.closest("form");
    if (form === null) throw new Error("composer form is missing");

    fireEvent.submit(form);
    expect(readers).toHaveLength(1);
    expect(message).toBeDisabled();
    expect(screen.getByRole("button", { name: "Остановить OpenCode" })).toBeInTheDocument();
    expect(promptBodies).toHaveLength(0);

    fireEvent.submit(form);
    expect(readers).toHaveLength(1);
    expect(promptBodies).toHaveLength(0);

    requireReader(readers).finish("aGVsbG8=");
    await waitFor(() => expect(promptBodies).toHaveLength(1));
    expect(promptBodies[0]).toEqual({
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    });
  });

  it("блокирует изменение selection во время подготовки и отправляет захваченный контекст", async () => {
    const promptBodies: unknown[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)));
        return stream([{ kind: "done" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const readers = useDeferredFileReader();
    render(<OpenCodePanel search="?note=note-1" />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить контекст" }));
    const fileInput = screen.getByLabelText("Файлы для OpenCode");
    fireEvent.change(fileInput, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Посмотри файл" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const remove = screen.getByRole("button", { name: "Удалить вложение notes.txt" });
    expect(remove).toBeDisabled();
    expect(fileInput).toBeDisabled();
    fireEvent.click(remove);
    fireEvent.change(fileInput, {
      target: { files: [new File(["bye"], "other.txt", { type: "text/plain" })] },
    });
    expect(pendingFilesList()).toHaveTextContent("notes.txt");
    expect(pendingFilesList()).not.toHaveTextContent("other.txt");

    requireReader(readers).finish("aGVsbG8=");
    await waitFor(() => expect(promptBodies).toHaveLength(1));
    expect(promptBodies[0]).toEqual({
      text: "Контекст: kanbaner.notes:note:note-1\n\nПосмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    });
    await waitFor(() => expect(pendingFilesList()).toBeNull());
    expect(screen.getByRole("button", { name: "Прикрепить контекст" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("unmount во время подготовки отменяет чтение и не отправляет prompt", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) return stream([{ kind: "done" }]);
      throw new Error(`Unexpected fetch ${url}`);
    });
    const readers = useDeferredFileReader();
    const { unmount } = render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Посмотри файл" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const reader = requireReader(readers);
    unmount();
    expect(reader.aborted).toBe(true);
    reader.finish("aGVsbG8=");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
  });

  it("Stop во время подготовки отменяет чтение и сохраняет вложение для повтора", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) return stream([{ kind: "done" }]);
      throw new Error(`Unexpected fetch ${url}`);
    });
    const readers = useDeferredFileReader();
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Посмотри файл" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const reader = requireReader(readers);
    fireEvent.click(screen.getByRole("button", { name: "Остановить OpenCode" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Остановить OpenCode" })).toBeNull(),
    );
    expect(reader.aborted).toBe(true);
    expect(pendingFilesList()).toHaveTextContent("notes.txt");
    expect(screen.queryByRole("alert")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
  });

  it("сохраняет вложения при ошибке upstream и очищает их только после done", async () => {
    const prompts: Array<() => Response> = [
      () => failure(503),
      () => stream([{ kind: "error", text: "Модель отклонила вложение" }]),
      () => stream([{ kind: "done" }]),
    ];
    let promptIndex = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) {
        const next = prompts[promptIndex];
        promptIndex += 1;
        if (next === undefined) throw new Error("Unexpected prompt");
        return next();
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel search="?note=note-1" />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить контекст" }));
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();

    fireEvent.change(message, { target: { value: "Первый" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Временно недоступно");
    await waitFor(() => expect(message).toBeEnabled());
    expect(pendingFilesList()).toHaveTextContent("notes.txt");
    expect(screen.getByRole("button", { name: "Убрать контекст" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.change(message, { target: { value: "Второй" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Модель отклонила вложение");
    await waitFor(() => expect(message).toBeEnabled());
    expect(pendingFilesList()).toHaveTextContent("notes.txt");

    fireEvent.change(message, { target: { value: "Третий" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(pendingFilesList()).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Прикрепить контекст" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(promptIndex).toBe(3);
  });

  it("показывает thumbnail только для image в composer и освобождает URL", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    const fileInput = screen.getByLabelText("Файлы для OpenCode");
    fireEvent.change(fileInput, {
      target: {
        files: [
          imageFile(),
          new File(["hello"], "notes.txt", { type: "text/plain" }),
          new File(["%PDF-1.7"], "manual.pdf", { type: "application/pdf" }),
        ],
      },
    });

    const list = await screen.findByRole("list", { name: "Выбранные файлы" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    const preview = await within(list).findByRole("img", { name: "pixel.png" });
    expect(preview).toHaveAttribute("src", "blob:mock-1");
    expect(within(list).getAllByRole("img")).toHaveLength(1);
    expect(within(list).getByText("notes.txt")).toBeVisible();
    expect(within(list).getByText("manual.pdf")).toBeVisible();
    expect(within(list).getByRole("button", { name: "Удалить вложение pixel.png" })).toBeVisible();
    expect(within(list).getByText("5 B")).toBeVisible();
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);

    fireEvent.click(within(list).getByRole("button", { name: "Удалить вложение pixel.png" }));
    await waitFor(() => expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-1"));
    expect(within(list).queryByRole("img")).toBeNull();

    fireEvent.change(fileInput, { target: { files: [imageFile("second.png")] } });
    const second = await within(list).findByRole("img", { name: "second.png" });
    expect(second).toHaveAttribute("src", "blob:mock-2");
    expect(createObjectUrlMock).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrlMock).not.toHaveBeenCalledWith("blob:mock-2");
  });

  it("сохраняет image preview после canonical refresh и освобождает URL при unmount", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    let canonicalCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return Promise.resolve(success(session()));
      }
      if (url === "/api/opencode/session/ses-1") {
        canonicalCalls += 1;
        return Promise.resolve(
          success({
            ...session(),
            messages: [
              {
                id: "user:canonical",
                role: "user",
                text: "Посмотри картинку",
                attachments: [{ name: "pixel.png", mime: "image/png" }],
              },
              { id: "assistant:canonical", role: "assistant", text: "Канонический ответ" },
            ],
          }),
        );
      }
      if (url.endsWith("/prompt")) {
        return new Promise<Response>((resolve) => {
          gate.release = () => resolve(stream([{ kind: "done" }]));
        });
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    const { unmount } = render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [imageFile()] },
    });
    expect(await screen.findByRole("img", { name: "pixel.png" })).toHaveAttribute(
      "src",
      "blob:mock-1",
    );
    fireEvent.change(message, { target: { value: "Посмотри картинку" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const optimistic = await screen.findByRole("list", { name: "Вложения сообщения" });
    const optimisticPreview = await within(optimistic).findByRole("img", { name: "pixel.png" });
    expect(optimisticPreview).toHaveAttribute("src", "blob:mock-2");
    expect(revokeObjectUrlMock).not.toHaveBeenCalledWith("blob:mock-2");

    if (gate.release === null) throw new Error("prompt не был отправлен");
    gate.release();
    expect(await screen.findByText("Канонический ответ")).toBeVisible();
    await waitFor(() => expect(canonicalCalls).toBe(1));

    const canonical = await screen.findByRole("list", { name: "Вложения сообщения" });
    const canonicalPreview = within(canonical).getByRole("img", { name: "pixel.png" });
    expect(canonicalPreview).toHaveAttribute("src", "blob:mock-2");
    expect(revokeObjectUrlMock).not.toHaveBeenCalledWith("blob:mock-2");
    expect(pendingFilesList()).toBeNull();
    // Пока local preview usable, remote endpoint не запрашивается.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/attachments/"))).toBe(false);

    fireEvent.error(canonicalPreview);
    await waitFor(() => expect(within(canonical).queryByRole("img")).toBeNull());
    expect(within(canonical).getByText("pixel.png")).toBeVisible();
    expect(within(canonical).getByText("image/png")).toBeVisible();

    unmount();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-2");
  });

  it("не переносит preview на одинаковое имя в другом user-message ordinal", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const gate: { release: (() => void) | null } = { release: null };
    let phase: "initial" | "canonical" = "initial";
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session/ses-1") {
        return Promise.resolve(
          success({
            ...session(),
            messages:
              phase === "initial"
                ? [
                    { id: "user:first", role: "user", text: "Первый" },
                    { id: "assistant:first", role: "assistant", text: "Первый ответ" },
                  ]
                : [
                    {
                      id: "user:first",
                      role: "user",
                      text: "Первый",
                      attachments: [{ name: "pixel.png", mime: "image/png" }],
                    },
                    { id: "user:second", role: "user", text: "Второй" },
                    { id: "assistant:second", role: "assistant", text: "Второй ответ" },
                  ],
          }),
        );
      }
      if (url.endsWith("/prompt")) {
        return new Promise<Response>((resolve) => {
          gate.release = () => {
            phase = "canonical";
            resolve(stream([{ kind: "done" }]));
          };
        });
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [imageFile()] },
    });
    expect(await screen.findByRole("img", { name: "pixel.png" })).toHaveAttribute(
      "src",
      "blob:mock-1",
    );
    fireEvent.change(message, { target: { value: "Второй" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const optimistic = await screen.findByRole("list", { name: "Вложения сообщения" });
    expect(await within(optimistic).findByRole("img", { name: "pixel.png" })).toHaveAttribute(
      "src",
      "blob:mock-2",
    );

    if (gate.release === null) throw new Error("prompt не был отправлен");
    gate.release();
    expect(await screen.findByText("Второй ответ")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(screen.getByText("pixel.png")).toBeVisible();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:mock-2");
  });
});
