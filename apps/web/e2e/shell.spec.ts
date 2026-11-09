import { expect, test } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 360, height: 740 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

test.describe("адаптивный shell в реальном Chromium", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("на 360 px видна мобильная навигация, настройки доступны, overflow нет", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("mobile-navigation")).toBeVisible();
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
    await expect(page.getByRole("link", { name: "К содержимому" })).toBeAttached();
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
  });

  test("убирает администрирование из sidebar и перенаправляет /plugins", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/");

    const sidebar = page.getByTestId("desktop-sidebar");

    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Плагины", exact: true })).toHaveCount(0);
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
});
