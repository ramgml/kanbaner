import { expect, test, type Page } from "@playwright/test";

/**
 * Fixture-плагин в реальном production shell.
 *
 * Проверка идёт только через публичное поведение: серверный layout передаёт
 * UI-метаданные в клиентский реестр, кнопка вызывает server action, а action
 * выполняет ту же команду/запрос через общий OperationBus. Тест не обращается
 * к SQLite, внутренним модулям ядра или DOM другого плагина.
 */
async function readOperationResult(page: Page, contributionId: string): Promise<unknown> {
  const result = page.getByTestId(`plugin-result-${contributionId}`);

  await expect(result).toBeVisible();

  return JSON.parse((await result.textContent()) ?? "null") as unknown;
}

test.describe("fixture plugin в production shell", () => {
  test("показывает UI-вклад активного fixture-плагина", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("plugin-contribution-kanbaner.fixture.panel")).toBeVisible();
    await expect(page.getByTestId("plugin-contribution-kanbaner.fixture.list-panel")).toBeVisible();
    await expect(page.getByTestId("safe-mode-panel")).toHaveCount(0);
  });

  test("выполняет команду через общий composition и server action", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("plugin-operation-kanbaner.fixture.panel").click();

    const result = (await readOperationResult(page, "kanbaner.fixture.panel")) as {
      readonly ok: boolean;
      readonly data?: { readonly id?: string; readonly title?: string };
    };

    expect(result.ok).toBe(true);
    expect(result.data?.id).toEqual(expect.stringMatching(/^item-/u));
    expect(result.data?.title).toBe("Fixture item");

    await page.reload();

    await expect(page.getByTestId("plugin-contribution-kanbaner.fixture.panel")).toBeVisible();
  });

  test("выполняет запрос и видит ранее созданную запись после перезагрузки", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("plugin-operation-kanbaner.fixture.panel").click();
    const created = (await readOperationResult(page, "kanbaner.fixture.panel")) as {
      readonly ok: boolean;
      readonly data?: { readonly id?: string };
    };

    expect(created.ok).toBe(true);

    await page.getByTestId("plugin-operation-kanbaner.fixture.list-panel").click();
    const listed = (await readOperationResult(page, "kanbaner.fixture.list-panel")) as {
      readonly ok: boolean;
      readonly data?: { readonly items?: readonly { readonly id: string }[] };
    };

    expect(listed.ok).toBe(true);
    expect(listed.data?.items?.map((item) => item.id)).toContain(created.data?.id);

    await page.reload();
    await page.getByTestId("plugin-operation-kanbaner.fixture.list-panel").click();

    const reloaded = (await readOperationResult(page, "kanbaner.fixture.list-panel")) as {
      readonly ok: boolean;
      readonly data?: { readonly items?: readonly { readonly id: string }[] };
    };

    expect(reloaded.ok).toBe(true);
    expect(reloaded.data?.items?.map((item) => item.id)).toContain(created.data?.id);
  });

  test("fixture активен в manager и не включает safe mode", async ({ page }) => {
    await page.goto("/plugins");

    const card = page.locator('[data-plugin-id="kanbaner.fixture"]');

    await expect(card).toBeVisible();
    await expect(card).toContainText("Contract Fixture");
    await expect(page.getByTestId("safe-mode-panel")).toHaveCount(0);
  });
});
