import { expect, test, type Page } from "@playwright/test";
import { OPENCODE_CATALOG_TOOLS } from "@kanbaner/opencode";

const catalog = {
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
      variants: ["high"],
    },
    { id: "model-2", providerID: "provider-2", name: "Model Two", type: "chat", variants: ["max"] },
  ],
  agents: [{ id: "kanbaner", name: "Kanbaner", description: null }],
  tools: OPENCODE_CATALOG_TOOLS,
  defaultModel: { id: "model-1", providerID: "provider-1", variant: "high" },
};

// Реальный PNG 320×200: проверяет decode, object URL и ограничение размеров.
const PREVIEW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAABvUlEQVR42u3TQQkAAAgEwYtjRCMayxC+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMXCx596SSjynHNgAAAABJRU5ErkJggg==",
  "base64",
);

async function mockOpenCode(
  page: Page,
  promptEvents?: (call: number) => readonly unknown[],
  historyMessages?: readonly unknown[],
  options?: {
    readonly sessionDelayMs?: number;
    readonly promptDelayMs?: number;
    readonly previewDelayMs?: number;
    /** Явный gate: preview-запрос ждёт сигнала теста, чтобы проверить load при чтении выше. */
    readonly previewGate?: Promise<void>;
    /** Сообщения, которые вернёт POST при создании первой сессии. */
    readonly initialMessages?: readonly unknown[];
    /** История для конкретного GET; нужна, чтобы отличить initial load и canonical refresh. */
    readonly sessionHistory?: (call: number) => readonly unknown[] | undefined;
    readonly statusOutcome?:
      | "done"
      | "error"
      | "cancelled"
      | "pending"
      | "missing"
      | ((turnID: string) => "done" | "error" | "cancelled" | "pending" | "missing");
  },
) {
  const state = {
    catalogCalls: 0,
    createdSessions: 0,
    modelInputs: [] as unknown[],
    previewPaths: [] as string[],
    previewHeaders: [] as Array<Record<string, string>>,
    sessionBodies: [] as unknown[],
    sessionGetCalls: 0,
    statusQueries: [] as string[],
    promptBodies: [] as Array<{
      text?: string;
      turnID?: string;
      files?: Array<{ name: string; mime: string; base64: string }>;
    }>,
  };

  await page.route("**/api/opencode/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data }),
      });

    if (path === "/api/opencode/catalog") {
      state.catalogCalls += 1;
      await json(catalog);
      return;
    }
    if (path === "/api/opencode/session" && method === "POST") {
      state.createdSessions += 1;
      await json({
        id: `ses-${state.createdSessions}`,
        title: "Kanbaner chat",
        agent: "kanbaner",
        model: catalog.defaultModel,
        messages: state.createdSessions === 1 ? (options?.initialMessages ?? []) : [],
      });
      return;
    }
    if (path.endsWith("/model") && method === "POST") {
      state.modelInputs.push(request.postDataJSON());
      await json({ switched: true });
      return;
    }
    if (path.endsWith("/prompt") && method === "POST") {
      state.promptBodies.push(
        request.postDataJSON() as {
          text?: string;
          turnID?: string;
          files?: Array<{ name: string; mime: string; base64: string }>;
        },
      );
      // Задержка ответа даёт тесту уйти читать выше до прихода streaming-событий.
      if (options?.promptDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.promptDelayMs));
      }
      const events = promptEvents?.(state.promptBodies.length) ?? [
        {
          kind: "tool",
          id: "message-1:call-1",
          name: "task_update",
          status: "running",
          text: "",
          input: '{"id":"task-1"}',
          startedAt: 1000,
        },
        {
          kind: "tool",
          id: "message-1:call-1",
          status: "completed",
          text: "Обновлено",
          output: "Обновлено",
          endedAt: 3600,
        },
        { kind: "delta", id: "message-1:0", text: "Ответ " },
        { kind: "text", id: "message-1:0", text: "Ответ OpenCode" },
        { kind: "finalizing" },
        { kind: "done" },
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      });
      return;
    }
    if (
      /^\/api\/opencode\/session\/ses-\d+\/messages\/[^/]+\/attachments\/\d+$/u.test(path) &&
      method === "GET"
    ) {
      state.previewPaths.push(path);
      state.previewHeaders.push(request.headers());
      // Отложенная загрузка image проверяет capture load при чтении выше.
      if (options?.previewGate !== undefined) {
        await options.previewGate;
      } else if (options?.previewDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.previewDelayMs));
      }
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: PREVIEW_PNG,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
      return;
    }
    if (/^\/api\/opencode\/session\/ses-\d+$/u.test(path) && method === "GET") {
      state.sessionGetCalls += 1;
      // Задержка только для canonical refresh после prompt: даёт проверить
      // optimistic-состояние до замены сообщений ответом сервера.
      if (state.promptBodies.length > 0 && options?.sessionDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
      }
      const sessionMessages = options?.sessionHistory?.(state.sessionGetCalls) ??
        historyMessages ?? [
          { id: "user:message-0", role: "user", text: "Проверка" },
          {
            id: "tool:message-1:call-1",
            role: "tool",
            name: "task_update",
            status: "completed",
            text: "Обновлено",
            input: '{"id":"task-1"}',
            output: "Обновлено",
            startedAt: 1000,
            endedAt: 3600,
          },
          { id: "assistant:message-1:0", role: "assistant", text: "Ответ OpenCode" },
        ];
      const body = {
        id: path.split("/").at(-1),
        title: "Kanbaner chat",
        agent: "kanbaner",
        model: catalog.defaultModel,
        messages: sessionMessages,
      };
      state.sessionBodies.push(body);
      const turnID = url.searchParams.get("turnID");
      if (turnID !== null) {
        state.statusQueries.push(turnID);
        const configured = options?.statusOutcome ?? "pending";
        const outcome = typeof configured === "function" ? configured(turnID) : configured;
        await json({ session: body, outcome });
        return;
      }
      await json(body);
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "NOT_FOUND", message: "Не найдено", retryable: false },
      }),
    });
  });

  return state;
}

