import { expect, test, type Page } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 360, height: 740 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

/**
 * Минимальный mocked OpenCode Service: панель не должна запускать реальный
 * Service только ради проверки геометрии shell.
 */
async function mockOpenCodeService(page: Page): Promise<void> {
  const catalog = {
    providers: [{ id: "provider-1", name: "Provider One", activation: "enabled" }],
    models: [
      {
        id: "model-1",
        providerID: "provider-1",
        name: "Model One",
        type: "chat",
        variants: ["high"],
      },
    ],
    agents: [{ id: "kanbaner", name: "Kanbaner", description: null }],
    tools: [],
    defaultModel: { id: "model-1", providerID: "provider-1", variant: "high" },
  };

  await page.route("**/api/opencode/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data }),
      });

    if (path === "/api/opencode/catalog") {
      await json(catalog);
      return;
    }
    if (path === "/api/opencode/session" && request.method() === "POST") {
      await json({
        id: "ses-shell-1",
        title: "Kanbaner chat",
        agent: "kanbaner",
        model: catalog.defaultModel,
        messages: [],
      });
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
}

test.describe("адаптивный shell в реальном Chromium", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("на 360 px видна мобильная навигация, настройки доступны, overflow нет", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("mobile-navigation")).toBeVisible();
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
    await expect(page.locator("[data-app-sidebar-resizer]")).toBeHidden();
    await expect(page.getByRole("link", { name: "К содержимому" })).toBeAttached();
    await expect(
      page.getByTestId("mobile-navigation").getByRole("link", { name: "Обзор", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Проекты", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Плагины", exact: true })).toHaveCount(0);

    const settingsLink = page.getByTestId("settings-link-mobile");

    await expect(settingsLink).toBeVisible();
    await expect(settingsLink).toHaveAccessibleName("Настройки");
    await expect(settingsLink).toHaveAttribute("href", "/settings");

    await expectNoHorizontalOverflow(page);

    await settingsLink.click();
    await expect(page).toHaveURL(/\/settings$/u);
    await expect(page.getByRole("heading", { name: "Настройки", level: 1 })).toBeVisible();

    await page.getByRole("link", { name: "Открыть plugin manager" }).click();
    await expect(page).toHaveURL(/\/settings\/plugins$/u);
    await expect(page.getByRole("heading", { name: "Плагины", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Обновить" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/settings");
    await page.getByRole("link", { name: "Открыть обзор" }).click();
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole("heading", { name: "Обзор", level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("Tab и Enter открывают настройки через настоящую клавиатуру", async ({ page }) => {
    await page.goto("/");

    let reachedSettingsLink = false;

    for (let index = 0; index < 40; index += 1) {
      await page.keyboard.press("Tab");

      const focused = await page.evaluate(() => {
        const element = document.activeElement;

        return {
          tag: element?.tagName ?? null,
          text: element?.textContent?.trim() ?? "",
          href: element?.getAttribute("href") ?? null,
        };
      });

      if (focused.tag === "A" && focused.href === "/settings") {
        reachedSettingsLink = true;
        break;
      }
    }

    expect(reachedSettingsLink).toBe(true);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings$/u);
    await expect(page.getByRole("heading", { name: "Настройки", level: 1 })).toBeVisible();

    const overviewLink = page.getByRole("link", { name: "Открыть обзор" });

    await overviewLink.focus();
    await expect(overviewLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole("heading", { name: "Обзор", level: 1 })).toBeVisible();
  });

  test("убирает администрирование из sidebar и перенаправляет /plugins", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/");

    const sidebar = page.getByTestId("desktop-sidebar");

    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Плагины", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Обзор", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Проекты", exact: true })).toBeVisible();

    const settingsLink = sidebar.getByTestId("settings-link-desktop");

    await expect(settingsLink).toHaveAccessibleName("Настройки");
    await expect(settingsLink).toHaveAttribute("href", "/settings");
    await expect(sidebar.getByRole("link", { name: "Настройки", exact: true })).toHaveCount(1);

    await page.goto("/plugins");

    await expect(page).toHaveURL(/\/settings\/plugins$/u);
    await expect(page.getByRole("heading", { name: "Плагины", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Обновить" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("Space переключает плагин через Radix Switch", async ({ page }) => {
    await page.goto("/settings/plugins");

    // В registry есть и контрактный fixture-плагин, поэтому переключатель
    // выбирается по карточке конкретного плагина, а не по общему имени роли.
    const control = page
      .locator('[data-plugin-id="example.e2e-switch"]')
      .getByRole("switch", { name: /Включить плагин/ });

    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("aria-checked", "true");

    await control.focus();
    await page.keyboard.press("Space");

    await expect(control).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });
    await expectNoHorizontalOverflow(page);
  });

  test("меняет ширину глобального sidebar мышью и клавиатурой с сохранением", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/");

    const sidebar = page.getByTestId("desktop-sidebar");
    const handle = page.locator("[data-app-sidebar-resizer]");
    const line = page.locator("[data-app-sidebar-resizer-line]");
    const width = (): Promise<number> =>
      sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));

    await expect(handle).toBeVisible();
    await expect(handle).toHaveCSS("cursor", "col-resize");
    await expect(line).toBeVisible();
    await expect(handle).toHaveAttribute("aria-valuenow", "288");
    await expect.poll(width).toBe(288);

    const box = await handle.boundingBox();
    if (box === null) throw new Error("Resize handle не найден");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY, { steps: 8 });
    await page.mouse.up();

    await expect.poll(width).toBe(408);
    await expect(handle).toHaveAttribute("aria-valuenow", "408");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.ui.sidebarWidth")))
      .toBe("408");
    await expectNoHorizontalOverflow(page);

    await page.reload();
    await expect.poll(width).toBe(408);
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "424");
    await page.keyboard.press("Home");
    await expect.poll(width).toBe(240);
    await page.keyboard.press("End");
    await expect.poll(width).toBe(560);
    await handle.dblclick();
    await expect.poll(width).toBe(288);

    await page.setViewportSize({ width: 800, height: DESKTOP_VIEWPORT.height });
    await expect(handle).toHaveAttribute("aria-valuemax", "384");
    await page.keyboard.press("End");
    await expect.poll(width).toBe(384);
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect.poll(width).toBe(384);
    await handle.dblclick();
    await expect.poll(width).toBe(288);
  });

  test("меняет ширину OpenCode-панели мышью и клавиатурой с сохранением", async ({ page }) => {
    await mockOpenCodeService(page);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/");
    await page.getByTestId("opencode-open").click();

    const sidebar = page.getByTestId("opencode-sidebar");
    const handle = page.locator("[data-app-assistant-resizer]");
    const width = (): Promise<number> =>
      sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));

    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId("opencode-close")).toBeFocused();
    await expect(handle).toBeVisible();
    await expect(handle).toHaveCSS("cursor", "col-resize");
    await expect(handle).toHaveAttribute("aria-valuemin", "320");
    await expect(handle).toHaveAttribute("aria-valuenow", "384");
    await expect.poll(width).toBe(384);

    const box = await handle.boundingBox();
    if (box === null) throw new Error("Resize handle OpenCode не найден");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 120, startY, { steps: 8 });
    await page.mouse.up();

    await expect.poll(width).toBe(504);
    await expect(handle).toHaveAttribute("aria-valuenow", "504");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.opencode.panelWidth")))
      .toBe("504");
    await expectNoHorizontalOverflow(page);

    await page.reload();
    await expect(sidebar).toBeVisible();
    await expect.poll(width).toBe(504);
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "520");
    await page.keyboard.press("Home");
    await expect.poll(width).toBe(320);
    await page.keyboard.press("End");
    await expect.poll(width).toBe(640);
    await handle.dblclick();
    await expect.poll(width).toBe(384);

    await page.setViewportSize({ width: 1024, height: DESKTOP_VIEWPORT.height });
    await expect(handle).toHaveAttribute("aria-valuemax", "384");
    await page.keyboard.press("End");
    await expect.poll(width).toBe(384);
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 900, height: DESKTOP_VIEWPORT.height });
    await expect(handle).toHaveAttribute("aria-valuemax", "320");
    await expect.poll(width).toBe(320);
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveCount(0);
    await expect(page.getByTestId("opencode-open")).toBeVisible();

    await page.getByTestId("opencode-open").click();
    await expect(sidebar).toBeVisible();
    await page.getByTestId("opencode-close").click();
    await expect(sidebar).toHaveCount(0);
  });

  test("mobile OpenCode-панель остаётся fullscreen без resizer и overflow", async ({ page }) => {
    await mockOpenCodeService(page);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/");
    await page.getByTestId("opencode-open").click();

    const sidebar = page.getByTestId("opencode-sidebar");
    const handle = page.locator("[data-app-assistant-resizer]");

    await expect(sidebar).toBeVisible();
    await expect(handle).toBeHidden();

    const geometry = await sidebar.evaluate((element) => ({
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height),
      inlineWidth: element.style.width,
    }));
    expect(geometry).toEqual({ width: 360, height: 740, inlineWidth: "" });
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveCount(0);
  });

  test("прокручивает содержимое project sidebar при малой высоте без наложения на footer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 320 });
    await page.goto("/view/projects?entry=1");
    await page.getByTestId("projects-create-button").click();

    const sidebar = page.getByTestId("projects-sidebar");
    const footer = page.getByText("Локальный режим", { exact: true });
    await expect(sidebar).toHaveCSS("overflow-y", "auto");
    await expect(page.getByTestId("projects-create-panel")).toBeVisible();
    await expect(footer).toBeVisible();

    const geometry = await sidebar.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    const footerTop = await footer.evaluate((element) =>
      Math.round(element.getBoundingClientRect().top),
    );

    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(Math.round(geometry.bottom)).toBeLessThanOrEqual(footerTop);
    await expectNoHorizontalOverflow(page);
  });
});
