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

async function expectTitleFits(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const metrics = await page.getByTestId("note-title").evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        const style = getComputedStyle(field);
        return {
          tag: field.tagName,
          scrollWidth: field.scrollWidth,
          clientWidth: field.clientWidth,
          scrollHeight: field.scrollHeight,
          clientHeight: field.clientHeight,
          height: field.getBoundingClientRect().height,
          lineHeight:
            Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2,
          overflowX: style.overflowX,
        };
      });
      return {
        tag: metrics.tag,
        overflowX: metrics.overflowX,
        fitsWidth: metrics.scrollWidth <= metrics.clientWidth + 1,
        fitsHeight: metrics.scrollHeight <= metrics.clientHeight + 1,
        wrapped: metrics.height > metrics.lineHeight * 1.8,
        height: metrics.height,
      };
    })
    .toMatchObject({
      tag: "TEXTAREA",
      overflowX: "hidden",
      fitsWidth: true,
      fitsHeight: true,
      wrapped: true,
    });
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

async function createTaskForNotes(page: Page, taskTitle: string): Promise<string> {
  const projectTitle = title("Проект заметок");
  await createProject(page, projectTitle);
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

  test("не обрезает название скрытыми действиями и показывает их по hover и focus", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    const shortName = "Без названия";
    const id = await createNote(page, shortName);
    const row = page.locator(`[data-note-tree-item='${id}']`);
    const label = page.locator(`[data-note-title='${id}']`);
    await expect(label).toHaveText(shortName);

    // Раньше четыре скрытые кнопки занимали ширину, и «Без названия» обрезалось.
    await expect
      .poll(() => label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true);
    const share = await page.evaluate((noteId) => {
      const sidebar = document.querySelector("aside[aria-label='Навигация по заметкам']");
      const title = document.querySelector(`[data-note-title='${noteId}']`);
      if (sidebar === null || title === null) return 0;
      return title.getBoundingClientRect().width / sidebar.getBoundingClientRect().width;
    }, id);
    expect(share).toBeGreaterThan(0.6);

    // Длинное название обрезается только при реальной нехватке ширины.
    const longId = await createNote(page, `${title("Очень длинное название страницы")} и ещё`);
    await expect
      .poll(() =>
        page
          .locator(`[data-note-title='${longId}']`)
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      )
      .toBe(true);
    await expectNoOverflow(page);

    const actions = page.locator(`[data-note-actions='${id}']`);
    const opacity = (): Promise<string> =>
      actions.evaluate((element) => getComputedStyle(element).opacity);

    await page.mouse.move(5, 5);
    await expect.poll(opacity).toBe("0");
    await row.hover();
    await expect.poll(opacity).toBe("1");
    await expect(page.locator(`[data-note-add-child='${id}']`)).toBeVisible();
    await expect(page.locator(`[data-note-delete='${id}']`)).toBeVisible();
    await expectNoOverflow(page);

    // Скрытие возвращается после ухода курсора, фокус снова показывает действия.
    await page.mouse.move(5, 5);
    await expect.poll(opacity).toBe("0");
    await page.locator(`[data-note-delete='${id}']`).focus();
    await expect.poll(opacity).toBe("1");
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

  test("показывает slash-меню, side menu и formatting toolbar", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Блочный редактор"), "");
    const editor = page.getByRole("textbox", { name: "Содержимое заметки" });

    await editor.click();
    await page.keyboard.type("/");
    const headingOption = page.getByRole("option", { name: /Заголовок 1 уровня/u });
    await expect(headingOption).toBeVisible();
    await headingOption.click();
    await page.keyboard.type("Раздел");
    await expect(editor.locator("h1")).toHaveText("Раздел");

    await editor.locator(".bn-block-outer").first().hover();
    await expect(page.getByRole("button", { name: "Добавить блок" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Открыть меню блока" })).toBeVisible();

    await editor.locator("h1").click();
    await page.keyboard.press("Control+A");
    await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();
    await page.getByRole("button", { name: "Жирный" }).click();
    await expect(editor.locator("h1 strong")).toContainText("Раздел");

    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
  });

  test("сохраняет вложенность списка, созданную Tab", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Вложенные блоки"), "");
    const editor = page.getByRole("textbox", { name: "Содержимое заметки" });

    await editor.click();
    await page.keyboard.type("- Родитель");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Потомок");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("note-export").click();
    const download = await downloadPromise;
    const markdown = await readFile((await download.path()) ?? "", "utf8");
    expect(markdown).toContain("* Родитель");
    expect(markdown).toContain("  * Потомок");
  });

  test("выбирает проект по названию, открывает и удаляет связь", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const projectTitle = title("Проект связи");
    const projectId = await createProject(page, projectTitle);
    await openNotes(page);
    const noteName = title("Заметка со связью");
    const id = await createNote(page, noteName);

    await page.getByTestId("note-link-picker-trigger").click();
    const search = page.getByRole("combobox", { name: "Поиск проекта или задачи" });
    await search.fill("совсем ничего не найдено");
    await expect(page.getByTestId("note-link-picker-no-results")).toBeVisible();

    await search.fill(projectTitle);
    const option = page.getByRole("option", { name: new RegExp(projectTitle, "u") });
    await expect(option).toBeVisible();
    await expect(option).toContainText("Проект");
    await search.press("Enter");
    await expect(page.getByTestId("note-link-picker")).toHaveCount(0);

    const link = page.locator(`[data-note-open-link='kanbaner.tasks:project:${projectId}']`);
    await expect(link).toBeVisible();
    await expect(link).toContainText(projectTitle);
    await link.click();
    await expect(page).toHaveURL(/resource=kanbaner\.tasks%3Aproject%3A/u);

    await page.goto(`/view/notes?note=${id}`);
    await expect(page.getByTestId("note-title")).toHaveValue(noteName);
    const restored = page.locator(`[data-note-open-link='kanbaner.tasks:project:${projectId}']`);
    await expect(restored).toBeVisible();
    await page.getByRole("button", { name: `Удалить связь с ${projectTitle}` }).click();
    await expect(restored).toHaveCount(0);
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

  test("переносит длинный заголовок заметки без внутреннего и внешнего overflow", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    const longName = `${title("Длинный заголовок")} ${"сверхдлинноесловобезпробелов".repeat(3)}`;
    expect(longName.length).toBeLessThanOrEqual(200);
    await createNote(page, longName, "Текст под длинным заголовком");

    const field = page.getByTestId("note-title");
    await expect(field).toHaveValue(longName);
    await expectTitleFits(page);
    await expectNoOverflow(page);
    const desktopHeight = await field.evaluate((element) => element.getBoundingClientRect().height);

    // Enter завершает редактирование, но не добавляет перевод строки:
    // домен запрещает многострочные заголовки.
    await field.press("Enter");
    await expect(field).not.toBeFocused();
    await expect(field).toHaveValue(longName);

    // На узком экране текст переносится чаще, и поле становится выше.
    await page.setViewportSize(MOBILE);
    await expectTitleFits(page);
    await expect
      .poll(() => field.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(desktopHeight);
    await expectNoOverflow(page);

    // После перезагрузки высота восстанавливается из загруженного заголовка.
    await page.reload();
    await expect(field).toHaveValue(longName);
    await expectTitleFits(page);
    await expectNoOverflow(page);
  });

  test("сохраняет редактирование и отсутствие overflow на mobile 360", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openNotes(page);
    const name = title("Мобильная заметка");
    const id = await createNote(page, name, "Мобильный текст без горизонтального overflow");
    await expectNoOverflow(page);
    await page.getByRole("button", { name: "Открыть дерево заметок" }).click();
    await expect(page.getByRole("complementary", { name: "Навигация по заметкам" })).toBeVisible();

    // На touch действия видны без hover, название при этом остаётся читаемым.
    const actions = page.locator(`[data-note-actions='${id}']`);
    await expect
      .poll(() => actions.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    const addChild = page.locator(`[data-note-add-child='${id}']`);
    await expect(addChild).toBeVisible();
    await expect
      .poll(() => addChild.evaluate((element) => getComputedStyle(element).pointerEvents))
      .not.toBe("none");
    await expect(page.locator(`[data-note-title='${id}']`)).toHaveText(name);
    await expectNoOverflow(page);

    await page.getByRole("button", { name: "Закрыть дерево заметок" }).click();
    await page.getByTestId("note-link-picker-trigger").click();
    await expect(page.getByTestId("note-link-picker")).toBeVisible();
    await expectNoOverflow(page);

    // Действие создаёт вложенную страницу по touch без hover.
    await page.getByRole("button", { name: "Открыть дерево заметок" }).click();
    await page.locator(`[data-note-add-child='${id}']`).click();
    await expect(page.getByTestId("note-title")).toHaveValue("Без названия");
    await expectNoOverflow(page);
  });
});
