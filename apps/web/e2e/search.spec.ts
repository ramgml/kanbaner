import { expect, test, type Page } from "@playwright/test";

const MOBILE = { width: 360, height: 740 };
let sequence = 0;

function title(prefix: string): string {
  sequence += 1;
  return `${prefix} ${Date.now()}-${sequence}`;
}

async function createProject(page: Page, projectTitle: string): Promise<string> {
  await page.goto("/view/tasks");
  await expect(page.getByTestId("task-list-view")).toBeVisible();
  await expect(page.getByTestId("task-list-projects-loading")).toHaveText("Проекты загружены");
  await page.getByTestId("create-project-button").click();
  const form = page.getByTestId("project-form");

  await form.getByLabel("Название проекта", { exact: true }).fill(projectTitle);
  await form.getByRole("button", { name: "Создать проект" }).click();
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]project=/u);

  return new URL(page.url()).searchParams.get("project") ?? "";
}

async function createTask(page: Page, taskTitle: string): Promise<string> {
  await page.getByTestId("create-task-button").click();
  await page.getByTestId("task-list-create-input").fill(taskTitle);
  await page.getByTestId("task-list-create-submit").click();
  await expect(page.getByTestId("task-list-create-panel")).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]task=/u);

  return new URL(page.url()).searchParams.get("task") ?? "";
}

async function openSearch(page: Page): Promise<void> {
  await page.goto("/view/search");
  await expect(page.getByTestId("search-view")).toBeVisible();
  await expect(page.getByTestId("search-kind")).toBeVisible();
}

async function submitSearch(page: Page, text: string): Promise<void> {
  await page.getByTestId("search-input").fill(text);
  await page.getByRole("button", { name: /Найти|Ищу/u }).click();
}

async function expectNoOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    width: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));

  expect(metrics.document).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.width + 1);
}

test.describe("kanbaner.search в production shell", () => {
  test("находит задачу, фильтрует по типу, проекту и статусу", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const projectId = await createProject(page, title("Проект поиска"));
    const marker = title("Уникальный маркер");
    const taskId = await createTask(page, `${marker} задача`);
    const taskRef = `kanbaner.tasks:task:${taskId}`;

    await openSearch(page);
    await submitSearch(page, marker);

    const results = page.getByTestId("search-results");

    await expect(results).toBeVisible();
    await expect(page.locator(`[data-search-hit='${taskRef}']`)).toContainText(marker);
    await expectNoOverflow(page);

    await page.getByTestId("search-kind").selectOption("task");
    await submitSearch(page, marker);

    const hits = page.locator("[data-search-hit]");

    await expect(hits.first()).toBeVisible();
    await expect(hits.filter({ hasNotText: "kanbaner.tasks:task:" })).toHaveCount(0);

    await page.getByTestId("search-facet-projectId").selectOption(projectId);
    await page.getByTestId("search-facet-status").selectOption("todo");
    await submitSearch(page, marker);

    await expect(page.locator(`[data-search-hit='${taskRef}']`)).toBeVisible();
    await expect(page.getByTestId("search-empty")).toHaveCount(0);
    await expectNoOverflow(page);

    // Результат — настоящая кнопка: клавиатурный Enter открывает ресурс через
    // доменный resource-opener, а не через скрытый DOM-хак поиска.
    const hit = page.locator(`[data-search-hit='${taskRef}']`);

    await hit.focus();
    await hit.press("Enter");

    await expect(page).toHaveURL(/\/view\/kanban/u);
    const url = new URL(page.url());

    expect(url.searchParams.get("task") ?? taskId).toBe(taskId);
  });

  test("показывает пустую выдачу и не создаёт overflow на мобильном", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openSearch(page);
    await submitSearch(page, title("Нет совпадений"));

    await expect(page.getByTestId("search-empty")).toContainText("Ничего не найдено");
    await expect(page.getByTestId("search-error")).toHaveCount(0);
    await expectNoOverflow(page);
  });
});
