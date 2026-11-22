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
  options?: { readonly sessionDelayMs?: number },
) {
  const state = {
    catalogCalls: 0,
    createdSessions: 0,
    modelInputs: [] as unknown[],
    previewPaths: [] as string[],
    previewHeaders: [] as Array<Record<string, string>>,
    sessionBodies: [] as unknown[],
    promptBodies: [] as Array<{
      text?: string;
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
        messages: [],
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
          files?: Array<{ name: string; mime: string; base64: string }>;
        },
      );
      const events = promptEvents?.(state.promptBodies.length) ?? [
        { kind: "tool", id: "message-1:call-1", name: "task_update", status: "running", text: "" },
        { kind: "tool", id: "message-1:call-1", status: "completed", text: "Обновлено" },
        { kind: "delta", id: "message-1:0", text: "Ответ " },
        { kind: "text", id: "message-1:0", text: "Ответ OpenCode" },
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
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: PREVIEW_PNG,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
      return;
    }
    if (/^\/api\/opencode\/session\/ses-\d+$/u.test(path) && method === "GET") {
      // Задержка только для canonical refresh после prompt: даёт проверить
      // optimistic-состояние до замены сообщений ответом сервера.
      if (state.promptBodies.length > 0 && options?.sessionDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
      }
      const body = {
        id: path.split("/").at(-1),
        title: "Kanbaner chat",
        agent: "kanbaner",
        model: catalog.defaultModel,
        messages: historyMessages ?? [
          { id: "user:message-0", role: "user", text: "Проверка" },
          {
            id: "tool:message-1:call-1",
            role: "tool",
            name: "task_update",
            status: "completed",
            text: "Обновлено",
          },
          { id: "assistant:message-1:0", role: "assistant", text: "Ответ OpenCode" },
        ],
      };
      state.sessionBodies.push(body);
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
  await expect(page.getByText("task_update", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Обновлено", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Сообщение OpenCode" })).toBeEnabled();
  expect(mock.promptBodies).toEqual([{ text: "Проверка" }]);

  await page.getByRole("button", { name: "Новая сессия OpenCode" }).click();
  await expect(
    page.getByText("Спросите о задачах, заметках или попросите изменить их."),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.opencode.sessionId")))
    .toBe("ses-2");
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
    {
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    },
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
    call === 1 ? [{ kind: "error", text: "Модель отклонила вложение" }] : [{ kind: "done" }],
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
  await expect(page.getByTestId("opencode-panel").getByRole("alert")).toContainText(
    "Модель отклонила вложение",
  );
  await expect(selected.getByText("notes.txt")).toBeVisible();

  await message.fill("Посмотри файл");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(selected).toHaveCount(0);
  expect(mock.promptBodies).toEqual([
    {
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    },
    {
      text: "Посмотри файл",
      files: [{ name: "notes.txt", mime: "text/plain", base64: "aGVsbG8=" }],
    },
  ]);
});
