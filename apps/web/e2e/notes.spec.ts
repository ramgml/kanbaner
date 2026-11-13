import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 360, height: 740 };
let sequence = 0;

function title(prefix: string): string {
  sequence += 1;
  return `${prefix} ${Date.now()}-${sequence}`;
}

function noteId(page: Page): string {
  const id = new URL(page.url()).searchParams.get("note");
  expect(id).not.toBeNull();
  return id ?? "";
}

async function openNotes(page: Page): Promise<void> {
  await page.goto("/view/notes");
  await expect(page.getByTestId("notes-view")).toBeVisible();
}

async function createNote(page: Page, name: string, body = "Содержимое заметки"): Promise<string> {
  const empty = page.getByTestId("note-create-empty");
  if (await empty.isVisible()) await empty.click();
  else if (await page.getByRole("button", { name: "Создать заметку", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Создать заметку", exact: true }).click();
  } else await page.getByTestId("note-create-root").click();
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.getByTestId("note-title").fill(name);
  const editor = page.getByRole("textbox", { name: "Содержимое заметки" });
  await editor.click();
  await editor.pressSequentially(body, { delay: 5 });
  await expect(page.getByTestId("note-save-state")).toContainText(/Есть изменения|Сохраняем/);
  await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
    timeout: 15_000,
  });
  return noteId(page);
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

async function createTaskForNotes(page: Page, taskTitle: string): Promise<string> {
  const projectTitle = title("Проект заметок");
  await page.goto("/view/tasks");
  await expect(page.getByTestId("task-list-view")).toBeVisible();
  await expect(page.getByTestId("task-list-projects-loading")).toHaveText("Проекты загружены");
  await page.getByTestId("create-project-button").click();
  const form = page.getByTestId("project-form");
  await form.getByLabel("Название проекта", { exact: true }).fill(projectTitle);
  await form.getByRole("button", { name: "Создать проект" }).click();
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]project=/u);
  await page.getByTestId("create-task-button").click();
  await page.getByTestId("task-list-create-input").fill(taskTitle);
  await page.getByTestId("task-list-create-submit").click();
  await expect(page).toHaveURL(/[?&]task=/u);
  return new URL(page.url()).searchParams.get("task") ?? "";
}