interface ChatScrollMetrics {
  readonly top: number;
  readonly max: number;
  readonly bottomGap: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

async function chatScrollMetrics(page: Page): Promise<ChatScrollMetrics> {
  return page.getByTestId("opencode-messages").evaluate((element) => ({
    top: element.scrollTop,
    max: Math.max(0, element.scrollHeight - element.clientHeight),
    bottomGap: Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight),
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
}

/** Детерминированно уводит чтение выше без wheel-событий и авто-scroll Playwright. */
async function readChatAbove(page: Page): Promise<void> {
  await page.getByTestId("opencode-messages").evaluate((element) => {
    element.scrollTop = 0;
  });
}

/** Середина истории: пользователь читает не начало и не конец. */
async function readChatMiddle(page: Page): Promise<void> {
  await page.getByTestId("opencode-messages").evaluate((element) => {
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.round(max / 2);
  });
}

interface ChatAnchor {
  readonly index: number;
  readonly top: number;
  readonly text: string;
}

/** Первое сообщение, пересекающее верхнюю границу viewport контейнера. */
async function chatAnchor(page: Page): Promise<ChatAnchor> {
  return page.getByTestId("opencode-messages").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const articles = Array.from(element.querySelectorAll("article"));
    const index = articles.findIndex(
      (article) => article.getBoundingClientRect().bottom > box.top + 8,
    );
    const anchor = articles[index];
    if (anchor === undefined) throw new Error("visible anchor is missing");
    return {
      index,
      top: anchor.getBoundingClientRect().top,
      text: (anchor.textContent ?? "").slice(0, 40),
    };
  });
}

async function chatAnchorTop(page: Page, anchor: ChatAnchor): Promise<number> {
  return page.getByTestId("opencode-messages").evaluate((element, index) => {
    const target = Array.from(element.querySelectorAll("article"))[index];
    if (target === undefined) throw new Error("anchor disappeared");
    return target.getBoundingClientRect().top;
  }, anchor.index);
}

test("desktop: чтение в середине истории сохраняет видимый anchor при росте раннего сообщения", async ({
  page,
}) => {
  const history = Array.from({ length: 30 }, (_value, index) => ({
    id: `assistant:history-${index}`,
    role: "assistant" as const,
    text: `Середина ${index}. ${"Подробный текст шага. ".repeat(6)}`,
  }));
  // Canonical refresh увеличивает высоту сообщения ВЫШЕ видимого фрагмента:
  // native scroll anchoring должен удержать чтение, а не числовой scrollTop.
  const canonical = [
    ...history.map((message, index) =>
      index === 2
        ? {
            ...message,
            text: `${message.text} ${"Дополнительный ранний текст. ".repeat(40)}`,
          }
        : message,
    ),
    { id: "assistant:mid-answer", role: "assistant" as const, text: "Ответ в середине" },
  ];
  const mock = await mockOpenCode(
    page,
    () => [
      { kind: "delta", id: "message-1:0", text: "Потоковый " },
      { kind: "text", id: "message-1:0", text: "Потоковый ответ середины" },
      { kind: "finalizing" },
      { kind: "done" },
    ],
    history,
    {
      // Даём тесту уйти в середину до streaming и canonical refresh.
      promptDelayMs: 900,
      sessionDelayMs: 1400,
      initialMessages: history,
      sessionHistory: () => canonical,
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const scroll = page.getByTestId("opencode-messages");
  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await expect(scroll).toContainText("Середина 29.");
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);

  await message.fill("Вопрос");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => mock.promptBodies.length).toBe(1);

  await readChatMiddle(page);
  const jump = page.getByTestId("opencode-jump-to-latest");
  await expect(jump).toBeVisible();
  const middle = await chatScrollMetrics(page);
  expect(middle.top).toBeGreaterThan(0);
  expect(middle.bottomGap).toBeGreaterThan(100);
  const anchor = await chatAnchor(page);
  expect(anchor.text).not.toContain("Середина 29.");

  // Delta ниже viewport не перестраивает контент выше: числовой scrollTop цел.
  await expect(scroll.getByText("Потоковый ответ середины", { exact: true })).toBeVisible();
  expect((await chatScrollMetrics(page)).top).toBe(middle.top);

  // Canonical replacement выросшего раннего сообщения: видимый anchor на месте.
  await expect(scroll).toContainText("Дополнительный ранний текст.");
  await expect(scroll.getByText("Ответ в середине", { exact: true })).toBeVisible();
  const anchored = await chatAnchor(page);
  expect(anchored.text).toBe(anchor.text);
  expect(Math.abs((await chatAnchorTop(page, anchor)) - anchor.top)).toBeLessThanOrEqual(1);
  // ScrollTop изменил браузер для компенсации reflow выше, а не hook.
  expect((await chatScrollMetrics(page)).top).toBeGreaterThan(middle.top);
  await expect(jump).toBeVisible();
});

test("mobile панель открывается явно, занимает экран и сохраняет закрытое состояние", async ({
  page,
}) => {
  const mock = await mockOpenCode(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");

  const open = page.getByTestId("opencode-open");
  await expect(open).toBeVisible();
  expect(mock.catalogCalls).toBe(0);
  await open.click();

  const sidebar = page.getByTestId("opencode-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(page.getByTestId("opencode-panel")).toBeVisible();
  const geometry = await sidebar.evaluate((element) => ({
    width: Math.round(element.getBoundingClientRect().width),
    height: Math.round(element.getBoundingClientRect().height),
  }));
  expect(geometry).toEqual({ width: 360, height: 740 });

  await page.getByTestId("opencode-close").click();
  await expect(sidebar).toHaveCount(0);
  await expect(open).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.opencode.panelOpen")))
    .toBe("false");
  await page.reload();
  await expect(open).toBeVisible();
  await open.click();
  await expect(sidebar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveCount(0);
});

test("desktop model switch, streaming tool upsert и новая сессия", async ({ page }) => {
  const mock = await mockOpenCode(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const sidebar = page.getByTestId("opencode-sidebar");
  await expect(sidebar).toBeVisible();
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(384);
  await expect(page.getByRole("textbox", { name: "Сообщение OpenCode" })).toBeEnabled();

  const modelDetails = page.locator("details").filter({ hasText: "Модель" });
  await expect(modelDetails).toHaveJSProperty("open", false);
  await modelDetails.locator("summary").click();
  await expect(modelDetails).toHaveJSProperty("open", true);

  const toolsSummary = page.getByText("Инструменты агента (25)");
  await expect(toolsSummary).toBeVisible();
  await expect(page.getByText("kanbaner_task_update")).toBeHidden();
  await toolsSummary.click();
  await expect(page.getByText("Полный доступ: интернет, файлы и shell")).toBeVisible();
  await expect(page.getByText("Встроенные инструменты OpenCode (11)")).toBeVisible();
  await expect(page.getByText("Инструменты Kanbaner MCP (14)")).toBeVisible();

  const builtinGroup = page.getByRole("list", { name: "Встроенные инструменты OpenCode" });
  await expect(builtinGroup.getByRole("listitem")).toHaveCount(11);
  await expect(builtinGroup.getByText("shell", { exact: true })).toBeVisible();
  await expect(builtinGroup.getByText("external_directory", { exact: true })).toBeVisible();
  const mcpGroup = page.getByRole("list", { name: "Инструменты Kanbaner MCP" });
  await expect(mcpGroup.getByRole("listitem")).toHaveCount(14);
  await expect(mcpGroup.getByText("kanbaner_task_update", { exact: true })).toBeVisible();
  await expect(page.getByText(/browser_|orenda_|webaccess-ai_/u)).toHaveCount(0);

  await page.getByRole("combobox", { name: "Провайдер OpenCode" }).selectOption("provider-2");
  await expect(page.getByRole("combobox", { name: "Модель OpenCode" })).toHaveValue("model-2");
  expect(mock.modelInputs).toEqual([
    { model: { id: "model-2", providerID: "provider-2", variant: "max" } },
  ]);

  await page.getByRole("textbox", { name: "Сообщение OpenCode" }).fill("Проверка");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByText("Ответ OpenCode", { exact: true })).toBeVisible();
  const toolCall = page.getByTestId("opencode-tool-call");
  await expect(toolCall).toHaveCount(1);
  await expect(page.getByText("task_update", { exact: true })).toHaveCount(1);
  await expect(toolCall).toHaveJSProperty("open", false);
  await expect(toolCall.getByTestId("opencode-tool-call-duration")).toHaveText("2 с");
  await expect(toolCall.getByTestId("opencode-tool-call-output")).toBeHidden();
  await toolCall.getByTestId("opencode-tool-call-summary").click();
  await expect(toolCall.getByTestId("opencode-tool-call-output")).toHaveText("Обновлено");
  await expect(toolCall.getByTestId("opencode-tool-call-input")).toContainText('"id":"task-1"');
  await expect(page.getByRole("textbox", { name: "Сообщение OpenCode" })).toBeEnabled();
  expect(mock.promptBodies).toEqual([expect.objectContaining({ text: "Проверка" })]);

  await page.getByRole("button", { name: "Новая сессия OpenCode" }).click();
  await expect(
    page.getByText("Спросите о задачах, заметках или попросите изменить их."),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.opencode.sessionId")))
    .toBe("ses-2");
});

test("tool call компактен: duration, keyboard disclosure и длинный output без overflow", async ({
  page,
}) => {
  const longOutput = "0123456789".repeat(40);
  const tool = {
    id: "tool:message-1:call-1",
    role: "tool",
    name: "task_update",
    status: "completed",
    text: "",
    input: '{"id":"task-1","description":"long output"}',
    output: longOutput,
    startedAt: 1000,
    endedAt: 61_000,
  };
  const mock = await mockOpenCode(
    page,
    () => [
      {
        kind: "tool",
        id: "message-1:call-1",
        name: "task_update",
        status: "running",
        text: "",
        input: '{"id":"task-1","description":"long output"}',
        startedAt: 1000,
      },
      {
        kind: "tool",
        id: "message-1:call-1",
        status: "completed",
        text: "",
        output: longOutput,
        endedAt: 61_000,
      },
      { kind: "text", id: "message-1:0", text: "Ответ OpenCode" },
      { kind: "finalizing" },
      { kind: "done" },
    ],
    [
      { id: "user:message-0", role: "user", text: "Проверка" },
      tool,
      { id: "assistant:message-1:0", role: "assistant", text: "Ответ OpenCode" },
    ],
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await message.fill("Проверка");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByText("Ответ OpenCode", { exact: true })).toBeVisible();
  await expect.poll(() => mock.promptBodies.length).toBe(1);

  const toolCall = page.getByTestId("opencode-tool-call");
  const summary = toolCall.getByTestId("opencode-tool-call-summary");
  const output = toolCall.getByTestId("opencode-tool-call-output");
  await expect(toolCall).toHaveCount(1);
  await expect(toolCall).toHaveJSProperty("open", false);
  await expect(toolCall.getByTestId("opencode-tool-call-duration")).toHaveText("1 мин 0 с");
  await expect(output).toBeHidden();

  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(toolCall).toHaveJSProperty("open", true);
  await expect(output).toBeVisible();
  await expect(output).toHaveText(longOutput);
  await page.keyboard.press("Space");
  await expect(toolCall).toHaveJSProperty("open", false);
  await expect(output).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(toolCall).toHaveJSProperty("open", true);

  const metrics = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
    const details = document.querySelector<HTMLElement>('[data-testid="opencode-tool-call"]');
    const outputElement = document.querySelector<HTMLElement>(
      '[data-testid="opencode-tool-call-output"]',
    );
    if (panel === null || details === null || outputElement === null) {
      throw new Error("tool call is missing");
    }
    const panelRect = panel.getBoundingClientRect();
    const detailsRect = details.getBoundingClientRect();
    const outputRect = outputElement.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      outputOverflow: outputElement.scrollWidth - outputElement.clientWidth,
      detailsRight: detailsRect.right,
      outputRight: outputRect.right,
      panelRight: panelRect.right,
    };
  });
  expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
  expect(metrics.panelOverflow).toBeLessThanOrEqual(1);
  expect(metrics.outputOverflow).toBeLessThanOrEqual(1);
  expect(metrics.detailsRight).toBeLessThanOrEqual(metrics.panelRight + 1);
  expect(metrics.outputRight).toBeLessThanOrEqual(metrics.panelRight + 1);

  await page.reload();
  const open = page.getByTestId("opencode-open");
  if (await open.isVisible()) await open.click();
  const reloadedTool = page.getByTestId("opencode-tool-call");
  await expect(reloadedTool).toHaveCount(1);
  await expect(reloadedTool).toHaveJSProperty("open", false);
  await expect(reloadedTool.getByTestId("opencode-tool-call-duration")).toHaveText("1 мин 0 с");
  await expect(reloadedTool.getByTestId("opencode-tool-call-output")).toBeHidden();
  await reloadedTool.getByTestId("opencode-tool-call-summary").click();
  await expect(reloadedTool.getByTestId("opencode-tool-call-output")).toHaveText(longOutput);
});

test("composer: полноразмерная textarea, icon-only кнопки и отсутствие overflow", async ({
  page,
}) => {
  await mockOpenCode(page);
  await page.goto("/");
  await page.getByTestId("opencode-open").click();
  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();

  for (const viewport of [
    { width: 360, height: 740, panelWidth: 360 },
    { width: 1440, height: 900, panelWidth: 384 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect
      .poll(() =>
        page
          .getByTestId("opencode-sidebar")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(viewport.panelWidth);

    const metrics = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Сообщение OpenCode"]',
      );
      if (panel === null || textarea === null) throw new Error("composer is missing");
      const buttons = [
        document.querySelector<HTMLElement>('button[aria-label="Прикрепить файлы"]'),
        document.querySelector<HTMLElement>('button[aria-label="Отправить"]'),
      ].filter((element): element is HTMLElement => element !== null);
      return {
        panelWidth: panel.getBoundingClientRect().width,
        textareaHeight: textarea.getBoundingClientRect().height,
        textareaWidth: textarea.getBoundingClientRect().width,
        textareaResize: getComputedStyle(textarea).resize,
        maxButtonWidth: Math.max(
          ...buttons.map((element) => element.getBoundingClientRect().width),
        ),
        buttonTexts: buttons.map((element) => element.textContent ?? ""),
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        panelOverflow: panel.scrollWidth - panel.clientWidth,
      };
    });

    expect(metrics.textareaHeight).toBeGreaterThanOrEqual(96);
    expect(metrics.textareaWidth).toBeGreaterThanOrEqual(metrics.panelWidth - 24);
    expect(metrics.textareaResize).toBe("vertical");
    expect(metrics.maxButtonWidth).toBeLessThanOrEqual(44);
    expect(metrics.buttonTexts).toEqual(["", ""]);
    expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
    expect(metrics.panelOverflow).toBeLessThanOrEqual(1);
  }

  await page.setViewportSize({ width: 360, height: 740 });
  await expect
    .poll(() =>
      page
        .getByTestId("opencode-sidebar")
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    )
    .toBe(360);
  await page.getByTestId("opencode-file-input").setInputFiles(
    Array.from({ length: 5 }, (_value, index) => ({
      name: `very-long-attachment-name-${index}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("hello", "utf8"),
    })),
  );
  const chips = page.getByRole("list", { name: "Выбранные файлы" });
  await expect(chips.getByRole("listitem")).toHaveCount(5);

  const chipsMetrics = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[aria-label="Выбранные файлы"]');
    const panel = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
    if (list === null || panel === null) throw new Error("chips are missing");
    const listRect = list.getBoundingClientRect();
    return {
      listRight: listRect.right,
      listWidth: listRect.width,
      panelRight: panel.getBoundingClientRect().right,
      maxChipWidth: Math.max(
        ...Array.from(list.children).map((element) => element.getBoundingClientRect().width),
      ),
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(chipsMetrics.listRight).toBeLessThanOrEqual(chipsMetrics.panelRight);
  expect(chipsMetrics.maxChipWidth).toBeLessThanOrEqual(chipsMetrics.listWidth + 1);
  expect(chipsMetrics.documentOverflow).toBeLessThanOrEqual(0);
});

test("model disclosure: collapsed summary, keyboard toggle и прежняя geometry после раскрытия", async ({
  page,
}) => {
  await mockOpenCode(page);
  const longModelName =
    "Claude 9 Ultra Long Context Experimental Model With A Very Long Display Name";
  await page.route("**/api/opencode/catalog", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          ...catalog,
          models: catalog.models.map((model, index) =>
            index === 0 ? { ...model, name: longModelName } : model,
          ),
        },
      }),
    });
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const modelDetails = page.locator("details").filter({ hasText: "Модель" });
  const modelSummary = modelDetails.locator("summary");
  const modelSelect = page.locator('select[aria-label="Модель OpenCode"]');

  await expect(modelSummary).toBeVisible();
  await expect(modelSummary).toContainText("Модель");
  await expect(modelSummary).toContainText(longModelName);
  await expect(modelSummary.getByTitle(longModelName)).toBeVisible();
  await expect(modelDetails).toHaveJSProperty("open", false);
  await expect(modelSelect).toBeHidden();

  const collapsedMetrics = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
    const summary =
      Array.from(document.querySelectorAll<HTMLElement>("details"))
        .find((element) => element.textContent?.includes("Модель"))
        ?.querySelector("summary") ?? null;
    if (panel === null || summary === null) throw new Error("model summary is missing");
    const summaryRect = summary.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      summaryWidth: summaryRect.width,
      summaryOverflow: summary.scrollWidth - summary.clientWidth,
      summaryRight: summaryRect.right,
      panelWidth: panelRect.width,
      panelRight: panelRect.right,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(collapsedMetrics.summaryWidth).toBeLessThanOrEqual(collapsedMetrics.panelWidth - 20);
  expect(collapsedMetrics.summaryOverflow).toBeLessThanOrEqual(1);
  expect(collapsedMetrics.summaryRight).toBeLessThanOrEqual(collapsedMetrics.panelRight);
  expect(collapsedMetrics.documentOverflow).toBeLessThanOrEqual(0);

  await modelSummary.focus();
  await page.keyboard.press("Enter");
  await expect(modelDetails).toHaveJSProperty("open", true);
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toHaveValue("model-1");

  await page.keyboard.press("Space");
  await expect(modelDetails).toHaveJSProperty("open", false);
  await expect(modelSelect).toBeHidden();

  await page.keyboard.press("Enter");
  await expect(modelDetails).toHaveJSProperty("open", true);

  for (const viewport of [
    { width: 360, height: 740, panelWidth: 360 },
    { width: 1440, height: 900, panelWidth: 384 },
    { width: 1440, height: 900, panelWidth: 320 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    if (viewport.panelWidth === 320) {
      const handle = page.locator("[data-app-assistant-resizer]");
      await handle.focus();
      await page.keyboard.press("Home");
    }
    await expect
      .poll(() =>
        page
          .getByTestId("opencode-sidebar")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(viewport.panelWidth);

    const metrics = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
      const model = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Модель OpenCode"]',
      );
      const provider = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Провайдер OpenCode"]',
      );
      const variant = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Вариант модели OpenCode"]',
      );
      const summary = model?.closest("details")?.querySelector<HTMLElement>("summary") ?? null;
      if (panel === null || model === null || provider === null || variant === null) {
        throw new Error("model controls are missing");
      }
      if (summary === null) throw new Error("model summary is missing");
      const panelRect = panel.getBoundingClientRect();
      const modelRect = model.getBoundingClientRect();
      const providerRect = provider.getBoundingClientRect();
      const variantRect = variant.getBoundingClientRect();
      const summaryRect = summary.getBoundingClientRect();
      return {
        panelWidth: panelRect.width,
        panelRight: panelRect.right,
        modelWidth: modelRect.width,
        modelBottom: modelRect.bottom,
        modelTitle: model.getAttribute("title"),
        providerWidth: providerRect.width,
        providerTop: providerRect.top,
        variantWidth: variantRect.width,
        variantTop: variantRect.top,
        summaryOverflow: summary.scrollWidth - summary.clientWidth,
        summaryRight: summaryRect.right,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        panelOverflow: panel.scrollWidth - panel.clientWidth,
      };
    });

    expect(metrics.modelTitle).toBe(longModelName);
    expect(metrics.modelWidth).toBeGreaterThanOrEqual(metrics.panelWidth - 24);
    expect(metrics.modelWidth).toBeGreaterThan(metrics.providerWidth);
    expect(metrics.providerWidth).toBeGreaterThan(metrics.variantWidth);
    expect(metrics.variantWidth).toBeLessThanOrEqual(metrics.panelWidth / 2);
    expect(metrics.providerTop).toBeGreaterThanOrEqual(metrics.modelBottom - 1);
    expect(Math.abs(metrics.providerTop - metrics.variantTop)).toBeLessThanOrEqual(2);
    expect(metrics.summaryOverflow).toBeLessThanOrEqual(1);
    expect(metrics.summaryRight).toBeLessThanOrEqual(metrics.panelRight);
    expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
    expect(metrics.panelOverflow).toBeLessThanOrEqual(1);
  }
});

test("assistant Markdown рендерится безопасно, user остаётся plain text", async ({ page }) => {
  const markdown = [
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
    "<b>raw</b>",
  ].join("\n");
  await mockOpenCode(
    page,
    () => [{ kind: "text", id: "message-1:0", text: markdown }, { kind: "done" }],
    [
      { id: "user:message-0", role: "user", text: "**не жирный**" },
      { id: "assistant:message-1:0", role: "assistant", text: markdown },
    ],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await message.fill("Покажи итог");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();

  const panel = page.getByTestId("opencode-panel");
  await expect(panel.getByRole("heading", { name: "Итог" })).toBeVisible();
  await expect(panel.locator("strong", { hasText: "Важно" })).toHaveCount(1);
  await expect(panel.getByRole("listitem").filter({ hasText: "Первый пункт" })).toBeVisible();
  await expect(panel.getByRole("listitem").filter({ hasText: "Второй пункт" })).toBeVisible();

  const link = panel.getByRole("link", { name: "Документация" });
  await expect(link).toHaveAttribute("href", "https://example.com/docs");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer nofollow");

  await expect(panel.getByText("**не жирный**", { exact: true })).toBeVisible();
  await expect(panel.getByText("window.__markdownXss")).toHaveCount(0);
  // Raw HTML не интерпретируется: тег <b> не появляется, остаётся только текст.
  await expect(panel.locator("b", { hasText: "raw" })).toHaveCount(0);
  await expect(panel.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __markdownXss?: boolean }).__markdownXss)).toBe(
    undefined,
  );
});

test("прикрепляет текстовый файл и передаёт его в prompt как base64", async ({ page }) => {
  const mock = await mockOpenCode(page, undefined, [
    {
      id: "user:message-0",
      role: "user",
      text: "Посмотри файл",
      attachments: [
        { name: "notes.txt", mime: "text/plain" },
        { name: "manual.pdf", mime: "application/pdf" },
      ],
    },
    { id: "assistant:message-1:0", role: "assistant", text: "Ответ OpenCode" },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  const attach = page.getByRole("button", { name: "Прикрепить файлы" });
  await expect(attach).toBeVisible();
  await expect(attach).toHaveText("");
  await expect(page.getByText(/Файлы передаются только выбранной модели/u)).toHaveCount(0);
  await page.getByTestId("opencode-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello", "utf8"),
  });
  await expect(page.getByText("notes.txt")).toBeVisible();
  await expect(page.getByText("5 B")).toBeVisible();

  await message.fill("Посмотри файл");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.getByText("Ответ OpenCode", { exact: true })).toBeVisible();

  expect(mock.promptBodies).toEqual([
    expect.objectContaining({
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    }),
  ]);
  await expect(page.getByText("5 B")).toHaveCount(0);

  // Canonical history хранит только метаданные: text/PDF остаются чипами,
  // binary preview для них не запрашивается.
  await expect.poll(() => mock.sessionBodies.length).toBeGreaterThan(0);
  const attachments = page.getByRole("list", { name: "Вложения сообщения" });
  await expect(attachments.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(attachments.getByText("manual.pdf", { exact: true })).toBeVisible();
  await expect(attachments.getByTestId("message-image-preview")).toHaveCount(0);
  expect(mock.previewPaths).toHaveLength(0);
});

test("image attachment: preview в composer, optimistic/canonical и после reload", async ({
  page,
}) => {
  const mock = await mockOpenCode(
    page,
    () => [{ kind: "text", id: "message-1:0", text: "Стриминговый ответ" }, { kind: "done" }],
    [
      {
        id: "user:message-0",
        role: "user",
        text: "Посмотри картинку",
        attachments: [{ name: "pixel.png", mime: "image/png" }],
      },
      { id: "assistant:message-1:0", role: "assistant", text: "Канонический ответ" },
    ],
    { sessionDelayMs: 600 },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await page.getByTestId("opencode-file-input").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: PREVIEW_PNG,
  });

  const selected = page.getByRole("list", { name: "Выбранные файлы" });
  const composerPreview = selected.getByRole("img", { name: "pixel.png" });
  await expect(composerPreview).toBeVisible();
  await expect
    .poll(() =>
      composerPreview.evaluate((element) =>
        element instanceof HTMLImageElement ? element.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect(selected.getByRole("button", { name: "Удалить вложение pixel.png" })).toBeVisible();
  await expect(selected.getByText("pixel.png")).toBeVisible();
  expect(await page.evaluate(() => document.body.innerHTML.includes("data:image"))).toBe(false);

  await message.fill("Посмотри картинку");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();

  const panel = page.getByTestId("opencode-panel");
  const attachments = panel.getByRole("list", { name: "Вложения сообщения" });
  const messagePreview = attachments.getByRole("img", { name: "pixel.png" });
  // До canonical refresh сообщение optimistic: preview уже виден.
  await expect(panel.getByText("Стриминговый ответ", { exact: true })).toBeVisible();
  await expect(messagePreview).toBeVisible();
  await expect
    .poll(() =>
      messagePreview.evaluate((element) =>
        element instanceof HTMLImageElement ? element.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(0);

  // canonical refresh заменяет optimistic message, но preview остаётся локальным.
  await expect(panel.getByText("Канонический ответ", { exact: true })).toBeVisible();
  await expect(messagePreview).toBeVisible();
  await expect(selected).toHaveCount(0);
  expect(mock.previewPaths).toHaveLength(0);

  expect(mock.promptBodies).toHaveLength(1);
  expect(mock.promptBodies[0]?.files?.[0]).toMatchObject({
    name: "pixel.png",
    mime: "image/png",
  });

  for (const viewport of [
    { width: 1440, height: 900, panelWidth: 384 },
    { width: 360, height: 740, panelWidth: 360 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect
      .poll(() =>
        page
          .getByTestId("opencode-sidebar")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(viewport.panelWidth);

    const metrics = await page.evaluate(() => {
      const panelElement = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
      if (panelElement === null) throw new Error("panel is missing");
      const image = panelElement.querySelector<HTMLImageElement>(
        '[data-testid="message-image-preview"]',
      );
      const list = panelElement.querySelector<HTMLElement>('[aria-label="Вложения сообщения"]');
      if (image === null) throw new Error("image preview is missing");
      if (list === null) throw new Error("attachments list is missing");
      const panelRect = panelElement.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return {
        panelRight: panelRect.right,
        imageWidth: imageRect.width,
        imageHeight: imageRect.height,
        imageRight: imageRect.right,
        listRight: listRect.right,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        panelOverflow: panelElement.scrollWidth - panelElement.clientWidth,
      };
    });
    expect(metrics.imageWidth).toBeGreaterThan(0);
    expect(metrics.imageWidth).toBeLessThanOrEqual(240);
    expect(metrics.imageHeight).toBeLessThanOrEqual(224);
    expect(metrics.imageRight).toBeLessThanOrEqual(metrics.panelRight + 1);
    expect(metrics.listRight).toBeLessThanOrEqual(metrics.panelRight + 1);
    expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
    expect(metrics.panelOverflow).toBeLessThanOrEqual(1);
  }

  await page.reload();
  const open = page.getByTestId("opencode-open");
  if (await open.isVisible()) await open.click();
  const reloadedPanel = page.getByTestId("opencode-panel");
  await expect(reloadedPanel.getByText("Канонический ответ", { exact: true })).toBeVisible();
  const reloadedAttachments = reloadedPanel.getByRole("list", { name: "Вложения сообщения" });
  await expect(reloadedAttachments.getByText("pixel.png")).toBeVisible();

  // После reload history содержит только name/mime; preview приходит bytes из endpoint.
  const reloadedPreview = reloadedAttachments.getByRole("img", { name: "pixel.png" });
  await expect(reloadedPreview).toBeVisible();
  await expect
    .poll(() =>
      reloadedPreview.evaluate((element) =>
        element instanceof HTMLImageElement ? element.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect.poll(() => mock.previewPaths.length).toBeGreaterThan(0);
  expect(mock.previewPaths.at(-1)).toBe(
    "/api/opencode/session/ses-1/messages/message-0/attachments/0",
  );
  expect(mock.previewHeaders.at(-1)?.["x-kanbaner-client"]).toBe("ui");
  expect(JSON.stringify(mock.sessionBodies.at(-1))).not.toContain("base64");
  expect(JSON.stringify(mock.sessionBodies.at(-1))).not.toContain("data:image");

  for (const viewport of [
    { width: 1440, height: 900, panelWidth: 384 },
    { width: 360, height: 740, panelWidth: 360 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect
      .poll(() =>
        page
          .getByTestId("opencode-sidebar")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
      )
      .toBe(viewport.panelWidth);

    const metrics = await page.evaluate(() => {
      const panelElement = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
      if (panelElement === null) throw new Error("panel is missing");
      const image = panelElement.querySelector<HTMLImageElement>(
        '[data-testid="message-image-preview"]',
      );
      if (image === null) throw new Error("reloaded image preview is missing");
      const panelRect = panelElement.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      return {
        panelRight: panelRect.right,
        imageWidth: imageRect.width,
        imageHeight: imageRect.height,
        imageRight: imageRect.right,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        panelOverflow: panelElement.scrollWidth - panelElement.clientWidth,
      };
    });
    expect(metrics.imageWidth).toBeGreaterThan(0);
    expect(metrics.imageWidth).toBeLessThanOrEqual(240);
    expect(metrics.imageHeight).toBeLessThanOrEqual(224);
    expect(metrics.imageRight).toBeLessThanOrEqual(metrics.panelRight + 1);
    expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
    expect(metrics.panelOverflow).toBeLessThanOrEqual(1);
  }

  expect(await page.evaluate(() => document.body.innerHTML.includes("base64"))).toBe(false);
});

test("ошибка upstream в NDJSON сохраняет вложение для повтора до done", async ({ page }) => {
  const mock = await mockOpenCode(page, (call) =>
    call === 1
      ? [{ kind: "finalizing" }, { kind: "error", text: "Модель отклонила вложение" }]
      : [{ kind: "finalizing" }, { kind: "done" }],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await page.getByTestId("opencode-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello", "utf8"),
  });
  const selected = page.getByRole("list", { name: "Выбранные файлы" });
  await expect(selected.getByText("notes.txt")).toBeVisible();

  await message.fill("Посмотри файл");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const turnStatus = page.getByTestId("opencode-turn-status");
  await expect(turnStatus).toContainText("Модель отклонила вложение");
  await expect(turnStatus.getByRole("button", { name: "Повторить запрос" })).toHaveCount(0);
  await expect(selected.getByText("notes.txt")).toBeVisible();

  await message.fill("Посмотри файл");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(turnStatus).toContainText("Готово");
  await expect(selected).toHaveCount(0);
  expect(mock.promptBodies).toEqual([
    expect.objectContaining({
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    }),
    expect.objectContaining({
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    }),
  ]);
});

test("prompt success: Enter, один POST и сохранённый статус Готово", async ({ page }) => {
  const mock = await mockOpenCode(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await message.fill("Проверка клавиатуры");
  await message.press("Enter");

  const turnStatus = page.getByTestId("opencode-turn-status");
  await expect(turnStatus).toContainText("Готово");
  await expect(turnStatus).toHaveAttribute("role", "status");
  await expect(page.getByText("Ответ OpenCode", { exact: true })).toBeVisible();
  await expect(message).toBeEnabled();
  expect(mock.promptBodies).toEqual([expect.objectContaining({ text: "Проверка клавиатуры" })]);
  await expect.poll(() => mock.sessionBodies.length).toBe(1);
  await expect(turnStatus.getByRole("button", { name: "Повторить запрос" })).toHaveCount(0);
  await expect(turnStatus.getByRole("button", { name: "Проверить статус" })).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("unconfirmed: нет авто-GET, Проверить статус делает один GET без нового prompt", async ({
  page,
}) => {
  const mock = await mockOpenCode(page, () => [{ kind: "finalizing" }], [
    { id: "user:message-0", role: "user", text: "Проверка" },
  ]);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await message.fill("Проверка");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();

  const turnStatus = page.getByTestId("opencode-turn-status");
  await expect(turnStatus).toContainText("Результат не подтверждён");
  await expect(turnStatus).toContainText("Не удалось подтвердить результат OpenCode");
  await expect(turnStatus.getByRole("button", { name: "Повторить запрос" })).toHaveCount(0);
  await expect(page.getByText("Проверка", { exact: true })).toBeVisible();
  expect(mock.promptBodies).toHaveLength(1);
  expect(mock.sessionBodies).toHaveLength(0);

  await turnStatus.getByRole("button", { name: "Проверить статус" }).click();
  await expect(turnStatus).toContainText("Результат пока не подтверждён");
  expect(mock.sessionBodies).toHaveLength(1);
  expect(mock.promptBodies).toHaveLength(1);
  await expect(page.getByText("Проверка", { exact: true })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("ручная проверка статуса: canonical done заменяет streamed-сообщения", async ({ page }) => {
  const mock = await mockOpenCode(
    page,
    () => [{ kind: "finalizing" }],
    [
      { id: "user:message-0", role: "user", text: "Проверка" },
      { id: "assistant:message-1:0", role: "assistant", text: "Канонический ответ" },
    ],
    { statusOutcome: "done" },
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await message.fill("Проверка");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();

  const turnStatus = page.getByTestId("opencode-turn-status");
  await expect(turnStatus).toContainText("Результат не подтверждён");
  expect(mock.promptBodies).toHaveLength(1);

  await turnStatus.getByRole("button", { name: "Проверить статус" }).click();
  await expect(turnStatus).toContainText("Готово");
  await expect(page.getByText("Канонический ответ", { exact: true })).toBeVisible();
  expect(mock.promptBodies).toHaveLength(1);
  expect(mock.statusQueries).toHaveLength(1);
  expect(mock.statusQueries[0]).toBe(mock.promptBodies[0]?.turnID);
});

test("ручная проверка статуса: canonical error сохраняет streamed-текст", async ({ page }) => {
  const mock = await mockOpenCode(
    page,
    () => [{ kind: "delta", id: "message-1:0", text: "Черновик" }, { kind: "finalizing" }],
    [{ id: "user:message-0", role: "user", text: "Проверка" }],
    { statusOutcome: "error" },
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await message.fill("Проверка");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();

  const turnStatus = page.getByTestId("opencode-turn-status");
  await expect(turnStatus).toContainText("Результат не подтверждён");
  await expect(page.getByText("Черновик", { exact: true })).toBeVisible();

  await turnStatus.getByRole("button", { name: "Проверить статус" }).click();
  await expect(turnStatus).toContainText("OpenCode сообщил об ошибке");
  await expect(page.getByText("Черновик", { exact: true })).toBeVisible();
  expect(mock.promptBodies).toHaveLength(1);
});

test("desktop: чтение выше переживает streaming, canonical и раскрытие tool call", async ({
  page,
}) => {
  const history = Array.from({ length: 24 }, (_value, index) => ({
    id: `assistant:history-${index}`,
    role: "assistant" as const,
    text: `Длинная история ${index}. ${"Подробный текст шага. ".repeat(6)}`,
  }));
  const canonical = [
    ...history,
    { id: "assistant:canonical", role: "assistant" as const, text: "Канонический ответ" },
  ];
  const mock = await mockOpenCode(
    page,
    (call) =>
      call === 1
        ? [
            {
              kind: "tool",
              id: "message-1:call-1",
              name: "read",
              status: "running",
              text: "",
              startedAt: 1000,
            },
            {
              kind: "tool",
              id: "message-1:call-1",
              name: "read",
              status: "completed",
              text: "",
              output: "ok",
              endedAt: 2000,
            },
            { kind: "delta", id: "message-1:0", text: "Потоковый " },
            { kind: "text", id: "message-1:0", text: "Потоковый ответ" },
            { kind: "finalizing" },
            { kind: "done" },
          ]
        : [{ kind: "text", id: "message-2:0", text: "Второй ответ" }, { kind: "done" }],
    history,
    {
      // Ответ приходит после того, как тест успевает уйти читать выше.
      promptDelayMs: 900,
      sessionDelayMs: 1200,
      initialMessages: history,
      // GET после prompt — canonical refresh; вторая проверка ждёт свой ответ.
      sessionHistory: (call) =>
        call === 1
          ? canonical
          : [...canonical, { id: "assistant:second", role: "assistant", text: "Второй ответ" }],
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const scroll = page.getByTestId("opencode-messages");
  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await expect(scroll).toContainText("Длинная история 23.");
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);
  const initial = await chatScrollMetrics(page);
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight + 400);

  await message.fill("Вопрос");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect.poll(() => mock.promptBodies.length).toBe(1);

  // Уходим выше до прихода streaming-событий: follow выключается.
  await readChatAbove(page);
  const jump = page.getByTestId("opencode-jump-to-latest");
  await expect(jump).toBeVisible();
  await expect(scroll.locator('[data-testid="opencode-jump-to-latest"]')).toHaveCount(0);

  await expect(scroll.getByText("Потоковый ответ", { exact: true })).toBeVisible();
  expect((await chatScrollMetrics(page)).top).toBe(0);
  await expect(jump).toBeVisible();
  await expect(page.getByTestId("opencode-unread-count")).toBeVisible();

  // Раскрытие tool call увеличивает контент, но не двигает чтение.
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>(
      '[data-testid="opencode-tool-call"]',
    );
    if (details === null) throw new Error("tool call is missing");
    details.open = true;
  });
  await expect(page.getByTestId("opencode-tool-call")).toHaveJSProperty("open", true);
  expect((await chatScrollMetrics(page)).top).toBe(0);

  // Canonical refresh той же сессии заменяет сообщения, но не scrollTop.
  await expect(scroll.getByText("Канонический ответ", { exact: true })).toBeVisible();
  expect((await chatScrollMetrics(page)).top).toBe(0);
  await expect(jump).toBeVisible();

  expect(await jump.evaluate((element) => element.tagName)).toBe("BUTTON");
  await jump.focus();
  await expect(jump).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(jump).toHaveCount(0);
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
    "opencode-messages",
  );

  // Явный возврат снова включает follow для следующего prompt.
  await expect(message).toBeEnabled();
  await message.fill("Ещё");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(scroll.getByText("Второй ответ", { exact: true })).toBeVisible();
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);
});

test("mobile 360: кнопка вне scroll, resize и загрузка картинки не двигают чтение", async ({
  page,
}) => {
  let releasePreview: () => void = () => {};
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const history = [
    {
      id: "user:message-0",
      role: "user" as const,
      text: "История с картинкой",
      attachments: [{ name: "pixel.png", mime: "image/png" }],
    },
    {
      id: "tool:message-1:call-1",
      role: "tool" as const,
      name: "read",
      status: "completed" as const,
      text: "",
      input: '{"path":"README.md"}',
      output: "ok",
      startedAt: 1000,
      endedAt: 2000,
    },
    ...Array.from({ length: 18 }, (_value, index) => ({
      id: `assistant:history-${index}`,
      role: "assistant" as const,
      text: `Мобильная история ${index}. ${"Текст для прокрутки. ".repeat(5)}`,
    })),
  ];
  const mock = await mockOpenCode(
    page,
    () => [{ kind: "text", id: "message-1:0", text: "Мобильный ответ" }, { kind: "done" }],
    history,
    {
      previewGate,
      initialMessages: history,
      sessionHistory: () => [
        ...history,
        { id: "assistant:mobile", role: "assistant", text: "Мобильный ответ" },
      ],
    },
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByTestId("opencode-open").click();

  const scroll = page.getByTestId("opencode-messages");
  const message = page.getByRole("textbox", { name: "Сообщение OpenCode" });
  await expect(message).toBeEnabled();
  await expect(scroll).toContainText("Мобильная история 17.");
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);

  await readChatAbove(page);
  const jump = page.getByTestId("opencode-jump-to-latest");
  await expect(jump).toBeVisible();
  expect((await chatScrollMetrics(page)).top).toBe(0);

  // Загрузка image preview ниже точки чтения не создаёт scroll jump.
  releasePreview();
  const image = page.getByTestId("message-image-preview");
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => (element instanceof HTMLImageElement ? element.naturalWidth : 0)),
    )
    .toBeGreaterThan(0);
  expect((await chatScrollMetrics(page)).top).toBe(0);
  await expect(jump).toBeVisible();

  // Раскрытие tool call меняет высоту контента, но не позицию чтения.
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>(
      '[data-testid="opencode-tool-call"]',
    );
    if (details === null) throw new Error("tool call is missing");
    details.open = true;
  });
  await expect(page.getByTestId("opencode-tool-call")).toHaveJSProperty("open", true);
  expect((await chatScrollMetrics(page)).top).toBe(0);

  // Mobile viewport resize не прокручивает читающего выше.
  await page.setViewportSize({ width: 360, height: 600 });
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(600);
  expect((await chatScrollMetrics(page)).top).toBe(0);
  await expect(jump).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="opencode-panel"]');
    const scroller = document.querySelector<HTMLElement>('[data-testid="opencode-messages"]');
    const button = document.querySelector<HTMLElement>('[data-testid="opencode-jump-to-latest"]');
    if (panel === null || scroller === null || button === null) {
      throw new Error("scroll ui is missing");
    }
    const buttonRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      insideScroll: scroller.contains(button),
      buttonWidth: buttonRect.width,
      buttonRight: buttonRect.right,
      panelRight: panelRect.right,
      panelWidth: panelRect.width,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
    };
  });
  expect(layout.insideScroll).toBe(false);
  expect(layout.buttonWidth).toBeLessThanOrEqual(layout.panelWidth - 16);
  expect(layout.buttonRight).toBeLessThanOrEqual(layout.panelRight + 1);
  expect(layout.documentOverflow).toBeLessThanOrEqual(0);
  expect(layout.panelOverflow).toBeLessThanOrEqual(1);

  await jump.focus();
  await expect(jump).toBeFocused();
  await page.keyboard.press("Space");
  await expect(jump).toHaveCount(0);
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
    "opencode-messages",
  );

  // После возврата prompt снова следует за концом.
  await expect(message).toBeEnabled();
  await message.fill("Мобильный вопрос");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(scroll.getByText("Мобильный ответ", { exact: true })).toBeVisible();
  expect(mock.promptBodies).toEqual([expect.objectContaining({ text: "Мобильный вопрос" })]);
  await expect.poll(async () => (await chatScrollMetrics(page)).bottomGap).toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);

  // Смена сессии при чтении выше открывает конец и убирает кнопку/unread.
  await readChatAbove(page);
  await expect(jump).toBeVisible();
  await page.getByRole("button", { name: "Новая сессия OpenCode" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.opencode.sessionId")))
    .toBe("ses-2");
  await expect(jump).toHaveCount(0);
  expect((await chatScrollMetrics(page)).top).toBe(0);
});
