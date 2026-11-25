import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  finishToolMessages,
  formatToolDuration,
  mergeToolMessage,
  ToolCallMessage,
  type OpenCodeToolMessage,
} from "./tool-call.tsx";
import { OPENCODE_CATALOG_TOOLS } from "./tool-metadata.ts";
import { OPENCODE_DRAFTS_KEY, readDrafts, writeDraft } from "./drafts.ts";
import { formatSessionUpdatedAt } from "./session-history.tsx";
import type { OpenCodeCatalog, OpenCodeSessionView, OpenCodeStreamEvent } from "./types.ts";
import { OpenCodePanel } from "./ui.tsx";

const catalog: OpenCodeCatalog = {
  providers: [
    { id: "provider-1", name: "Provider One", activation: "enabled" },
    { id: "provider-2", name: "Provider Two", activation: "enabled" },
    { id: "provider-3", name: "Provider Three", activation: "enabled" },
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
    {
      id: "model-3",
      providerID: "provider-3",
      name: "Model Three",
      type: "chat",
      variants: ["high"],
    },
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

function stream(
  events: readonly OpenCodeStreamEvent[],
  headers: Record<string, string> = {},
): Response {
  return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson", ...headers },
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

/** Первое чтение падает, второе отдаёт валидный text/plain base64. */
class FailsOnceFileReader {
  static calls = 0;
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  readAsDataURL(): void {
    FailsOnceFileReader.calls += 1;
    const call = FailsOnceFileReader.calls;
    queueMicrotask(() => {
      if (call === 1) this.onerror?.();
      else {
        this.result = "data:text/plain;base64,aGVsbG8=";
        this.onload?.();
      }
    });
  }

  abort(): void {
    this.onabort?.();
  }
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

function toolMessage(patch: Partial<OpenCodeToolMessage> = {}): OpenCodeToolMessage {
  return {
    id: "tool:1",
    role: "tool",
    name: "task_get",
    status: "completed",
    text: "",
    ...patch,
  };
}

function toolDetails(): HTMLDetailsElement {
  const details = screen.getByTestId("opencode-tool-call");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("tool details is missing");
  return details;
}

interface PanelScrollGeometry {
  grow(delta: number): void;
  readonly max: number;
}

/** jsdom не считает layout: задаём реальному scroll container управляемую геометрию. */
function controlPanelScroll(
  element: HTMLElement,
  initial: { readonly scrollHeight: number; readonly clientHeight: number },
): PanelScrollGeometry {
  let scrollHeight = initial.scrollHeight;
  const clientHeight = initial.clientHeight;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  element.scrollTop = Math.max(0, scrollHeight - clientHeight);
  return {
    grow(delta) {
      scrollHeight += delta;
    },
    get max() {
      return Math.max(0, scrollHeight - clientHeight);
    },
  };
}

function panelScroll(): HTMLElement {
  return screen.getByTestId("opencode-messages");
}

function jumpButton(): HTMLElement | null {
  return screen.queryByTestId("opencode-jump-to-latest");
}

function readPanelAbove(element: HTMLElement): void {
  element.scrollTop = 0;
  fireEvent.scroll(element);
}

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
            startedAt: 1000,
          },
          {
            kind: "tool",
            id: "message-1:call-1",
            status: "running",
            text: '{"id":"task-1"}',
            input: '{"id":"task-1"}',
            startedAt: 1200,
          },
          {
            kind: "tool",
            id: "message-1:call-1",
            status: "running",
            text: '{"id":"task-1"}',
            input: '{"id":"task-1"}',
            startedAt: 1400,
          },
          {
            kind: "tool",
            id: "message-1:call-1",
            status: "completed",
            text: "Обновлено",
            output: "Обновлено",
            endedAt: 3600,
          },
          {
            kind: "tool",
            id: "message-1:call-1",
            status: "running",
            text: "",
            startedAt: 4000,
          },
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
    expect(screen.getByTestId("opencode-tool-call")).toBeInTheDocument();
    expect(screen.getByText("готово")).toBeVisible();
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveTextContent("2 с");
    // Компактный summary по умолчанию: детали скрыты до явного раскрытия.
    expect(screen.queryByTestId("opencode-tool-call-output")).not.toBeVisible();
    expect(screen.queryByTestId("opencode-tool-call-input")).not.toBeVisible();
    fireEvent.click(screen.getByTestId("opencode-tool-call-summary"));
    expect(screen.getByTestId("opencode-tool-call-input")).toHaveTextContent('{"id":"task-1"}');
    expect(screen.getByTestId("opencode-tool-call-output")).toHaveTextContent("Обновлено");
    // Позднее running-событие не понизило completed.
    expect(screen.getByText("готово")).toBeVisible();
    expect(screen.queryByText("Черновой ответ")).toBeNull();

    const promptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/prompt"));
    expect(JSON.parse(String(promptCall?.[1]?.body))).toMatchObject({
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

  it("после 404 показывает empty state с CTA, не создаёт сессию и не трогает чужой draft", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-old");
    writeDraft("ses-old", "чужой черновик", 1000);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session/ses-old") return failure(404, "NOT_FOUND");
      if (url === "/api/opencode/session" && init?.method === "POST")
        return success(session("ses-new"));
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    expect(await screen.findByText("Сохранённая сессия не найдена.")).toBeVisible();
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBeNull();
    const message = screen.getByRole("textbox", { name: "Сообщение OpenCode" });
    expect(message).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === "/api/opencode/session" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(readDrafts().get("ses-old")).toBe("чужой черновик");

    fireEvent.click(screen.getByRole("button", { name: "Новая сессия" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new"),
    );
    await waitFor(() => expect(message).toBeEnabled());
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/opencode/session" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(message).toHaveValue("");
    expect(readDrafts().get("ses-old")).toBe("чужой черновик");
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

  it("повреждённый NDJSON даёт unconfirmed без авто-refresh и сохраняет streamed-сообщения", async () => {
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

    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(status).toHaveTextContent("Не удалось подтвердить результат OpenCode");
    expect(status).toHaveTextContent("Проверить статус");
    expect(screen.queryByRole("button", { name: "Повторить запрос" })).toBeNull();
    expect(screen.queryByText("Canonical")).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/opencode/session/ses-1" && init?.method === undefined,
      ),
    ).toBe(false);
    expect(screen.getByText("Запрос")).toBeVisible();
    await waitFor(() => expect(streamCancelled).toBe(true));
    expect(promptSignal?.aborted).toBe(true);
  });

  it("rejected stream после admission даёт unconfirmed без retry и второго POST", async () => {
    let promptCalls = 0;
    let pullCount = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ kind: "delta", id: "message-1:0", text: "Черновик" })}\n`,
            ),
          );
          return;
        }
        controller.error(new Error("network reset after admission"));
      },
    });
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return Promise.resolve(success(session()));
      }
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return Promise.resolve(new Response(broken));
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    });
    render(<OpenCodePanel />);

    const input = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "Запрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(status).toHaveTextContent("Проверить статус");
    expect(screen.queryByRole("button", { name: "Повторить запрос" })).toBeNull();
    expect(screen.getByText("Черновик")).toBeVisible();
    expect(promptCalls).toBe(1);
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
    expect(JSON.parse(String(promptCall?.[1]?.body))).toMatchObject({
      text: "Без старого контекста",
    });
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
    fireEvent.click(screen.getByTestId("opencode-tool-call-summary"));
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
      expect.objectContaining({
        text: "Посмотри файл",
        files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
      }),
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
    expect(promptBodies[0]).toMatchObject({
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
    expect(promptBodies[0]).toMatchObject({
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
    expect(await screen.findByTestId("opencode-turn-status")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Временно недоступно"),
    );
    expect(screen.getByRole("button", { name: "Повторить запрос" })).toBeVisible();
    await waitFor(() => expect(message).toBeEnabled());
    expect(pendingFilesList()).toHaveTextContent("notes.txt");
    expect(screen.getByRole("button", { name: "Убрать контекст" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.change(message, { target: { value: "Второй" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Модель отклонила вложение",
      ),
    );
    expect(screen.queryByRole("button", { name: "Повторить запрос" })).toBeNull();
    await waitFor(() => expect(message).toBeEnabled());
    expect(pendingFilesList()).toHaveTextContent("notes.txt");

    fireEvent.change(message, { target: { value: "Третий" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(pendingFilesList()).toBeNull());
    expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Прикрепить контекст" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(promptIndex).toBe(3);
  });

  it("повторяет только pre-admission ошибку с тем же текстом и файлами", async () => {
    const promptBodies: unknown[] = [];
    const responses: Array<() => Response> = [
      () => failure(503),
      () => stream([{ kind: "finalizing" }, { kind: "done" }]),
    ];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)));
        const next = responses.shift();
        if (next === undefined) throw new Error("Unexpected prompt");
        return next();
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Повтори меня" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Временно недоступно"));
    const retry = screen.getByRole("button", { name: "Повторить запрос" });
    fireEvent.click(retry);

    await waitFor(() => expect(promptBodies).toHaveLength(2));
    expect(promptBodies[1]).toEqual(promptBodies[0]);
    expect(promptBodies[1]).toMatchObject({
      text: "Повтори меня",
      files: [expect.objectContaining({ name: "notes.txt" })],
    });
    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent("Готово");
    await waitFor(() => expect(pendingFilesList()).toBeNull());
    expect(screen.queryByRole("button", { name: "Повторить запрос" })).toBeNull();
  });

  it("Проверить статус: pending сохраняет сообщения, success применяет canonical без prompt", async () => {
    const promptBodies: unknown[] = [];
    const statusResponses: Array<() => Response> = [
      () =>
        success({
          session: {
            ...session(),
            messages: [{ id: "user:1", role: "user", text: "Вопрос" }],
          },
          outcome: "pending",
        }),
      () =>
        success({
          session: {
            ...session(),
            messages: [
              { id: "user:1", role: "user", text: "Вопрос" },
              { id: "assistant:1", role: "assistant", text: "Канонический ответ" },
            ],
          },
          outcome: "done",
        }),
    ];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        const next = statusResponses.shift();
        if (next === undefined) throw new Error("Unexpected status GET");
        return next();
      }
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)));
        return stream([{ kind: "finalizing" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(promptBodies).toHaveLength(1);
    expect(statusResponses).toHaveLength(2);
    expect(screen.getByText("Вопрос")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Результат пока не подтверждён"));
    expect(statusResponses).toHaveLength(1);
    expect(promptBodies).toHaveLength(1);
    expect(screen.getByText("Вопрос")).toBeVisible();
    expect(screen.queryByText("Канонический ответ")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    expect(statusResponses).toHaveLength(0);
    expect(promptBodies).toHaveLength(1);
    expect(screen.getByText("Канонический ответ")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Проверить статус" })).toBeNull();
  });

  it("Проверить статус: canonical error и сбой проверки показываются в turn status", async () => {
    let getCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        getCount += 1;
        if (getCount === 1) return failure(503);
        return success({
          session: {
            ...session(),
            messages: [
              { id: "user:1", role: "user", text: "Вопрос" },
              { id: "error:assistant-1", role: "system", text: "Canonical failure" },
            ],
          },
          outcome: "error",
        });
      }
      if (url.endsWith("/prompt")) return stream([{ kind: "finalizing" }]);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Не удалось проверить статус"));
    expect(status).toHaveTextContent("Временно недоступно");
    expect(status).toHaveTextContent("Результат не подтверждён");

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("OpenCode сообщил об ошибке"));
    expect(getCount).toBe(2);
  });

  it("не применяет устаревшую проверку статуса к новой сессии", async () => {
    let resolveStatus!: (response: Response) => void;
    let statusSignal: AbortSignal | null | undefined;
    let sessionPosts = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        sessionPosts += 1;
        return Promise.resolve(success(session(sessionPosts === 1 ? "ses-1" : "ses-2")));
      }
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        statusSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveStatus = resolve;
        });
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "finalizing" }]));
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Старый вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(statusSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    await waitFor(() => expect(sessionPosts).toBe(2));
    resolveStatus(
      success({
        session: {
          ...session("ses-1"),
          messages: [
            { id: "user:1", role: "user", text: "Старый вопрос" },
            { id: "assistant:stale", role: "assistant", text: "Устаревший ответ" },
          ],
        },
        outcome: "done",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Устаревший ответ")).toBeNull();
    expect(screen.queryByTestId("opencode-turn-status")).toBeNull();
  });

  it("ручной canonical error сохраняет streamed assistant текст", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        return success({
          session: {
            ...session(),
            messages: [
              { id: "user:1", role: "user", text: "Вопрос" },
              { id: "error:assistant-1", role: "system", text: "Сбой canonical" },
            ],
          },
          outcome: "error",
        });
      }
      if (url.endsWith("/prompt")) {
        return stream([
          { kind: "delta", id: "message-1:0", text: "Черновик" },
          { kind: "finalizing" },
        ]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(screen.getByText("Черновик")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("OpenCode сообщил об ошибке"));
    expect(screen.getByText("Черновик")).toBeVisible();
    expect(screen.queryByText("Сбой canonical")).toBeNull();
  });

  it("ручной canonical cancelled сохраняет streamed assistant текст", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        return success({ session: session(), outcome: "cancelled" });
      }
      if (url.endsWith("/prompt")) {
        return stream([
          { kind: "delta", id: "message-1:0", text: "Черновик" },
          { kind: "finalizing" },
        ]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Результат не подтверждён"));

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Остановлено"));
    expect(screen.getByText("Черновик")).toBeVisible();
  });

  it("ручной canonical done принимает пустой успешный ответ", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        return success({ session: session(), outcome: "done" });
      }
      if (url.endsWith("/prompt")) return stream([{ kind: "finalizing" }]);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Результат не подтверждён"));

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    expect(screen.queryByRole("button", { name: "Проверить статус" })).toBeNull();
    expect(message).toBeEnabled();
  });

  it("tool-only успешный stream завершается done без assistant текста", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            {
              id: "message-1:call-1",
              role: "tool",
              name: "task_get",
              status: "completed",
              text: "Готово",
            },
          ],
        });
      }
      if (url.endsWith("/prompt")) {
        return stream([
          { kind: "tool", id: "message-1:call-1", name: "task_get", status: "running", text: "" },
          { kind: "tool", id: "message-1:call-1", status: "completed", text: "Готово" },
          { kind: "finalizing" },
          { kind: "done" },
        ]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    expect(screen.getByText("task_get")).toBeVisible();
    expect(screen.getAllByText("Готово").length).toBeGreaterThan(0);
  });

  it("показывает стадии prompt: Подключаемся → Выполняется → Завершаем → Готово", async () => {
    let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        writer = controller;
      },
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) return new Response(body);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Подключаемся");
    const encode = (event: unknown): Uint8Array =>
      new TextEncoder().encode(`${JSON.stringify(event)}\n`);
    if (writer === undefined) throw new Error("stream controller is missing");

    writer.enqueue(encode({ kind: "delta", id: "message-1:0", text: "Ответ" }));
    await waitFor(() => expect(status).toHaveTextContent("Выполняется"));
    writer.enqueue(encode({ kind: "finalizing" }));
    await waitFor(() => expect(status).toHaveTextContent("Завершаем"));
    writer.enqueue(encode({ kind: "done" }));
    writer.close();
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
  });

  it("ручная проверка второго prompt использует его stable ID, а не ordinal", async () => {
    const promptBodies: Array<{ turnID: string }> = [];
    const statusQueries: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        const turnID = decodeURIComponent(url.split("turnID=")[1] ?? "");
        statusQueries.push(turnID);
        const second = promptBodies[1]?.turnID;
        if (turnID === second) {
          return success({
            session: {
              ...session(),
              messages: [
                { id: second, role: "user", text: "Второй" },
                { id: "assistant:second", role: "assistant", text: "Второй ответ" },
              ],
            },
            outcome: "done",
          });
        }
        return success({ session: session(), outcome: "missing" });
      }
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)) as { turnID: string });
        return stream([{ kind: "finalizing" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Первый" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Результат не подтверждён",
      ),
    );

    fireEvent.change(message, { target: { value: "Второй" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Результат не подтверждён",
      ),
    );
    expect(promptBodies).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(screen.getByText("Второй ответ")).toBeVisible();
    expect(statusQueries).not.toContain(promptBodies[0]?.turnID);
    expect(statusQueries.at(-1)).toBe(promptBodies[1]?.turnID);
  });

  it("ручная проверка использует admitted ID вне client pattern", async () => {
    const promptBodies: Array<{ turnID: string }> = [];
    const statusQueries: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        const turnID = decodeURIComponent(url.split("turnID=")[1] ?? "");
        statusQueries.push(turnID);
        return success({
          session: {
            ...session(),
            messages: [
              { id: turnID, role: "user", text: "Вопрос" },
              { id: "assistant:admitted", role: "assistant", text: "Ответ admitted" },
            ],
          },
          outcome: "done",
        });
      }
      if (url.endsWith("/prompt")) {
        promptBodies.push(JSON.parse(String(init?.body)) as { turnID: string });
        return stream([{ kind: "admitted", id: "inbox-admitted" }, { kind: "finalizing" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);

    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Результат не подтверждён"));

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    expect(screen.getByText("Ответ admitted")).toBeVisible();
    expect(statusQueries).toEqual(["inbox-admitted"]);
    expect(promptBodies).toHaveLength(1);
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

  it("не выталкивает читающего выше из streaming/canonical и возвращает кнопкой", async () => {
    const history = Array.from({ length: 8 }, (_value, index) => ({
      id: `assistant:history-${index}`,
      role: "assistant" as const,
      text: `Длинная история ${index}. `.repeat(20),
    }));
    const canonical = [
      ...history,
      { id: "assistant:canonical", role: "assistant" as const, text: "Канонический ответ" },
    ];
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let canonicalRequests = 0;

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return success({ ...session(), messages: history });
      }
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        canonicalRequests += 1;
        return success({
          session: { ...session(), messages: canonical },
          outcome: "done",
        });
      }
      if (url.endsWith("/prompt") && init?.method === "POST") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<OpenCodePanel />);
    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());

    const scroll = panelScroll();
    await waitFor(() => expect(scroll).toHaveTextContent("Длинная история 0."));
    const geometry = controlPanelScroll(scroll, { scrollHeight: 4000, clientHeight: 800 });
    scroll.scrollTop = geometry.max;
    fireEvent.scroll(scroll);
    expect(jumpButton()).toBeNull();

    const encoder = new TextEncoder();
    const sendEvent = (event: unknown): void => {
      act(() => {
        streamController?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      });
    };

    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    // Отправка явно включает follow: optimistic user message виден.
    await waitFor(() => expect(streamController).not.toBeNull());
    expect(jumpButton()).toBeNull();
    expect(scroll.scrollTop).toBe(geometry.max);

    sendEvent({ kind: "delta", id: "message-1:0", text: "Потоковый " });
    expect(await screen.findByText(/Потоковый/u)).toBeVisible();

    // Пользователь уходит читать выше во время streaming.
    readPanelAbove(scroll);
    expect(jumpButton()).toBeVisible();

    geometry.grow(600);
    sendEvent({ kind: "delta", id: "message-1:0", text: "ответ" });
    sendEvent({ kind: "text", id: "message-1:0", text: "Потоковый ответ" });
    sendEvent({
      kind: "tool",
      id: "call-1",
      name: "read",
      status: "running",
      text: "",
      startedAt: 1000,
    });
    sendEvent({
      kind: "tool",
      id: "call-1",
      name: "read",
      status: "completed",
      text: "",
      output: "ok",
      endedAt: 2000,
    });
    expect(await screen.findByText("Потоковый ответ")).toBeVisible();
    expect(await screen.findByTestId("opencode-tool-call")).toBeInTheDocument();
    expect(scroll.scrollTop).toBe(0);
    expect(jumpButton()).toBeVisible();
    expect(screen.getByTestId("opencode-unread-count")).toBeInTheDocument();

    // Оборванный после finalizing поток даёт unconfirmed, но не двигает чтение.
    sendEvent({ kind: "finalizing" });
    act(() => streamController?.close());
    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Результат не подтверждён"));
    expect(scroll.scrollTop).toBe(0);
    expect(jumpButton()).toBeVisible();

    // Ручной canonical done той же сессии заменяет сообщения, но не scrollTop.
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(await screen.findByText("Канонический ответ")).toBeVisible();
    expect(canonicalRequests).toBe(1);
    expect(scroll.scrollTop).toBe(0);
    expect(jumpButton()).toBeVisible();

    const button = jumpButton();
    if (button === null) throw new Error("кнопка возврата не появилась");
    expect(button.tagName).toBe("BUTTON");
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
    const focusSpy = vi.spyOn(scroll, "focus");
    fireEvent.click(button);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(scroll.scrollTop).toBe(geometry.max);
    expect(jumpButton()).toBeNull();

    // После явного возврата следующий prompt и его streaming снова следуют.
    streamController = null;
    geometry.grow(200);
    fireEvent.change(message, { target: { value: "Ещё" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(streamController).not.toBeNull());
    sendEvent({ kind: "delta", id: "message-2:0", text: "Второй ответ" });
    expect(await screen.findByText("Второй ответ")).toBeVisible();
    expect(scroll.scrollTop).toBe(geometry.max);
    expect(jumpButton()).toBeNull();
    sendEvent({ kind: "done" });
    act(() => streamController?.close());
  });

  it("новая session сбрасывает unread и открывает конец истории", async () => {
    const history = Array.from({ length: 5 }, (_value, index) => ({
      id: `assistant:history-${index}`,
      role: "assistant" as const,
      text: `История ${index}. `.repeat(20),
    }));
    let created = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") {
        created += 1;
        return success({
          ...session(created === 1 ? "ses-1" : "ses-2"),
          messages: created === 1 ? history : [],
        });
      }
      if (url === "/api/opencode/session/ses-1") {
        return success({
          ...session(),
          messages: [
            ...history,
            { id: "user:new", role: "user", text: "Новый вопрос" },
            { id: "assistant:new", role: "assistant", text: "Новый ответ" },
          ],
        });
      }
      if (url.endsWith("/prompt")) {
        return stream([{ kind: "text", id: "message-1:0", text: "Новый ответ" }, { kind: "done" }]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<OpenCodePanel />);
    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());

    const scroll = panelScroll();
    await waitFor(() => expect(scroll).toHaveTextContent("История 0."));
    const geometry = controlPanelScroll(scroll, { scrollHeight: 3000, clientHeight: 600 });
    scroll.scrollTop = geometry.max;
    fireEvent.scroll(scroll);
    readPanelAbove(scroll);
    expect(jumpButton()).toBeVisible();

    // Новый prompt включает follow, даже если пользователь читал выше.
    fireEvent.change(message, { target: { value: "Новый вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(jumpButton()).toBeNull();
    expect(scroll.scrollTop).toBe(geometry.max);
    expect(await screen.findByText("Новый ответ")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(jumpButton()).toBeNull();
    expect(scroll.scrollTop).toBe(geometry.max);

    readPanelAbove(scroll);
    expect(jumpButton()).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-2"),
    );
    expect(jumpButton()).toBeNull();
    expect(scroll.scrollTop).toBe(geometry.max);
  });
});

describe("formatToolDuration", () => {
  it("форматирует миллисекунды, секунды и минуты детерминированно", () => {
    expect(formatToolDuration(0)).toBe("0 мс");
    expect(formatToolDuration(999)).toBe("999 мс");
    expect(formatToolDuration(1000)).toBe("1 с");
    expect(formatToolDuration(59_999)).toBe("59 с");
    expect(formatToolDuration(60_000)).toBe("1 мин 0 с");
    expect(formatToolDuration(125_000)).toBe("2 мин 5 с");
  });

  it("не показывает длительность для отрицательных и невалидных значений", () => {
    expect(formatToolDuration(-1)).toBeNull();
    expect(formatToolDuration(Number.NaN)).toBeNull();
    expect(formatToolDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("mergeToolMessage", () => {
  it("создаёт tool call из stream event и использует fallback ID", () => {
    const merged = mergeToolMessage(
      undefined,
      {
        kind: "tool",
        id: "call-1",
        name: "task_update",
        status: "running",
        startedAt: 1000,
        input: '{"id":"task-1"}',
      },
      "fallback",
    );
    expect(merged).toMatchObject({
      id: "call-1",
      role: "tool",
      name: "task_update",
      status: "running",
      text: "",
      startedAt: 1000,
      input: '{"id":"task-1"}',
    });
    expect(merged.endedAt).toBeUndefined();
    expect(merged.output).toBeUndefined();

    const fallback = mergeToolMessage(undefined, { kind: "tool" }, "fallback");
    expect(fallback).toMatchObject({
      id: "fallback",
      name: "tool",
      status: "running",
      text: "",
    });
  });

  it("сохраняет ранний startedAt, первый endedAt и непустые поля", () => {
    const existing = toolMessage({
      status: "running",
      startedAt: 2000,
      input: "in",
      text: "early",
    });
    const merged = mergeToolMessage(
      existing,
      {
        kind: "tool",
        id: "tool:1",
        status: "running",
        startedAt: 1500,
        input: "in-2",
        output: "",
      },
      "fallback",
    );
    expect(merged.startedAt).toBe(1500);
    expect(merged.input).toBe("in-2");
    expect(merged.output).toBeUndefined();
    expect(merged.text).toBe("early");

    const finished = mergeToolMessage(
      toolMessage({ status: "completed", startedAt: 1000, endedAt: 3000, output: "ok" }),
      { kind: "tool", status: "error", endedAt: 5000, output: "" },
      "fallback",
    );
    expect(finished.status).toBe("error");
    expect(finished.endedAt).toBe(3000);
    expect(finished.output).toBe("ok");
  });

  it("не понижает terminal status поздним running и не затирает пустыми значениями", () => {
    const merged = mergeToolMessage(
      toolMessage({
        status: "cancelled",
        startedAt: 1000,
        endedAt: 2000,
        input: "in",
        output: "out",
        text: "text",
      }),
      {
        kind: "tool",
        id: "tool:1",
        status: "running",
        name: "",
        text: "",
        input: "",
        output: "",
        startedAt: 500,
      },
      "fallback",
    );
    expect(merged).toMatchObject({
      status: "cancelled",
      name: "task_get",
      startedAt: 500,
      endedAt: 2000,
      input: "in",
      output: "out",
      text: "text",
    });
  });
});

describe("finishToolMessages", () => {
  it("завершает только running tools из переданного turn scope и сохраняет endedAt", () => {
    const running = toolMessage({ id: "tool:running", status: "running", startedAt: 1000 });
    const frozen = toolMessage({ id: "tool:frozen", status: "running", endedAt: 2500 });
    const done = toolMessage({ id: "tool:done", status: "completed", endedAt: 2000 });
    const assistant = { id: "assistant:1", role: "assistant", text: "Ответ" } as const;

    const next = finishToolMessages(
      [running, frozen, done, assistant],
      new Set(["tool:running", "tool:frozen", "tool:done"]),
      "done",
      4000,
    );
    expect(next).toEqual([
      { ...running, status: "completed", endedAt: 4000 },
      { ...frozen, status: "completed", endedAt: 2500 },
      done,
      assistant,
    ]);
  });

  it("не завершает running tool вне scope и ничего не делает с пустым набором", () => {
    const own = toolMessage({ id: "tool:own", status: "running", startedAt: 1000 });
    const foreign = toolMessage({ id: "tool:foreign", status: "running", startedAt: 500 });
    const messages = [foreign, own];

    const scoped = finishToolMessages(messages, new Set(["tool:own"]), "cancelled", 2000);
    expect(scoped).toEqual([foreign, { ...own, status: "cancelled", endedAt: 2000 }]);

    expect(finishToolMessages(messages, new Set<string>(), "error", 3000)).toBe(messages);
  });

  it("маппит terminal kind в cancelled/error и возвращает тот же массив без running", () => {
    const running = toolMessage({ id: "tool:running", status: "running" });
    const scope = new Set(["tool:running"]);
    expect(finishToolMessages([running], scope, "cancelled", 1000)).toEqual([
      { ...running, status: "cancelled", endedAt: 1000 },
    ]);
    expect(finishToolMessages([running], scope, "error", 1000)).toEqual([
      { ...running, status: "error", endedAt: 1000 },
    ]);

    const done = toolMessage({ id: "tool:done", status: "completed" });
    const messages = [done];
    expect(finishToolMessages(messages, new Set(["tool:done"]), "done", 1000)).toBe(messages);
  });
});

describe("ToolCallMessage", () => {
  it("по умолчанию свёрнут и раскрывает input/output по клику", () => {
    render(
      <ToolCallMessage
        message={toolMessage({
          status: "completed",
          input: '{"id":"task-1"}',
          output: "Обновлено",
        })}
      />,
    );

    expect(toolDetails().open).toBe(false);
    expect(screen.getByTestId("opencode-tool-call-summary")).toHaveTextContent("task_get");
    expect(screen.getByText("готово")).toBeVisible();
    expect(screen.queryByTestId("opencode-tool-call-input")).not.toBeVisible();
    expect(screen.queryByTestId("opencode-tool-call-output")).not.toBeVisible();

    fireEvent.click(screen.getByTestId("opencode-tool-call-summary"));
    expect(toolDetails().open).toBe(true);
    expect(screen.getByTestId("opencode-tool-call-input")).toHaveTextContent('{"id":"task-1"}');
    expect(screen.getByTestId("opencode-tool-call-output")).toHaveTextContent("Обновлено");
  });

  it("переключается с клавиатуры Enter и Space", () => {
    render(<ToolCallMessage message={toolMessage({ output: "ok" })} />);
    const summary = screen.getByTestId("opencode-tool-call-summary");

    fireEvent.keyDown(summary, { key: "Enter" });
    expect(toolDetails().open).toBe(true);
    fireEvent.keyDown(summary, { key: "Enter" });
    expect(toolDetails().open).toBe(false);
    fireEvent.keyDown(summary, { key: " " });
    expect(toolDetails().open).toBe(true);
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(toolDetails().open).toBe(true);
  });

  it("тикает длительность running и фиксирует её после terminal статуса", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { rerender } = render(
      <ToolCallMessage
        message={toolMessage({ status: "running", startedAt: 9000, output: "pending" })}
      />,
    );
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveTextContent("1 с");
    // Ticking timer не должен анонсироваться screen reader-ом каждую секунду.
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveAttribute("role", "timer");
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveAttribute("aria-live", "off");
    expect(screen.getByTestId("opencode-tool-call-summary")).toHaveTextContent("выполняется");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveTextContent("3 с");

    rerender(
      <ToolCallMessage
        message={toolMessage({
          status: "completed",
          startedAt: 9000,
          endedAt: 11_000,
          output: "done",
        })}
      />,
    );
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveTextContent("2 с");

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveTextContent("2 с");
  });

  it("очищает interval при unmount в StrictMode", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(
      <StrictMode>
        <ToolCallMessage message={toolMessage({ status: "running", startedAt: Date.now() })} />
      </StrictMode>,
    );

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
  });

  it("показывает legacy text как output без фиктивной длительности", () => {
    const { rerender } = render(
      <ToolCallMessage message={toolMessage({ status: "completed", text: "legacy output" })} />,
    );
    expect(screen.queryByTestId("opencode-tool-call-duration")).toBeNull();
    fireEvent.click(screen.getByTestId("opencode-tool-call-summary"));
    expect(screen.getByTestId("opencode-tool-call-output")).toHaveTextContent("legacy output");
    expect(screen.queryByTestId("opencode-tool-call-input")).toBeNull();

    rerender(
      <ToolCallMessage
        message={toolMessage({ startedAt: 10_000, endedAt: 9000, text: "legacy" })}
      />,
    );
    expect(screen.queryByTestId("opencode-tool-call-duration")).toBeNull();

    rerender(<ToolCallMessage message={toolMessage({ endedAt: 9000, text: "legacy" })} />);
    expect(screen.queryByTestId("opencode-tool-call-duration")).toBeNull();
  });

  it("показывает статусы running, error и cancelled", () => {
    const { rerender } = render(
      <ToolCallMessage message={toolMessage({ status: "running", startedAt: Date.now() })} />,
    );
    expect(screen.getByText("выполняется")).toBeVisible();
    rerender(<ToolCallMessage message={toolMessage({ status: "error" })} />);
    expect(screen.getByText("ошибка")).toBeVisible();
    rerender(<ToolCallMessage message={toolMessage({ status: "cancelled" })} />);
    expect(screen.getByText("отменено")).toBeVisible();
    rerender(<ToolCallMessage message={toolMessage({ status: "completed" })} />);
    expect(screen.getByText("готово")).toBeVisible();
  });
});

describe("OpenCode tool calls в панели", () => {
  function mountStreamingTool(): {
    readonly writer: () => ReadableStreamDefaultController<Uint8Array>;
  } {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1") return success(session());
      if (url.endsWith("/prompt")) {
        // Mock fetch не связан с AbortSignal сам по себе: пробрасываем abort в
        // stream, чтобы Stop завершил pending reader так же, как реальный fetch.
        init?.signal?.addEventListener("abort", () => controller?.error(abortError()), {
          once: true,
        });
        return new Response(body);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    return {
      writer: () => {
        if (controller === undefined) throw new Error("stream controller is missing");
        return controller;
      },
    };
  }

  async function sendPrompt(text = "Вопрос"): Promise<void> {
    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    fireEvent.change(message, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
  }

  function encode(event: unknown): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  }

  it("помечает tool отменённым при Stop и сворачивает детали", async () => {
    const source = mountStreamingTool();
    render(<OpenCodePanel />);
    await sendPrompt();

    source.writer().enqueue(
      encode({
        kind: "tool",
        id: "message-1:call-1",
        name: "task_update",
        status: "running",
        startedAt: Date.now() - 3000,
        input: '{"id":"task-1"}',
      }),
    );
    expect(await screen.findByText("выполняется")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Остановить OpenCode" }));
    expect(await screen.findByText("отменено")).toBeVisible();
    expect(toolDetails().open).toBe(false);
    expect(screen.getByTestId("opencode-tool-call-summary")).toHaveTextContent("task_update");
    expect(screen.queryByTestId("opencode-tool-call-duration")).not.toBeNull();
    expect(screen.getByTestId("opencode-tool-call-input")).not.toBeVisible();
  });

  it("помечает running tool ошибкой при error stream", async () => {
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
            startedAt: Date.now() - 2000,
          },
          { kind: "error", text: "Сбой инструмента" },
        ]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);
    await sendPrompt();

    expect(await screen.findByText("ошибка")).toBeVisible();
    expect(screen.getByTestId("opencode-tool-call-summary")).toHaveTextContent("task_update");
    expect(screen.getByTestId("opencode-tool-call-duration")).toHaveTextContent(/^\d+ (мс|с|мин)/u);
  });

  it("не завершает running tool при unconfirmed результате", async () => {
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encode({
            kind: "tool",
            id: "message-1:call-1",
            name: "task_update",
            status: "running",
            startedAt: Date.now() - 1000,
          }),
        );
        controller.enqueue(new TextEncoder().encode("{broken\n"));
        controller.close();
      },
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.endsWith("/prompt")) return new Response(malformed);
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);
    await sendPrompt();

    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );
    expect(screen.getByText("выполняется")).toBeVisible();
    expect(screen.queryByText("отменено")).toBeNull();
    expect(screen.queryByText("ошибка")).toBeNull();
  });

  it("не применяет stale terminal статус к tools новой сессии", async () => {
    let resolveStatus!: (response: Response) => void;
    let statusSignal: AbortSignal | null | undefined;
    let sessionPosts = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && init?.method === "POST") {
        sessionPosts += 1;
        if (sessionPosts === 1) return Promise.resolve(success(session("ses-1")));
        return Promise.resolve(
          success({
            ...session("ses-2"),
            messages: [
              {
                id: "tool:new",
                role: "tool",
                name: "task_get",
                status: "running",
                text: "",
                startedAt: Date.now() - 1000,
              },
            ],
          }),
        );
      }
      if (url.startsWith("/api/opencode/session/ses-1?turnID=") && init?.method === undefined) {
        statusSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveStatus = resolve;
        });
      }
      if (url.endsWith("/prompt")) {
        return Promise.resolve(
          stream([
            {
              kind: "tool",
              id: "message-1:call-1",
              name: "task_update",
              status: "running",
              startedAt: Date.now() - 2000,
            },
            { kind: "finalizing" },
          ]),
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);
    await sendPrompt("Старый вопрос");

    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );
    expect(screen.getByText("выполняется")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(statusSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    await waitFor(() => expect(sessionPosts).toBe(2));
    expect(await screen.findByText("task_get")).toBeVisible();
    expect(screen.getByText("выполняется")).toBeVisible();
    expect(screen.queryByText("task_update")).toBeNull();

    resolveStatus(success({ session: session("ses-1"), outcome: "cancelled" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("task_get")).toBeVisible();
    expect(screen.getByText("выполняется")).toBeVisible();
    expect(screen.queryByText("отменено")).toBeNull();
    expect(screen.queryByText("task_update")).toBeNull();
  });

  function toolRow(name: string): HTMLElement {
    const details = screen.getByText(name).closest("details");
    if (!(details instanceof HTMLElement)) throw new Error(`tool details for ${name} is missing`);
    return details;
  }

  function unconfirmedToolA(): OpenCodeStreamEvent[] {
    return [
      {
        kind: "tool",
        id: "turn-a:call-a",
        name: "task_a",
        status: "running",
        startedAt: Date.now() - 2000,
      },
      { kind: "finalizing" },
    ];
  }

  function mountTwoTurns(
    second: readonly OpenCodeStreamEvent[],
    secondSession?: () => Response,
  ): { promptCalls: () => number } {
    let promptCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1" && init?.method === undefined) {
        return secondSession === undefined ? success(session()) : secondSession();
      }
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return stream(promptCalls === 1 ? unconfirmedToolA() : second);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    return { promptCalls: () => promptCalls };
  }

  async function sendTwoPrompts(): Promise<void> {
    render(<OpenCodePanel />);
    await sendPrompt("Первый вопрос");
    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
    await sendPrompt("Второй вопрос");
  }

  it("terminal error нового хода не завершает unconfirmed tool предыдущего", async () => {
    mountTwoTurns([
      {
        kind: "tool",
        id: "turn-b:call-b",
        name: "task_b",
        status: "running",
        startedAt: Date.now() - 1000,
      },
      { kind: "error", text: "Сбой инструмента" },
    ]);
    await sendTwoPrompts();

    await waitFor(() => expect(toolRow("task_b")).toHaveTextContent("ошибка"));
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
  });

  it("terminal cancelled нового хода не завершает unconfirmed tool предыдущего", async () => {
    mountTwoTurns([
      {
        kind: "tool",
        id: "turn-b:call-b",
        name: "task_b",
        status: "running",
        startedAt: Date.now() - 1000,
      },
      { kind: "cancelled", text: "Запрос остановлен" },
    ]);
    await sendTwoPrompts();

    await waitFor(() => expect(toolRow("task_b")).toHaveTextContent("отменено"));
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
  });

  it("done нового хода завершает только его tool, даже если refresh не удался", async () => {
    mountTwoTurns(
      [
        {
          kind: "tool",
          id: "turn-b:call-b",
          name: "task_b",
          status: "running",
          startedAt: Date.now() - 1000,
        },
        { kind: "done" },
      ],
      () => failure(500),
    );
    await sendTwoPrompts();

    await waitFor(() => expect(toolRow("task_b")).toHaveTextContent("готово"));
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
  });

  it("явный nonAdmission не завершает tools текущего или прошлого хода", async () => {
    mountTwoTurns([
      {
        kind: "tool",
        id: "turn-b:call-b",
        name: "task_b",
        status: "running",
        startedAt: Date.now() - 1000,
      },
      { kind: "error", text: "Prompt не принят", nonAdmission: true, retryable: true },
    ]);
    await sendTwoPrompts();

    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Ошибка запроса"),
    );
    expect(toolRow("task_b")).toHaveTextContent("выполняется");
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
  });

  it("ручная проверка cancelled завершает только tools проверяемого хода", async () => {
    let promptCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) {
        return success({ session: session("ses-1"), outcome: "cancelled" });
      }
      if (url === "/api/opencode/session/ses-1" && init?.method === undefined) {
        return success(session());
      }
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return stream(
          promptCalls === 1
            ? unconfirmedToolA()
            : [
                {
                  kind: "tool",
                  id: "turn-b:call-b",
                  name: "task_b",
                  status: "running",
                  startedAt: Date.now() - 1000,
                },
                { kind: "finalizing" },
              ],
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);
    await sendPrompt("Первый вопрос");
    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );
    await sendPrompt("Второй вопрос");
    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
    expect(toolRow("task_b")).toHaveTextContent("выполняется");

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));

    await waitFor(() => expect(toolRow("task_b")).toHaveTextContent("отменено"));
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
  });

  it("коррелирует no-ID события одного вызова и не сталкивает разные вызовы", async () => {
    // Старый Date.now()-fallback давал одинаковый ID событиям в одну мс.
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1" && init?.method === undefined) {
        return success(session());
      }
      if (url.endsWith("/prompt")) {
        return stream([
          { kind: "tool", name: "task_a", status: "running", startedAt: 1000 },
          { kind: "tool", status: "completed", output: "a", endedAt: 2000 },
          { kind: "tool", name: "task_b", status: "running", startedAt: 3000 },
          { kind: "tool", status: "completed", output: "b", endedAt: 4000 },
          { kind: "error", text: "Сбой инструмента" },
        ]);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);
    await sendPrompt();

    await waitFor(() => expect(toolRow("task_b")).toHaveTextContent("готово"));
    expect(toolRow("task_a")).toHaveTextContent("готово");
    expect(screen.getAllByTestId("opencode-tool-call")).toHaveLength(2);
  });

  it("не присваивает no-ID tool события чужому ходу", async () => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    let promptCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") return success(session());
      if (url === "/api/opencode/session/ses-1" && init?.method === undefined) {
        return success(session());
      }
      if (url.endsWith("/prompt")) {
        promptCalls += 1;
        return stream(
          promptCalls === 1
            ? [
                { kind: "tool", name: "task_a", status: "running", startedAt: 1000 },
                { kind: "finalizing" },
              ]
            : [
                { kind: "tool", name: "task_b", status: "running", startedAt: 2000 },
                { kind: "error", text: "Сбой инструмента" },
              ],
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    render(<OpenCodePanel />);
    await sendPrompt("Первый вопрос");
    expect(await screen.findByTestId("opencode-turn-status")).toHaveTextContent(
      "Результат не подтверждён",
    );
    await sendPrompt("Второй вопрос");

    await waitFor(() => expect(toolRow("task_b")).toHaveTextContent("ошибка"));
    expect(toolRow("task_a")).toHaveTextContent("выполняется");
    expect(screen.getAllByTestId("opencode-tool-call")).toHaveLength(2);
  });
});

describe("OpenCode drafts и copy code", () => {
  function storedSession(
    sessionID: string,
    messages: readonly unknown[] = [],
  ): OpenCodeSessionView {
    return { ...session(sessionID), messages: messages as OpenCodeSessionView["messages"] };
  }

  function mockPanel(options: {
    readonly sessionID?: string;
    readonly messages?: readonly unknown[];
    readonly prompt?: () => Response;
    readonly createdID?: string;
  }): void {
    const sessionID = options.sessionID ?? "ses-1";
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && init?.method === "POST") {
        return success(storedSession(options.createdID ?? sessionID));
      }
      if (url === `/api/opencode/session/${sessionID}`) {
        return success(storedSession(sessionID, options.messages ?? []));
      }
      if (url === `/api/opencode/session/${options.createdID ?? sessionID}`) {
        return success(storedSession(options.createdID ?? sessionID, options.messages ?? []));
      }
      if (url.endsWith("/prompt")) return options.prompt?.() ?? stream([{ kind: "done" }]);
      throw new Error(`Unexpected fetch ${url}`);
    });
  }

  async function composer(): Promise<HTMLElement> {
    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    return message;
  }

  it("восстанавливает свой черновик, сохраняет ввод и переживает remount", async () => {
    writeDraft("ses-1", "сохранённый черновик", 1000);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({ sessionID: "ses-1" });

    const first = render(<OpenCodePanel />);
    const message = await composer();

    expect(message).toHaveValue("сохранённый черновик");
    fireEvent.change(message, { target: { value: "изменённый текст" } });
    expect(readDrafts().get("ses-1")).toBe("изменённый текст");

    first.unmount();
    render(<OpenCodePanel />);
    expect(await composer()).toHaveValue("изменённый текст");
  });

  it("новая сессия изолирована и не стирает черновик старой", async () => {
    writeDraft("ses-1", "старый черновик", 1000);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({ sessionID: "ses-1", createdID: "ses-2" });

    render(<OpenCodePanel />);
    const message = await composer();
    expect(message).toHaveValue("старый черновик");

    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-2"),
    );
    await waitFor(() => expect(message).toHaveValue(""));

    expect(readDrafts().get("ses-1")).toBe("старый черновик");
    fireEvent.change(message, { target: { value: "новый черновик" } });
    expect(readDrafts().get("ses-1")).toBe("старый черновик");
    expect(readDrafts().get("ses-2")).toBe("новый черновик");
  });

  it("send очищает только черновик своей сессии после optimistic append", async () => {
    writeDraft("ses-1", "один", 1000);
    writeDraft("ses-2", "два", 2000);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({ sessionID: "ses-1" });

    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(readDrafts().get("ses-1")).toBeUndefined());
    expect(readDrafts().get("ses-2")).toBe("два");
    expect(message).toHaveValue("");
  });

  it("unconfirmed/error до optimistic append оставляет черновик, retry без правок очищает его", async () => {
    class SwitchingReader {
      static calls = 0;
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(): void {
        SwitchingReader.calls += 1;
        const call = SwitchingReader.calls;
        queueMicrotask(() => {
          if (call === 1) this.onerror?.();
          else {
            this.result = "data:text/plain;base64,aGVsbG8=";
            this.onload?.();
          }
        });
      }

      abort(): void {
        this.onabort?.();
      }
    }
    SwitchingReader.calls = 0;
    vi.stubGlobal("FileReader", SwitchingReader);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({ sessionID: "ses-1" });

    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Повтори меня" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByRole("button", { name: "Повторить запрос" })).toBeVisible();
    expect(message).toHaveValue("Повтори меня");
    expect(readDrafts().get("ses-1")).toBe("Повтори меня");

    fireEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));
    await waitFor(() => expect(readDrafts().get("ses-1")).toBeUndefined());
    expect(message).toHaveValue("");
  });

  it("retry не очищает изменённый пользователем composer", async () => {
    class SwitchingReader {
      static calls = 0;
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(): void {
        SwitchingReader.calls += 1;
        const call = SwitchingReader.calls;
        queueMicrotask(() => {
          if (call === 1) this.onerror?.();
          else {
            this.result = "data:text/plain;base64,aGVsbG8=";
            this.onload?.();
          }
        });
      }

      abort(): void {
        this.onabort?.();
      }
    }
    SwitchingReader.calls = 0;
    vi.stubGlobal("FileReader", SwitchingReader);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({ sessionID: "ses-1" });

    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Исходный текст" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByRole("button", { name: "Повторить запрос" })).toBeVisible();
    fireEvent.change(message, { target: { value: "Новый текст" } });
    fireEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(message).toHaveValue("Новый текст");
    expect(readDrafts().get("ses-1")).toBe("Новый текст");
  });

  it("retry не очищает composer, если после ошибки добавлен только trailing newline", async () => {
    FailsOnceFileReader.calls = 0;
    vi.stubGlobal("FileReader", FailsOnceFileReader);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({ sessionID: "ses-1" });

    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();
    fireEvent.change(message, { target: { value: "Исходный текст" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByRole("button", { name: "Повторить запрос" })).toBeVisible();
    // Trim-сравнение считало бы это тем же текстом; точное — изменением.
    fireEvent.change(message, { target: { value: "Исходный текст\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(message).toHaveValue("Исходный текст\n");
    expect(readDrafts().get("ses-1")).toBe("Исходный текст\n");
  });

  it("не сохраняет вложения, base64 и историю сообщений", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({
      sessionID: "ses-1",
      messages: [
        {
          id: "user:message-0",
          role: "user",
          text: "Секретное содержимое истории",
          attachments: [{ name: "notes.txt", mime: "text/plain" }],
        },
        { id: "assistant:message-1", role: "assistant", text: "Ответ истории" },
      ],
    });

    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.change(message, { target: { value: "Посмотри файл" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Выбранные файлы" })).toBeNull());

    const values = Object.keys(window.localStorage).map(
      (key) => window.localStorage.getItem(key) ?? "",
    );
    const stored = values.join("\n");

    expect(stored).not.toContain("aGVsbG8=");
    expect(stored).not.toContain("base64");
    expect(stored).not.toContain("Ответ истории");
    expect(stored).not.toContain("Секретное содержимое истории");

    const raw = JSON.parse(window.localStorage.getItem(OPENCODE_DRAFTS_KEY) ?? "null") as {
      readonly drafts?: Record<string, Record<string, unknown>>;
    } | null;
    for (const entry of Object.values(raw?.drafts ?? {})) {
      expect(Object.keys(entry).sort()).toEqual(["text", "updatedAt"]);
    }
  });

  it("полностью заблокированный localStorage не ломает initialize и composer", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      mockPanel({ sessionID: "ses-1" });
      render(<OpenCodePanel />);

      const message = await composer();
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.change(message, { target: { value: "в памяти" } });
      expect(message).toHaveValue("в памяти");
      fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
      await waitFor(() => expect(message).toHaveValue(""));
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
    }
  });

  it("копирует exact text code block, inline code не получает action и scroll не меняется", async () => {
    const markdown = ["```ts", "const answer = 42;", "```", "", "`inline`"].join("\n");
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({
      sessionID: "ses-1",
      messages: [{ id: "assistant:message-1", role: "assistant", text: markdown }],
    });
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<OpenCodePanel />);
    await composer();
    expect(await screen.findByText("const answer = 42;")).toBeVisible();

    const inline = screen.getByText("inline");
    expect(inline).toHaveProperty("tagName", "CODE");
    expect(within(inline).queryByRole("button")).toBeNull();

    const copy = screen.getByRole("button", { name: "Копировать код" });
    const scroll = panelScroll();
    controlPanelScroll(scroll, { scrollHeight: 1200, clientHeight: 300 });
    readPanelAbove(scroll);
    const jump = jumpButton();
    expect(jump).not.toBeNull();

    fireEvent.click(copy);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Код скопирован" })).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(scroll.scrollTop).toBe(0);
    expect(jumpButton()).not.toBeNull();
  });

  it("показывает доступную ошибку копирования без live-region и без второго action", async () => {
    const markdown = ["```", "a", "```", "", "```", "b", "```", "", "`inline`"].join("\n");
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockPanel({
      sessionID: "ses-1",
      messages: [{ id: "assistant:message-1", role: "assistant", text: markdown }],
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });

    render(<OpenCodePanel />);
    await composer();
    const copies = await screen.findAllByRole("button", { name: "Копировать код" });
    expect(copies).toHaveLength(2);
    expect(screen.getByText("inline").closest("pre")).toBeNull();

    fireEvent.click(copies[0] as HTMLElement);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Не удалось скопировать код" }),
      ).toBeInTheDocument(),
    );
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("OpenCode session history", () => {
  async function composer(): Promise<HTMLElement> {
    const message = await screen.findByRole("textbox", { name: "Сообщение OpenCode" });
    await waitFor(() => expect(message).toBeEnabled());
    return message;
  }

  function historyDetails(): HTMLDetailsElement {
    const details = screen.getByTestId("opencode-session-history");
    if (!(details instanceof HTMLDetailsElement)) throw new Error("history is missing");
    return details;
  }

  function openHistory(): void {
    if (!historyDetails().open) {
      fireEvent.click(within(historyDetails()).getByText("История сессий"));
    }
    expect(historyDetails().open).toBe(true);
  }

  function summary(id: string, title: string | null, updatedAt = 2_000) {
    return { id, title, updatedAt };
  }

  interface ApiMock {
    readonly list?: () => Response | Promise<Response>;
    readonly get?: (sessionID: string) => Response | Promise<Response>;
    readonly create?: () => Response | Promise<Response>;
    readonly rename?: (body: unknown) => Response | Promise<Response>;
    readonly prompt?: (body: Record<string, unknown>) => Promise<Response>;
  }

  function mockApi(options: ApiMock = {}): void {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session") {
        if (method === "POST") return options.create?.() ?? success(session("ses-new"));
        return options.list?.() ?? success([]);
      }
      if (url.endsWith("/prompt")) {
        return (
          options.prompt?.(JSON.parse(String(init?.body)) as Record<string, unknown>) ??
          stream([{ kind: "done" }])
        );
      }
      if (method === "PATCH" && /^\/api\/opencode\/session\/[^/]+$/u.test(url)) {
        return (
          options.rename?.(JSON.parse(String(init?.body))) ??
          success({ id: "ses-1", title: "Новое" })
        );
      }
      const match = /^\/api\/opencode\/session\/([^/]+)$/u.exec(url);
      if (match !== null && method === "GET") {
        const sessionID = decodeURIComponent(match[1] as string);
        return options.get?.(sessionID) ?? success(session(sessionID));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
  }

  it("загружает историю лениво и различает одинаковые заголовки по суффиксу ID", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const list = vi.fn(async () =>
      success([
        summary("ses-1", "Kanbaner chat", 3_000),
        summary("ses-2", "Одинаковая", 2_000),
        summary("ses-3", "Одинаковая", 1_000),
      ]),
    );
    mockApi({ list, get: (sessionID) => success(session(sessionID)) });
    render(<OpenCodePanel />);
    await composer();

    expect(list).not.toHaveBeenCalled();
    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    expect(
      await within(historyDetails()).findByRole("button", { name: /Одинаковая.*ses-2/u }),
    ).toBeVisible();
    expect(
      within(historyDetails()).getByRole("button", { name: /Одинаковая.*ses-3/u }),
    ).toBeVisible();
    expect(
      within(historyDetails()).getByRole("button", { name: /Kanbaner chat/u }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("переключает сессию, сохраняет ID и подхватывает отдельный draft", async () => {
    writeDraft("ses-1", "черновик первой", 1_000);
    writeDraft("ses-2", "черновик второй", 2_000);
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockApi({
      list: () =>
        success([summary("ses-1", "Kanbaner chat", 3_000), summary("ses-2", "Вторая", 2_000)]),
      get: (sessionID) =>
        success({
          ...session(sessionID),
          title: sessionID === "ses-2" ? "Вторая" : "Kanbaner chat",
        }),
    });
    render(<OpenCodePanel />);
    expect(await composer()).toHaveValue("черновик первой");

    openHistory();
    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Вторая/u }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Вторая"),
    );
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-2");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Сообщение OpenCode" })).toHaveValue(
        "черновик второй",
      ),
    );
    expect(readDrafts().get("ses-1")).toBe("черновик первой");
    expect(historyDetails().open).toBe(false);
  });

  it("404 удаляет только запись, 503 сохраняет текущую сессию и повторяется", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let problemCalls = 0;
    const get = vi.fn((sessionID: string) => {
      if (sessionID === "ses-2") return failure(404, "NOT_FOUND");
      if (sessionID === "ses-3") {
        problemCalls += 1;
        return problemCalls === 1
          ? failure(503)
          : success({ ...session("ses-3"), title: "Проблемная" });
      }
      return success(session(sessionID));
    });
    mockApi({
      list: () =>
        success([
          summary("ses-1", "Kanbaner chat", 3_000),
          summary("ses-2", "Удалённая", 2_000),
          summary("ses-3", "Проблемная", 1_000),
        ]),
      get,
    });
    render(<OpenCodePanel />);
    await composer();
    openHistory();

    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Удалённая/u }));
    await waitFor(() => expect(within(historyDetails()).queryByText("Удалённая")).toBeNull());
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");

    fireEvent.click(within(historyDetails()).getByRole("button", { name: /^Проблемная/u }));
    const alert = await within(historyDetails()).findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось открыть сессию");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");

    fireEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Проблемная"),
    );
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-3");
  });

  it("во время prompt-busy записи истории недоступны", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const get = vi.fn((sessionID: string) => success(session(sessionID)));
    mockApi({
      list: () =>
        success([summary("ses-1", "Kanbaner chat", 3_000), summary("ses-2", "Вторая", 2_000)]),
      get,
      prompt: () => new Promise<Response>(() => undefined),
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Долгий вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await screen.findByRole("button", { name: "Остановить OpenCode" });

    openHistory();
    const target = await within(historyDetails()).findByRole("button", { name: /^Вторая/u });
    expect(target).toBeDisabled();
    fireEvent.click(target);
    expect(get).not.toHaveBeenCalledWith("ses-2");
  });

  it("переименовывает exact title, обновляет заголовок, историю и Escape-фокус", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      return success([summary("ses-1", listCalls === 1 ? "Kanbaner chat" : "Новое", 3_000)]);
    });
    const rename = vi.fn((body: unknown) => {
      expect(body).toEqual({ title: "Новое" });
      return success({ id: "ses-1", title: "Новое" });
    });
    mockApi({ list, get: (sessionID) => success(session(sessionID)), rename });
    render(<OpenCodePanel />);
    await composer();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");

    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    expect(input).toHaveValue("Kanbaner chat");
    fireEvent.change(input, { target: { value: "  Новое  " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Новое"),
    );
    expect(screen.queryByRole("textbox", { name: "Название сессии" })).toBeNull();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const reopened = screen.getByRole("textbox", { name: "Название сессии" });
    expect(reopened).toHaveValue("Новое");
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Название сессии" })).toBeNull();
    expect(screen.getByRole("button", { name: "Переименовать сессию" })).toHaveFocus();
  });

  it("newChat сбрасывает stale-кэш истории и показывает новую сессию", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      return success(
        listCalls === 1
          ? [summary("ses-1", "Kanbaner chat", 3_000)]
          : [summary("ses-new", "Свежая", 4_000), summary("ses-1", "Kanbaner chat", 3_000)],
      );
    });
    mockApi({
      list,
      get: (sessionID) => success(session(sessionID)),
      create: () => success({ ...session("ses-new"), title: "Свежая" }),
    });
    render(<OpenCodePanel />);
    await composer();

    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    fireEvent.click(within(historyDetails()).getByText("История сессий"));
    expect(historyDetails().open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new"),
    );
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Свежая");

    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await within(historyDetails()).findByText("Свежая")).toBeVisible();
    expect(within(historyDetails()).getByText(/es-new/u)).toBeVisible();
  });

  it("rename success и 503 сохраняют unconfirmed turn и ручную проверку", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let renameCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "POST") return success(session("ses-1"));
      if (url === "/api/opencode/session") {
        return success([summary("ses-1", "Kanbaner chat")]);
      }
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) {
        return success({ session: session("ses-1"), outcome: "pending" });
      }
      if (url.endsWith("/prompt")) return stream([{ kind: "finalizing" }]);
      if (url === "/api/opencode/session/ses-1" && method === "PATCH") {
        renameCalls += 1;
        return renameCalls === 1 ? success({ id: "ses-1", title: "Новое" }) : failure(503);
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return success(session("ses-1"));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    let input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "Новое" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Новое"),
    );
    expect(renameCalls).toBe(1);
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(screen.getByRole("button", { name: "Проверить статус" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "Сломанное" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("Временно недоступно");
    expect(renameCalls).toBe(2);
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Новое");
    expect(status).toHaveTextContent("Результат не подтверждён");

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Результат пока не подтверждён"));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
  });

  it("switch 404 и 503 сохраняют unconfirmed turn и ручную проверку", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "POST") return success(session("ses-1"));
      if (url === "/api/opencode/session") {
        return success([
          summary("ses-1", "Kanbaner chat", 3_000),
          summary("ses-2", "Удалённая", 2_000),
          summary("ses-3", "Проблемная", 1_000),
        ]);
      }
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) {
        return success({ session: session("ses-1"), outcome: "pending" });
      }
      if (url === "/api/opencode/session/ses-2" && method === "GET")
        return failure(404, "NOT_FOUND");
      if (url === "/api/opencode/session/ses-3" && method === "GET") return failure(503);
      if (url.endsWith("/prompt")) return stream([{ kind: "finalizing" }]);
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return success(session("ses-1"));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");

    openHistory();
    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Удалённая/u }));
    await waitFor(() => expect(within(historyDetails()).queryByText("Удалённая")).toBeNull());
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");

    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Проблемная/u }));
    expect(await within(historyDetails()).findByRole("alert")).toHaveTextContent(
      "Не удалось открыть сессию",
    );
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Результат пока не подтверждён"));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
  });

  it("failed switch не отменяет delayed canonical refresh после done", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let getCalls = 0;
    const refreshGate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(
          success([summary("ses-1", "Kanbaner chat", 3_000), summary("ses-2", "Удалённая", 2_000)]),
        );
      }
      if (url === "/api/opencode/session/ses-2" && method === "GET") {
        return Promise.resolve(failure(404, "NOT_FOUND"));
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "done" }]));
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(success(session("ses-1")));
        return new Promise<Response>((resolve) => {
          refreshGate.release = resolve;
        });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    expect(refreshGate.release).not.toBeNull();

    openHistory();
    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Удалённая/u }));
    await waitFor(() => expect(within(historyDetails()).queryByText("Удалённая")).toBeNull());
    expect(status).toHaveTextContent("Готово");
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");

    refreshGate.release?.(
      success({
        ...session("ses-1"),
        messages: [{ id: "assistant:canonical", role: "assistant", text: "Канонический ответ" }],
      }),
    );
    expect(await screen.findByText("Канонический ответ")).toBeVisible();
    expect(status).toHaveTextContent("Готово");
  });

  it("delayed canonical refresh после rename не возвращает старый title", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let getCalls = 0;
    const refreshGate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat", 3_000)]));
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "done" }]));
      if (url === "/api/opencode/session/ses-1" && method === "PATCH") {
        return Promise.resolve(success({ id: "ses-1", title: "Новое" }));
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(success(session("ses-1")));
        return new Promise<Response>((resolve) => {
          refreshGate.release = resolve;
        });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(refreshGate.release).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "Новое" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Новое"),
    );

    refreshGate.release?.(
      success({
        ...session("ses-1"),
        title: "Kanbaner chat",
        messages: [{ id: "assistant:canonical", role: "assistant", text: "Канонический ответ" }],
      }),
    );
    expect(await screen.findByText("Канонический ответ")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Новое");
  });

  it("successful switch отменяет старый generation и загружает target messages", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let getCalls = 0;
    const staleGate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(
          success([summary("ses-1", "Kanbaner chat", 3_000), summary("ses-2", "Вторая", 2_000)]),
        );
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "done" }]));
      if (url === "/api/opencode/session/ses-2" && method === "GET") {
        return Promise.resolve(
          success({
            ...session("ses-2"),
            title: "Вторая",
            messages: [{ id: "assistant:target", role: "assistant", text: "Целевое сообщение" }],
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(success(session("ses-1")));
        return new Promise<Response>((resolve) => {
          staleGate.release = resolve;
        });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(staleGate.release).not.toBeNull();

    openHistory();
    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Вторая/u }));
    expect(await screen.findByText("Целевое сообщение")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Вторая");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-2");

    staleGate.release?.(
      success({
        ...session("ses-1"),
        messages: [{ id: "assistant:stale", role: "assistant", text: "Старое каноническое" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Старое каноническое")).toBeNull();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Вторая");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-2");
  });

  it("rename 404 очищает только ID, фокусирует CTA и не создаёт сессию", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let creates = 0;
    mockApi({
      get: (sessionID) => success(session(sessionID)),
      create: () => {
        creates += 1;
        return success({ ...session("ses-new"), title: "Свежая" });
      },
      rename: () => failure(404, "NOT_FOUND"),
    });
    render(<OpenCodePanel />);
    await composer();

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "Новое" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByText("Сохранённая сессия не найдена.")).toBeVisible();
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBeNull();
    const cta = screen.getByRole("button", { name: "Новая сессия" });
    await waitFor(() => expect(cta).toHaveFocus());
    expect(screen.queryByRole("textbox", { name: "Название сессии" })).toBeNull();
    expect(creates).toBe(0);
  });

  it("rename 503 сохраняет сессию, заголовок и открытую форму", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    mockApi({
      get: (sessionID) => success(session(sessionID)),
      rename: () => failure(503),
    });
    render(<OpenCodePanel />);
    await composer();

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "Новое" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByRole("alert")).toHaveTextContent("Временно недоступно");
    expect(screen.getByRole("textbox", { name: "Название сессии" })).toHaveValue("Новое");
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");
  });

  it("принимает 100 emoji и отклоняет 101 без PATCH", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const bodies: unknown[] = [];
    mockApi({
      get: (sessionID) => success(session(sessionID)),
      rename: (body) => {
        bodies.push(body);
        return success({ id: "ses-1", title: (body as { title: string }).title });
      },
    });
    render(<OpenCodePanel />);
    await composer();

    const hundred = "😀".repeat(100);
    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    let input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: hundred } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent(hundred),
    );
    expect(bodies).toEqual([{ title: hundred }]);

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: `${hundred}😀` } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Название сессии должно содержать от 1 до 100 символов",
    );
    expect(bodies).toHaveLength(1);
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent(hundred);
  });

  it("pre-rename delayed refresh применяет X один раз, следующий GET доверяет Y", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let getCalls = 0;
    const refreshGate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(
          success([summary("ses-1", "Kanbaner chat", 3_000), summary("ses-2", "Вторая", 2_000)]),
        );
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "done" }]));
      if (url === "/api/opencode/session/ses-1" && method === "PATCH") {
        return Promise.resolve(success({ id: "ses-1", title: "X" }));
      }
      if (url === "/api/opencode/session/ses-2" && method === "GET") {
        return Promise.resolve(success({ ...session("ses-2"), title: "Вторая" }));
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(success(session("ses-1")));
        if (getCalls === 2) {
          return new Promise<Response>((resolve) => {
            refreshGate.release = resolve;
          });
        }
        return Promise.resolve(
          success({
            ...session("ses-1"),
            title: "Y",
            messages: [{ id: "assistant:y", role: "assistant", text: "Свежий Y" }],
          }),
        );
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(refreshGate.release).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "X" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("X"),
    );

    // GET уже летел на момент rename: применяются canonical messages и X.
    refreshGate.release?.(
      success({
        ...session("ses-1"),
        title: "Kanbaner chat",
        messages: [{ id: "assistant:canonical", role: "assistant", text: "Каноническое" }],
      }),
    );
    expect(await screen.findByText("Каноническое")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("X");

    // Следующий GET начат после rename: overlay уже погашен, доверяем Y.
    openHistory();
    fireEvent.click(await within(historyDetails()).findByRole("button", { name: /^Вторая/u }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Вторая"),
    );
    openHistory();
    fireEvent.click(
      await within(historyDetails()).findByRole("button", { name: /^Kanbaner chat/u }),
    );
    expect(await screen.findByText("Свежий Y")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Y");
  });

  it("fresh canonical GET сразу после rename доверяет Y без delayed refresh", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat")]));
      }
      if (url.endsWith("/prompt")) return Promise.resolve(stream([{ kind: "finalizing" }]));
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) {
        return Promise.resolve(
          success({
            session: {
              ...session("ses-1"),
              title: "Y",
              messages: [{ id: "assistant:y", role: "assistant", text: "Ответ Y" }],
            },
            outcome: "done",
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "PATCH") {
        return Promise.resolve(success({ id: "ses-1", title: "X" }));
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Результат не подтверждён",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    fireEvent.change(input, { target: { value: "X" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("X"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(await screen.findByText("Ответ Y")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Y");
  });

  it("применяет только последний switch и игнорирует stale target", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const gate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(
          success([
            summary("ses-1", "Kanbaner chat", 3_000),
            summary("ses-2", "Вторая", 2_000),
            summary("ses-3", "Третья", 1_000),
          ]),
        );
      }
      if (url === "/api/opencode/session/ses-2" && method === "GET") {
        return new Promise<Response>((resolve) => {
          gate.release = resolve;
        });
      }
      if (url === "/api/opencode/session/ses-3" && method === "GET") {
        return Promise.resolve(
          success({
            ...session("ses-3"),
            title: "Третья",
            messages: [{ id: "assistant:target3", role: "assistant", text: "Цель третья" }],
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    await composer();
    openHistory();
    const first = await within(historyDetails()).findByRole("button", { name: /^Вторая/u });
    const second = within(historyDetails()).getByRole("button", { name: /^Третья/u });
    act(() => {
      first.click();
      second.click();
    });

    expect(await screen.findByText("Цель третья")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Третья");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-3");

    if (gate.release === null) throw new Error("stale switch не был запущен");
    gate.release(
      success({
        ...session("ses-2"),
        title: "Вторая",
        messages: [{ id: "assistant:target2", role: "assistant", text: "Старая цель" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Старая цель")).toBeNull();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Третья");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-3");
  });

  it("newChat инвалидирует pending switch", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const gate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success({ ...session("ses-new"), title: "Свежая" }));
      }
      if (url === "/api/opencode/session") {
        return Promise.resolve(
          success([summary("ses-1", "Kanbaner chat", 3_000), summary("ses-2", "Вторая", 2_000)]),
        );
      }
      if (url === "/api/opencode/session/ses-2" && method === "GET") {
        return new Promise<Response>((resolve) => {
          gate.release = resolve;
        });
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    await composer();
    openHistory();
    const target = await within(historyDetails()).findByRole("button", { name: /^Вторая/u });
    act(() => {
      target.click();
      screen.getByRole("button", { name: "Новая сессия OpenCode" }).click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Свежая"),
    );
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new");

    if (gate.release === null) throw new Error("pending switch не был запущен");
    gate.release(
      success({
        ...session("ses-2"),
        title: "Вторая",
        messages: [{ id: "assistant:target2", role: "assistant", text: "Старая цель" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Старая цель")).toBeNull();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Свежая");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new");
  });

  it("model switch сохраняет unconfirmed turn, а failed switch не меняет модель", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let modelCalls = 0;
    const statusChecks = vi.fn(() => success({ session: session("ses-1"), outcome: "pending" }));
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "POST") return success(session("ses-1"));
      if (url === "/api/opencode/session/ses-1" && method === "GET")
        return success(session("ses-1"));
      if (url === "/api/opencode/session/ses-1/prompt") return stream([{ kind: "finalizing" }]);
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) return statusChecks();
      if (url === "/api/opencode/session/ses-1/model" && method === "POST") {
        modelCalls += 1;
        return modelCalls === 1 ? success({ switched: true }) : failure(503);
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");

    expandModelControls();
    const provider = screen.getByRole("combobox", { name: "Провайдер OpenCode" });
    await waitFor(() => expect(provider).toBeEnabled());
    fireEvent.change(provider, { target: { value: "provider-2" } });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-2"),
    );
    expect(status).toHaveTextContent("Результат не подтверждён");

    // Вторая смена падает: применяется только успешный switch, generation и
    // unconfirmed turn не сбрасываются.
    fireEvent.change(screen.getByRole("combobox", { name: "Провайдер OpenCode" }), {
      target: { value: "provider-1" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Временно недоступно");
    expect(modelCalls).toBe(2);
    expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-2");
    expect(status).toHaveTextContent("Результат не подтверждён");

    const check = screen.getByRole("button", { name: "Проверить статус" });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);
    await waitFor(() => expect(status).toHaveTextContent("Результат пока не подтверждён"));
    expect(statusChecks).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
  });

  it("failed newChat сохраняет turn, draft, файл и контекст, а успешный их очищает", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let creates = 0;
    const statusChecks = vi.fn(() => success({ session: session("ses-1"), outcome: "pending" }));
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "POST") {
        creates += 1;
        return creates === 1 ? failure(503) : success({ ...session("ses-new"), title: "Свежая" });
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET")
        return success(session("ses-1"));
      if (url === "/api/opencode/session/ses-1/prompt") return stream([{ kind: "finalizing" }]);
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) return statusChecks();
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel search="?note=note-1" />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");

    fireEvent.change(await composer(), { target: { value: "Не потерять черновик" } });
    expect(readDrafts().get("ses-1")).toBe("Не потерять черновик");
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить контекст" }));
    expect(screen.getByRole("button", { name: "Убрать контекст" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(screen.getByLabelText("Файлы для OpenCode"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("notes.txt")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Временно недоступно");
    expect(creates).toBe(1);
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-1");
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");
    expect(screen.getByRole("textbox", { name: "Сообщение OpenCode" })).toHaveValue(
      "Не потерять черновик",
    );
    expect(readDrafts().get("ses-1")).toBe("Не потерять черновик");
    expect(status).toHaveTextContent("Результат не подтверждён");
    expect(pendingFilesList()).toHaveTextContent("notes.txt");
    expect(screen.getByRole("button", { name: "Убрать контекст" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const check = screen.getByRole("button", { name: "Проверить статус" });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);
    await waitFor(() => expect(status).toHaveTextContent("Результат пока не подтверждён"));
    expect(statusChecks).toHaveBeenCalledOnce();

    // Успешный create начинает новую generation и очищает вложения/контекст.
    fireEvent.click(screen.getByRole("button", { name: "Новая сессия OpenCode" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Свежая"),
    );
    expect(creates).toBe(2);
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new");
    expect(pendingFilesList()).toBeNull();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.getByRole("button", { name: "Прикрепить контекст" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("model switch не откатывается delayed refresh, а свежий GET применяет canonical", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let getCalls = 0;
    const refreshGate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        return Promise.resolve(success(session("ses-1")));
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        return Promise.resolve(stream([{ kind: "done" }]));
      }
      if (url === "/api/opencode/session/ses-1/model" && method === "POST") {
        return Promise.resolve(success({ switched: true }));
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(success(session("ses-1")));
        if (getCalls === 2) {
          return new Promise<Response>((resolve) => {
            refreshGate.release = resolve;
          });
        }
        return Promise.resolve(
          success({
            ...session("ses-1"),
            model: { id: "model-3", providerID: "provider-3", variant: "high" },
            messages: [{ id: "assistant:fresh", role: "assistant", text: "Свежий ответ" }],
          }),
        );
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    if (refreshGate.release === null) throw new Error("canonical refresh не был запущен");

    expandModelControls();
    const provider = screen.getByRole("combobox", { name: "Провайдер OpenCode" });
    await waitFor(() => expect(provider).toBeEnabled());
    fireEvent.change(provider, { target: { value: "provider-2" } });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-2"),
    );

    // Delayed refresh стартовал до switch и возвращает старую model-1: messages
    // применяются, но подтверждённая model-2 не откатывается.
    refreshGate.release(
      success({
        ...session("ses-1"),
        model: { id: "model-1", providerID: "provider-1", variant: "high" },
        messages: [{ id: "assistant:canonical", role: "assistant", text: "Канонический ответ" }],
      }),
    );
    expect(await screen.findByText("Канонический ответ")).toBeVisible();
    expect(status).toHaveTextContent("Готово");
    expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-2");

    // Следующий GET начат после switch и принимает более новую canonical model.
    fireEvent.change(message, { target: { value: "Второй вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(await screen.findByText("Свежий ответ")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-3");
  });

  it("newChat применяет только последний create и игнорирует stale response", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const gate: { release: ((response: Response) => void) | null } = { release: null };
    let creates = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "POST") {
        creates += 1;
        if (creates === 1) {
          return new Promise<Response>((resolve) => {
            gate.release = resolve;
          });
        }
        return Promise.resolve(success({ ...session("ses-new-2"), title: "Вторая новая" }));
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    await composer();

    const newChatButton = screen.getByRole("button", { name: "Новая сессия OpenCode" });
    act(() => {
      newChatButton.click();
      newChatButton.click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Вторая новая"),
    );
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new-2");
    expect(creates).toBe(2);

    if (gate.release === null) throw new Error("stale create не был запущен");
    gate.release(success({ ...session("ses-new-1"), title: "Первая новая" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Первая новая")).toBeNull();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Вторая новая");
    expect(window.localStorage.getItem("kanbaner.opencode.sessionId")).toBe("ses-new-2");
  });

  it("ручной terminal outcome инвалидирует кэш истории и обновляет порядок", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      return success(
        listCalls === 1
          ? [summary("ses-1", "Kanbaner chat", 2_000)]
          : [summary("ses-2", "Свежая", 5_000), summary("ses-1", "Kanbaner chat", 3_000)],
      );
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "GET") return list();
      if (url === "/api/opencode/session/ses-1" && method === "GET")
        return success(session("ses-1"));
      if (url === "/api/opencode/session/ses-1/prompt") return stream([{ kind: "finalizing" }]);
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) {
        return success({ session: session("ses-1"), outcome: "done" });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Вопрос" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    const status = await screen.findByTestId("opencode-turn-status");
    expect(status).toHaveTextContent("Результат не подтверждён");

    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        within(within(historyDetails()).getByRole("list", { name: "История сессий" })).getAllByRole(
          "button",
        ),
      ).toHaveLength(1),
    );

    // EOF-unconfirmed сам по себе не обновлял историю; ручной done обязан
    // сбросить 30-секундный кэш и запросить новый порядок/updatedAt.
    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() => expect(status).toHaveTextContent("Готово"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    const items = within(
      within(historyDetails()).getByRole("list", { name: "История сессий" }),
    ).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Свежая");
    expect(items[0]).toHaveTextContent(formatSessionUpdatedAt(5_000));
    expect(items[1]).toHaveTextContent("Kanbaner chat");
    expect(items[1]).toHaveTextContent(formatSessionUpdatedAt(3_000));
  });

  it("отправляет titleText без контекста и применяет auto title до terminal", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    const promptBodies: Array<Record<string, unknown>> = [];
    const streamGate: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
      controller: null,
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamGate.controller = controller;
      },
    });
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      return success([
        summary("ses-1", listCalls === 1 ? "Kanbaner chat" : "Разобрать логи", 3_000),
        summary("ses-2", "Вторая", 2_000),
      ]);
    });
    let getCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "GET") return list();
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        return success(
          getCalls === 1 ? session("ses-1") : { ...session("ses-1"), title: "Разобрать логи" },
        );
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        promptBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(body, {
          headers: {
            "content-type": "application/x-ndjson",
            "x-kanbaner-session-title": encodeURIComponent("Разобрать логи"),
          },
        });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel search="?note=note-1" />);
    const message = await composer();
    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Прикрепить контекст" }));
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(promptBodies).toHaveLength(1));
    expect(promptBodies[0]).toMatchObject({
      text: "Контекст: kanbaner.notes:note:note-1\n\nРазобрать логи",
      titleText: "Разобрать логи",
    });
    // Header применяется до первого terminal-события, пока stream ещё открыт.
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Разобрать логи"),
    );
    expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Подключаемся");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(within(historyDetails()).getByText(/Разобрать логи/u)).toBeVisible();

    streamGate.controller?.enqueue(
      new TextEncoder().encode(`${JSON.stringify({ kind: "done" })}\n`),
    );
    streamGate.controller?.close();
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Разобрать логи");
  });

  it("grace первого canonical GET сохраняет auto title, применяет messages и гасит overlay", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let getCalls = 0;
    const refreshGate: { release: ((response: Response) => void) | null } = { release: null };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "GET") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat", 3_000)]));
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        return Promise.resolve(
          stream([{ kind: "done" }], {
            "x-kanbaner-session-title": encodeURIComponent("Логи"),
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(success(session("ses-1")));
        if (getCalls === 2) {
          return new Promise<Response>((resolve) => {
            refreshGate.release = resolve;
          });
        }
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(refreshGate.release).not.toBeNull();

    // Grace — это не «GET начался до header»: единственный done-refresh уже
    // стартовал после header, но мог быть собран до server-side update.
    // Поэтому первый canonical GET применяет messages, сохраняет auto title
    // и гасит overlay; следующий GET уже доверяет canonical.
    refreshGate.release?.(
      success({
        ...session("ses-1"),
        title: "Kanbaner chat",
        messages: [{ id: "assistant:canonical", role: "assistant", text: "Канонические данные" }],
      }),
    );
    expect(await screen.findByText("Канонические данные")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи");
  });

  it("после grace следующий canonical GET принимает серверный title без смены generation", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let checkCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "GET") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat", 3_000)]));
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        return Promise.resolve(
          stream([{ kind: "finalizing" }], {
            "x-kanbaner-session-title": encodeURIComponent("Логи"),
          }),
        );
      }
      if (url.startsWith("/api/opencode/session/ses-1?turnID=")) {
        checkCalls += 1;
        // Pending GET не применяет canonical, но расходует grace.
        if (checkCalls === 1) {
          return Promise.resolve(success({ session: session("ses-1"), outcome: "pending" }));
        }
        return Promise.resolve(
          success({
            session: {
              ...session("ses-1"),
              title: "Серверное",
              messages: [{ id: "assistant:fresh", role: "assistant", text: "Свежие данные" }],
            },
            outcome: "done",
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Результат не подтверждён",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Результат пока не подтверждён",
      ),
    );
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи");

    fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
    expect(await screen.findByText("Свежие данные")).toBeVisible();
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Серверное");
    expect(checkCalls).toBe(2);
  });

  it("auto header применяется при cancelled и не меняет outcome", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let promptCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "GET") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat", 3_000)]));
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        promptCalls += 1;
        return Promise.resolve(
          stream([{ kind: "cancelled", text: "Запрос остановлен" }], {
            "x-kanbaner-session-title": encodeURIComponent("Логи"),
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Остановлено"),
    );
    expect(promptCalls).toBe(1);
  });

  it("auto header применяется при unconfirmed и не меняет outcome", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let promptCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "GET") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat", 3_000)]));
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        promptCalls += 1;
        return Promise.resolve(
          stream([{ kind: "finalizing" }], {
            "x-kanbaner-session-title": encodeURIComponent("Логи"),
          }),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent(
        "Результат не подтверждён",
      ),
    );
    expect(screen.getByRole("button", { name: "Проверить статус" })).toBeVisible();
    expect(promptCalls).toBe(1);
  });

  it("auto header применяется при NDJSON nonAdmission и не меняет outcome", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let promptCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return Promise.resolve(success(catalog));
      if (url === "/api/opencode/session" && method === "GET") {
        return Promise.resolve(success([summary("ses-1", "Kanbaner chat", 3_000)]));
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        promptCalls += 1;
        return Promise.resolve(
          stream(
            [
              {
                kind: "error",
                text: "Prompt не принят",
                nonAdmission: true,
                retryable: true,
              },
            ],
            { "x-kanbaner-session-title": encodeURIComponent("Логи") },
          ),
        );
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return Promise.resolve(success(session("ses-1")));
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Ошибка запроса"),
    );
    expect(screen.getByRole("button", { name: "Повторить запрос" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Проверить статус" })).toBeNull();
    expect(promptCalls).toBe(1);
  });

  it("ручной rename после auto title остаётся и попадает в историю", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      const title = listCalls === 1 ? "Kanbaner chat" : listCalls === 2 ? "Логи" : "Новое";
      return success([summary("ses-1", title, 3_000)]);
    });
    const rename = vi.fn((body: unknown) => {
      expect(body).toEqual({ title: "Новое" });
      return success({ id: "ses-1", title: "Новое" });
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "GET") return list();
      if (url === "/api/opencode/session/ses-1/prompt") {
        return stream([{ kind: "done" }], {
          "x-kanbaner-session-title": encodeURIComponent("Логи"),
        });
      }
      if (url === "/api/opencode/session/ses-1" && method === "PATCH") {
        return rename(JSON.parse(String(init?.body)));
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        return success({ ...session("ses-1"), title: "Логи" });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    openHistory();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    fireEvent.change(message, { target: { value: "Логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Переименовать сессию" }));
    const input = screen.getByRole("textbox", { name: "Название сессии" });
    expect(input).toHaveValue("Логи");
    fireEvent.change(input, { target: { value: "Новое" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Новое"),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(within(historyDetails()).getByText("Новое")).toBeVisible();
  });

  it("ошибка до admission не применяет auto header, retry применяет его один раз", async () => {
    window.localStorage.setItem("kanbaner.opencode.sessionId", "ses-1");
    let promptCalls = 0;
    let getCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/opencode/catalog") return success(catalog);
      if (url === "/api/opencode/session" && method === "GET") {
        return success([summary("ses-1", "Kanbaner chat")]);
      }
      if (url === "/api/opencode/session/ses-1/prompt") {
        promptCalls += 1;
        if (promptCalls === 1) {
          return Response.json(
            {
              ok: false,
              error: { code: "DEPENDENCY_UNAVAILABLE", message: "Временно недоступно" },
            },
            {
              status: 503,
              headers: { "x-kanbaner-session-title": encodeURIComponent("Логи") },
            },
          );
        }
        return stream([{ kind: "done" }], {
          "x-kanbaner-session-title": encodeURIComponent("Логи"),
        });
      }
      if (url === "/api/opencode/session/ses-1" && method === "GET") {
        getCalls += 1;
        return success(getCalls === 1 ? session("ses-1") : { ...session("ses-1"), title: "Логи" });
      }
      throw new Error(`Unexpected fetch ${method} ${url}`);
    });
    render(<OpenCodePanel />);
    const message = await composer();
    fireEvent.change(message, { target: { value: "Разобрать логи" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Ошибка запроса"),
    );
    expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Kanbaner chat");

    fireEvent.click(screen.getByRole("button", { name: "Повторить запрос" }));
    await waitFor(() => expect(promptCalls).toBe(2));
    await waitFor(() =>
      expect(screen.getByTestId("opencode-session-title")).toHaveTextContent("Логи"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("opencode-turn-status")).toHaveTextContent("Готово"),
    );
    expect(promptCalls).toBe(2);
  });
});