test.describe("kanbaner.notes в production shell", () => {
  test("создаёт, редактирует, ищет и добавляет страницу в избранное", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const name = title("Первая заметка");
    const body = `Уникальное содержимое ${Date.now()} с **форматированием**`;
    await openNotes(page);
    const id = await createNote(page, name, body);

    await page.reload();
    await expect(page.getByTestId("note-title")).toHaveValue(name);
    await expect(page.getByRole("textbox", { name: "Содержимое заметки" })).toContainText(
      "Уникальное содержимое",
    );
    expect(noteId(page)).toBe(id);

    await page.getByTestId("note-favorite").click();
    await expect(page.getByTestId("note-favorite")).toHaveAttribute("aria-pressed", "true");
    await page.locator("[data-note-filter='favorite']").click();
    await expect(page.locator(`[data-note-select='${id}']`)).toBeVisible();

    await page.getByTestId("note-search-input").fill("Уникальное содержимое");
    await page.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(page.locator(`[data-note-search-result='${id}']`)).toBeVisible();
    await page.locator(`[data-note-search-result='${id}']`).click();
    await expect(page.getByTestId("note-title")).toHaveValue(name);
  });

  test("создаёт вложенные страницы и перемещает их без drag-and-drop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const parentName = title("Родитель");
    const childName = title("Дочерняя");
    await openNotes(page);
    const parentId = await createNote(page, parentName);
    await page.locator(`[data-note-tree-item='${parentId}']`).hover();
    await page.locator(`[data-note-add-child='${parentId}']`).click();
    await page.getByTestId("note-title").fill(childName);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
    const childId = noteId(page);

    await expect(page.locator("nav[aria-label='Путь к странице']")).toContainText(parentName);
    await page.getByTestId("note-parent").selectOption("");
    await expect(page.getByTestId("note-parent")).toHaveValue("");
    await page.reload();
    await page.locator(`[data-note-select='${childId}']`).click();
    await expect(page.getByTestId("note-parent")).toHaveValue("");
  });

  test("сохраняет локальное изображение и экспортирует самодостаточный Markdown", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Заметка с изображением"), "Изображение ниже");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.getByTestId("note-image-input").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(
      page
        .getByRole("textbox", { name: "Содержимое заметки" })
        .locator("img:not(.ProseMirror-separator)"),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("note-save-state")).toContainText(/Есть изменения|Сохраняем/);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
    await page.reload();
    await expect(
      page
        .getByRole("textbox", { name: "Содержимое заметки" })
        .locator("img:not(.ProseMirror-separator)"),
    ).toHaveAttribute("src", /^data:image\/png;base64,/);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("note-export").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    const markdown = await readFile(path ?? "", "utf8");
    expect(markdown).toContain("data:image/png;base64,");
    expect(markdown).not.toContain("attachment://");
  });

  test("связывает ResourceRef и открывает связанную заметку", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    const firstId = await createNote(page, title("Источник"));
    const secondId = await createNote(page, title("Связанная"));
    const target = page.getByRole("combobox", { name: "ResourceRef для связи" });
    await target.fill(`kanbaner.notes:note:${firstId}`);
    await page.getByTestId("note-link-add").click();
    await expect(
      page.locator(`[data-note-open-link='kanbaner.notes:note:${firstId}']`),
    ).toBeVisible();
    await page.locator(`[data-note-open-link='kanbaner.notes:note:${firstId}']`).click();
    await expect(page).toHaveURL(new RegExp(`note=${firstId}`));
    expect(noteId(page)).not.toBe(secondId);
  });

  test("создаёт связанную заметку из задачи через публичный slot", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const taskId = await createTaskForNotes(page, title("Задача с заметкой"));
    await expect(page.getByRole("heading", { name: "Связанные заметки" })).toBeVisible();
    await page.locator(`[data-related-note-create='kanbaner.tasks:task:${taskId}']`).click();
    await expect(page.getByTestId("notes-view")).toBeVisible();
    await expect(page.getByTestId("note-title")).toHaveValue("Заметка к задаче");

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Связанные заметки" })).toBeVisible();
    const noteRef = page.locator("[data-related-note-open^='kanbaner.notes:note:']");
    await expect(noteRef).toBeVisible();
    await noteRef.click();
    await expect(page.getByTestId("notes-view")).toBeVisible();
    await expect(page.getByTestId("note-title")).toHaveValue("Заметка к задаче");
  });

  test("подтверждает каскадное удаление по свежему subtree preview", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const parentName = title("Ветка удаления");
    const childName = title("Потомок удаления");
    await openNotes(page);
    const parentId = await createNote(page, parentName);
    await page.locator(`[data-note-tree-item='${parentId}']`).hover();
    await page.locator(`[data-note-add-child='${parentId}']`).click();
    await page.getByTestId("note-title").fill(childName);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
    const childId = noteId(page);

    await page.locator(`[data-note-select='${parentId}']`).click();
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("Страниц: 2");
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.locator(`[data-note-select='${parentId}']`)).toHaveCount(0);
    await expect(page.locator(`[data-note-select='${childId}']`)).toHaveCount(0);
  });

  test("сохраняет редактирование и отсутствие overflow на mobile 360", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openNotes(page);
    const name = title("Мобильная заметка");
    await createNote(page, name, "Мобильный текст без горизонтального overflow");
    await expectNoOverflow(page);
    await page.getByRole("button", { name: "Открыть дерево заметок" }).click();
    await expect(page.getByRole("complementary", { name: "Навигация по заметкам" })).toBeVisible();
    await page.getByRole("button", { name: "Закрыть дерево заметок" }).click();
    await expectNoOverflow(page);
  });
});
