import { expect, test } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 360, height: 740 };

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

  test("на 360 px видна мобильная навигация, desktop sidebar скрыт, overflow нет", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("mobile-navigation")).toBeVisible();
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
    await expect(page.getByRole("link", { name: "К содержимому" })).toBeAttached();

    await expectNoHorizontalOverflow(page);

    await page.goto("/plugins");

    await expect(page.getByRole("heading", { name: "Плагины", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Обновить" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("Tab и Enter открывают раздел через настоящую клавиатуру", async ({ page }) => {
    await page.goto("/");

    let reachedPluginsLink = false;

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

      if (focused.tag === "A" && focused.href === "/plugins" && focused.text.includes("Плагины")) {
        reachedPluginsLink = true;
        break;
      }
    }

    expect(reachedPluginsLink).toBe(true);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/plugins$/);
    await expect(page.getByRole("heading", { name: "Плагины", level: 1 })).toBeVisible();
  });

  test("Space переключает плагин через Radix Switch", async ({ page }) => {
    await page.goto("/plugins");

    const control = page.getByRole("switch", { name: /Включить плагин/ });

    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("aria-checked", "true");

    await control.focus();
    await page.keyboard.press("Space");

    await expect(control).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });
    await expectNoHorizontalOverflow(page);
  });
});
