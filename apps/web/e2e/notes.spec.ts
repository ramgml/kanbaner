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

const INLINE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Собирает console error/warning и pageerror. Проверка нужна для lifecycle
 * BlockNote: сериализация React inline content внутри useEffect раньше давала
 * flushSync error и warning «ReactInlineContentSpec: renderHTML() failed».
 */
function trackPageConsole(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      messages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  return messages;
}

function expectNoLifecycleSerializationMessages(messages: readonly string[]): void {
  const serializationMessages = messages.filter((message) =>
    /flushSync|ReactInlineContentSpec/iu.test(message),
  );
  expect(serializationMessages).toEqual([]);
}

/**
 * Вставляет inline image (image внутри strong) настоящим HTML-paste.
 *
 * Используется BlockNote-обёртка `data-inline-content-type`: сырой `<img>` в
 * external HTML BlockNote не парсит в inline content. `imageUrl` — data URL
 * уже загруженного через UI вложения, который notes-view конвертирует обратно
 * в канонический `attachment://` при сохранении.
 */
async function pasteInlineImage(
  page: Page,
  imageUrl: string,
  prefix: string,
  suffix: string,
): Promise<void> {
  await page.evaluate(
    ({ url, before, after }) => {
      const target = document.querySelector<HTMLElement>(
        "[role='textbox'][aria-label='Содержимое заметки']",
      );
      if (target === null) throw new Error("Редактор заметки не найден");
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(
        "text/html",
        `<p>${before} <strong><span data-inline-content-type="inlineImage" data-url="${url}" data-name="схема"></span></strong> ${after}</p>`,
      );
      dataTransfer.setData("text/plain", `${before} ${after}`);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: dataTransfer });
      target.dispatchEvent(event);
    },
    { url: imageUrl, before: prefix, after: suffix },
  );
}

/**
 * Создаёт заметку с настоящим attachment и inline image, дожидаясь сохранения.
 *
 * Сервер принимает только attachment:// и HTTP(S) URL, поэтому сначала файл
 * загружается через UI, а inline image ссылается на его data URL из cache:
 * notes-view канонизирует его обратно в attachment://.
 */
async function createInlineImageNote(
  page: Page,
  name: string,
  prefix = "До",
  suffix = "после",
): Promise<string> {
  const id = await createNote(page, name, "");
  await page.getByTestId("note-image-input").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(INLINE_IMAGE_BASE64, "base64"),
  });

  const editor = page.getByRole("textbox", { name: "Содержимое заметки" });
  const blockImage = editor.locator("img:not(.ProseMirror-separator)").first();
  await expect(blockImage).toBeVisible({ timeout: 15_000 });
  const uploadedImageUrl = await blockImage.getAttribute("src");
  expect(uploadedImageUrl).toMatch(/^data:image\/png;base64,/u);
  if (uploadedImageUrl === null) throw new Error("У загруженного изображения нет src");
  await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
    timeout: 15_000,
  });

  await pasteInlineImage(page, uploadedImageUrl, prefix, suffix);
  await expect(editor.locator("[data-inline-content-type='inlineImage'] img")).toBeVisible();
  await expect(editor).toContainText(prefix);
  await expect(editor).toContainText(suffix);
  await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
    timeout: 15_000,
  });
  return id;
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

type NoteDropZone = "before" | "inside" | "after" | "root";

/**
 * Запускает HTML5 drag строки дерева и хранит DataTransfer между шагами.
 *
 * Реальный mouse-drag HTML5 в Playwright Chromium не воспроизводится (см.
 * KAN-045), поэтому сценарий проверяет те же dragstart/dragover/drop
 * обработчики синтетическими DragEvent с настоящим DataTransfer.
 */
async function beginNoteDrag(page: Page, sourceId: string): Promise<void> {
  const row = page.locator(`[data-note-tree-item='${sourceId}']`);
  // Предыдущий move мог ещё не завершиться: пока pending, DnD выключен.
  await expect(row).toHaveAttribute("draggable", "true");
  await expect(row).not.toHaveAttribute("data-note-move-pending", "true");
  await page.evaluate((id) => {
    const source = document.querySelector<HTMLElement>(`[data-note-tree-item='${id}']`);
    if (source === null) throw new Error(`Нет строки заметки ${id}`);
    const dataTransfer = new DataTransfer();
    (window as unknown as { __noteDrag?: DataTransfer }).__noteDrag = dataTransfer;
    source.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
    );
  }, sourceId);
  await expect(page.locator(`[data-note-tree-item='${sourceId}']`)).toHaveAttribute(
    "data-note-dragging",
    "true",
  );
}

async function noteDragOver(
  page: Page,
  targetId: string | null,
  zone: NoteDropZone,
): Promise<void> {
  await page.evaluate(
    ({ id, targetZone }) => {
      const dataTransfer = (window as unknown as { __noteDrag?: DataTransfer }).__noteDrag;
      if (dataTransfer === undefined) throw new Error("Drag не начат");
      const target =
        targetZone === "root"
          ? document.querySelector<HTMLElement>("[data-note-root-drop]")
          : document.querySelector<HTMLElement>(`[data-note-tree-item='${id}']`);
      if (target === null) throw new Error(`Нет цели drop ${String(id)}`);
      const rect = target.getBoundingClientRect();
      const clientY =
        targetZone === "before"
          ? rect.top + 2
          : targetZone === "after"
            ? rect.bottom - 2
            : rect.top + rect.height / 2;
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientY }),
      );
    },
    { id: targetId, targetZone: zone },
  );
}

async function finishNoteDrag(
  page: Page,
  sourceId: string,
  targetId: string | null,
  zone: NoteDropZone,
): Promise<void> {
  await page.evaluate(
    ({ source, id, targetZone }) => {
      const dataTransfer = (window as unknown as { __noteDrag?: DataTransfer }).__noteDrag;
      if (dataTransfer === undefined) throw new Error("Drag не начат");
      const target =
        targetZone === "root"
          ? document.querySelector<HTMLElement>("[data-note-root-drop]")
          : document.querySelector<HTMLElement>(`[data-note-tree-item='${id}']`);
      if (target === null) throw new Error(`Нет цели drop ${String(id)}`);
      const rect = target.getBoundingClientRect();
      const clientY =
        targetZone === "before"
          ? rect.top + 2
          : targetZone === "after"
            ? rect.bottom - 2
            : rect.top + rect.height / 2;
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientY }),
      );
      document
        .querySelector<HTMLElement>(`[data-note-tree-item='${source}']`)
        ?.dispatchEvent(
          new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }),
        );
      delete (window as unknown as { __noteDrag?: DataTransfer }).__noteDrag;
    },
    { source: sourceId, id: targetId, targetZone: zone },
  );
}

/** Дожидается, что строки идут сверху вниз в указанном порядке. */
async function expectNoteRowsInOrder(page: Page, ids: readonly string[]): Promise<void> {
  await expect
    .poll(async () => {
      const positions: number[] = [];
      for (const id of ids) {
        const box = await page.locator(`[data-note-tree-item='${id}']`).boundingBox();
        if (box === null) return false;
        positions.push(box.y);
      }
      return positions.every((y, index) => index === 0 || y > (positions[index - 1] ?? 0));
    })
    .toBe(true);
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

  test("не сериализует BlockNote в lifecycle и быстро переключает заметки с inline image", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const consoleMessages = trackPageConsole(page);
    await openNotes(page);

    const firstId = await createInlineImageNote(page, title("Inline image"));
    expectNoLifecycleSerializationMessages(consoleMessages);

    // Повторное открытие запускает initial useEffect с inline image: именно
    // этот путь раньше сериализовал документ внутри React lifecycle.
    await page.reload();
    const reloadedEditor = page.getByRole("textbox", { name: "Содержимое заметки" });
    await expect(
      reloadedEditor.locator("[data-inline-content-type='inlineImage'] img"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(reloadedEditor).toContainText("До");
    await expect(reloadedEditor).toContainText("после");
    expectNoLifecycleSerializationMessages(consoleMessages);

    const plainId = await createNote(page, title("Без inline image"), "Промежуточная заметка");
    const finalId = await createInlineImageNote(
      page,
      title("Финальная inline image"),
      "Финальная",
      "заметка",
    );

    // Возвращаемся на первую inline-заметку и дожидаемся готовности, чтобы
    // быстрая последовательность начиналась именно с inline.
    await page.locator(`[data-note-select='${firstId}']`).click();
    const editorRoot = page.locator(".kanbaner-note-editor");
    await expect(editorRoot).toHaveAttribute("data-note-id", firstId);
    await expect(editorRoot).toHaveAttribute("data-ready", "true");
    await expect(
      page
        .getByRole("textbox", { name: "Содержимое заметки" })
        .locator("[data-inline-content-type='inlineImage'] img"),
    ).toBeVisible();

    // Два разных перехода запускаются в одном task без ожидания между ними:
    // inline → plain → inline. Побеждает последняя заметка, а загрузка
    // промежуточной не должна применить её документ или редактор.
    await page.evaluate(
      ({ plain, final }) => {
        document.querySelector<HTMLElement>(`[data-note-select='${plain}']`)?.click();
        document.querySelector<HTMLElement>(`[data-note-select='${final}']`)?.click();
      },
      { plain: plainId, final: finalId },
    );

    await expect(page).toHaveURL(new RegExp(`[?&]note=${finalId}(?:&|$)`));
    const finalEditor = page.getByRole("textbox", { name: "Содержимое заметки" });
    await expect(editorRoot).toHaveAttribute("data-note-id", finalId);
    await expect(editorRoot).toHaveAttribute("data-ready", "true");
    await expect(finalEditor.locator("[data-inline-content-type='inlineImage'] img")).toBeVisible();
    await expect(finalEditor).toContainText("Финальная");
    await expect(finalEditor).toContainText("заметка");
    await expect(finalEditor).not.toContainText("Промежуточная заметка");

    expectNoLifecycleSerializationMessages(consoleMessages);
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

  test("сохраняет изображение, выбранное из slash-меню", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Заметка с picker"), "");
    const editor = page.getByRole("textbox", { name: "Содержимое заметки" });

    await editor.click();
    await page.keyboard.type("/");
    const imageOption = page.getByRole("option", { name: /Картинка/u });
    await expect(imageOption).toBeVisible();

    // Пункт меню должен открыть настоящий файловый picker, а не создать
    // пустой image-блок с отдельной панелью загрузки.
    const fileChooserPromise = page.waitForEvent("filechooser");
    await imageOption.click();
    const fileChooser = await fileChooserPromise;
    expect(fileChooser.isMultiple()).toBe(false);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await fileChooser.setFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: png,
    });

    await expect(editor.locator("img:not(.ProseMirror-separator)")).toBeVisible({
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
  });

  test("не создаёт пустой image при отмене picker из меню «+»", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Отмена picker"), "");
    const editor = page.getByRole("textbox", { name: "Содержимое заметки" });

    await editor.locator(".bn-block-outer").first().hover();
    await page.getByRole("button", { name: "Добавить блок" }).click();
    const imageOption = page.getByRole("option", { name: /Картинка/u });
    await expect(imageOption).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await imageOption.click();
    const fileChooser = await fileChooserPromise;
    // Пустой выбор соответствует закрытию системного picker без файла.
    await fileChooser.setFiles([]);

    await expect(editor.locator("[data-content-type='image']")).toHaveCount(0);
    await expect(editor.locator("img:not(.ProseMirror-separator)")).toHaveCount(0);
    await expect(editor.locator("[data-content-type='paragraph']")).toHaveCount(1);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
  });

  test("не меняет непустой текст при отмене picker из slash-меню", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Отмена picker в тексте"), "Текст");
    const editor = page.getByRole("textbox", { name: "Содержимое заметки" });
    const paragraph = editor.locator("[data-content-type='paragraph']").first();

    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.type("/");
    const imageOption = page.getByRole("option", { name: /Картинка/u });
    await expect(imageOption).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await imageOption.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles([]);

    await expect(paragraph).toHaveText("Текст");
    await expect(editor.locator("[data-content-type='paragraph']")).toHaveCount(1);
    await expect(editor.locator("[data-content-type='image']")).toHaveCount(0);
    await expect(editor.locator("img:not(.ProseMirror-separator)")).toHaveCount(0);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
  });

  test("не меняет пустые heading и список при отмене picker из slash-меню", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Отмена picker в блоках"), "");
    const editor = page.getByRole("textbox", { name: "Содержимое заметки" });

    await editor.click();
    await page.keyboard.type("/");
    await page.getByRole("option", { name: /^Заголовок 1 уровня/u }).click();
    const heading = editor.locator("[data-content-type='heading']");
    await expect(heading).toHaveCount(1);

    await page.keyboard.type("/");
    const headingImageOption = page.getByRole("option", { name: /Картинка/u });
    await expect(headingImageOption).toBeVisible();
    const headingChooserPromise = page.waitForEvent("filechooser");
    await headingImageOption.click();
    await (await headingChooserPromise).setFiles([]);

    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveText("");
    await expect(editor.locator("[data-content-type='image']")).toHaveCount(0);

    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await page.getByRole("option", { name: "Маркированный список" }).click();
    const listItem = editor.locator("[data-content-type='bulletListItem']");
    await expect(listItem).toHaveCount(1);

    await page.keyboard.type("/");
    const listImageOption = page.getByRole("option", { name: /Картинка/u });
    await expect(listImageOption).toBeVisible();
    const listChooserPromise = page.waitForEvent("filechooser");
    await listImageOption.click();
    await (await listChooserPromise).setFiles([]);

    await expect(listItem).toHaveCount(1);
    await expect(listItem).toHaveText("");
    await expect(editor.locator("[data-content-type='image']")).toHaveCount(0);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
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

    // Без DnD вложенную страницу можно вернуть в корень селектором родителя.
    await page.getByTestId("note-parent").selectOption("");
    await expect(page.getByTestId("note-parent")).toHaveValue("");
    await expectNoOverflow(page);
  });

  test("переносит строку внутрь, между соседями и в корень drag-and-drop", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const parentName = title("Ветка переноса");
    const childName = title("Существующий ребёнок");
    const moverName = title("Перетаскиваемая страница");
    await openNotes(page);
    const parentId = await createNote(page, parentName);
    await page.locator(`[data-note-tree-item='${parentId}']`).hover();
    await page.locator(`[data-note-add-child='${parentId}']`).click();
    await page.getByTestId("note-title").fill(childName);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
    const childId = noteId(page);

    // Свёрнутая ветка должна раскрыться после переноса внутрь.
    await page.getByRole("button", { name: `Свернуть ${parentName}` }).click();
    await expect(page.locator(`[data-note-select='${childId}']`)).toHaveCount(0);
    const moverId = await createNote(page, moverName);

    await beginNoteDrag(page, moverId);
    await noteDragOver(page, parentId, "inside");
    const inside = page.locator("[data-note-drop-indicator='inside']");
    await expect(inside).toBeVisible();
    await expect(inside).toContainText("Внутрь");
    await finishNoteDrag(page, moverId, parentId, "inside");

    // Ветка раскрыта, selection и заголовок сохранены, путь показывает родителя.
    await expect(page.locator(`[data-note-select='${moverId}']`)).toBeVisible();
    await expect(page.getByTestId("note-title")).toHaveValue(moverName);
    await expect(page.getByTestId("note-parent")).toHaveValue(parentId);
    await expect(page.locator("nav[aria-label='Путь к странице']")).toContainText(parentName);

    // Drop выше ребёнка ставит страницу перед ним среди siblings.
    await beginNoteDrag(page, moverId);
    await noteDragOver(page, childId, "before");
    await expect(page.locator("[data-note-drop-indicator='before']")).toContainText("Перед");
    await finishNoteDrag(page, moverId, childId, "before");
    await expectNoteRowsInOrder(page, [moverId, childId]);
    await expect(page.getByTestId("note-parent")).toHaveValue(parentId);

    // Затем drop ниже ребёнка возвращает обратный порядок.
    await beginNoteDrag(page, moverId);
    await noteDragOver(page, childId, "after");
    await expect(page.locator("[data-note-drop-indicator='after']")).toContainText("После");
    await finishNoteDrag(page, moverId, childId, "after");
    await expectNoteRowsInOrder(page, [childId, moverId]);
    await expect(page.getByTestId("note-parent")).toHaveValue(parentId);

    // Порядок siblings сохраняется после перезагрузки.
    await page.reload();
    await expect(page.getByTestId("note-title")).toHaveValue(moverName);
    await expect(page.getByTestId("note-parent")).toHaveValue(parentId);
    await expectNoteRowsInOrder(page, [childId, moverId]);

    // Отдельная корневая зона убирает parentId.
    await beginNoteDrag(page, moverId);
    await noteDragOver(page, null, "root");
    const rootZone = page.locator("[data-note-root-drop][data-note-drop-indicator='root']");
    await expect(rootZone).toBeVisible();
    await expect(rootZone).toContainText("Отпустите, чтобы сделать корневой");
    await finishNoteDrag(page, moverId, null, "root");
    await expect(page.getByTestId("note-parent")).toHaveValue("");
    await expect(page.getByTestId("note-title")).toHaveValue(moverName);
    await expect(page.locator("nav[aria-label='Путь к странице']")).not.toContainText(parentName);

    await page.reload();
    await expect(page.getByTestId("note-title")).toHaveValue(moverName);
    await expect(page.getByTestId("note-parent")).toHaveValue("");
    await expectNoOverflow(page);
  });

  test("переносит страницы селектором родителя и кнопками порядка без DnD", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const parentName = title("Родитель клавиатуры");
    const firstChildName = title("Первый ребёнок");
    const secondChildName = title("Второй ребёнок");
    await openNotes(page);
    const parentId = await createNote(page, parentName);
    await page.locator(`[data-note-tree-item='${parentId}']`).hover();
    await page.locator(`[data-note-add-child='${parentId}']`).click();
    await page.getByTestId("note-title").fill(firstChildName);
    await expect(page.getByTestId("note-save-state")).toContainText("Сохранено", {
      timeout: 15_000,
    });
    const firstId = noteId(page);

    // Parent select убирает вложенность и возвращает её обратно.
    await page.getByTestId("note-parent").selectOption("");
    await expect(page.getByTestId("note-parent")).toHaveValue("");
    await page.getByTestId("note-parent").selectOption(parentId);
    await expect(page.getByTestId("note-parent")).toHaveValue(parentId);
    await expect(page.locator("nav[aria-label='Путь к странице']")).toContainText(parentName);

    const secondId = await createNote(page, secondChildName);
    await page.getByTestId("note-parent").selectOption(parentId);
    await expect(page.getByTestId("note-parent")).toHaveValue(parentId);

    // Кнопка ↑ меняет порядок среди siblings и доступна с клавиатуры.
    const up = page.getByRole("button", { name: `Переместить ${secondChildName} выше` });
    await up.focus();
    await page.keyboard.press("Enter");
    await expectNoteRowsInOrder(page, [secondId, firstId]);

    await page.getByTestId("note-parent").selectOption("");
    await expect(page.getByTestId("note-parent")).toHaveValue("");
    await expect(page.locator("nav[aria-label='Путь к странице']")).not.toContainText(parentName);
    await expectNoOverflow(page);
  });
});

async function noteSidebarWidth(page: Page): Promise<number> {
  return page
    .getByRole("complementary", { name: "Навигация по заметкам" })
    .evaluate((element) => Math.round(element.getBoundingClientRect().width));
}

async function noteEditorWidth(page: Page): Promise<number> {
  return page
    .locator("section[aria-label='Редактор заметки']")
    .evaluate((element) => Math.round(element.getBoundingClientRect().width));
}

/** Границы синхронизированы с `use-note-sidebar-resizer.ts`. */
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_MIN_EDITOR_WIDTH = 320;

async function expectedSidebarMax(page: Page): Promise<number> {
  return page.getByTestId("notes-view").evaluate(
    (element, limits) => {
      const width = Math.round(element.getBoundingClientRect().width);
      return Math.max(limits.min, Math.min(limits.max, width - limits.editor));
    },
    { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH, editor: SIDEBAR_MIN_EDITOR_WIDTH },
  );
}

test.describe("kanbaner.notes resize дерева заметок", () => {
  test("меняет ширину мышью, клавиатурой и сохраняет после reload", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    await createNote(page, title("Ресайз дерева"));

    const handle = page.locator("[data-note-sidebar-resizer]");
    const line = page.locator("[data-note-sidebar-resizer-line]");
    await expect(handle).toBeVisible();
    await expect(handle).toHaveCSS("cursor", "col-resize");
    await expect(line).toBeVisible();
    await expect(handle).toHaveAttribute("aria-valuenow", "288");
    await expect.poll(() => noteSidebarWidth(page)).toBe(288);

    // Handle виден постоянно, но заметнее при наведении.
    const idleColor = await line.evaluate((element) => getComputedStyle(element).backgroundColor);
    await handle.hover();
    await expect
      .poll(() => line.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(idleColor);

    // Тянем правую границу мышью через Pointer Events.
    const box = await handle.boundingBox();
    if (box === null) throw new Error("Resize handle не найден");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => noteSidebarWidth(page)).toBe(408);
    await expect(handle).toHaveAttribute("aria-valuenow", "408");
    expect(await noteEditorWidth(page)).toBeGreaterThanOrEqual(320);
    await expectNoOverflow(page);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.notes.sidebarWidth")))
      .toBe("408");

    // Ширина переживает перезагрузку страницы.
    await page.reload();
    await expect(page.getByTestId("notes-view")).toBeVisible();
    await expect.poll(() => noteSidebarWidth(page)).toBe(408);
    await expect(handle).toHaveAttribute("aria-valuenow", "408");
    await expectNoOverflow(page);

    // Клавиатура: шаг, Home/End и double-click reset.
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "424");
    await page.keyboard.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "408");

    const maxWidth = Number(await handle.getAttribute("aria-valuemax"));
    expect(maxWidth).toBeGreaterThanOrEqual(408);
    await page.keyboard.press("End");
    await expect.poll(() => noteSidebarWidth(page)).toBe(maxWidth);
    expect(await noteEditorWidth(page)).toBeGreaterThanOrEqual(320);
    await expectNoOverflow(page);

    await page.keyboard.press("Home");
    await expect.poll(() => noteSidebarWidth(page)).toBe(240);
    await expectNoOverflow(page);

    await handle.dblclick();
    await expect.poll(() => noteSidebarWidth(page)).toBe(288);
    await expect(handle).toHaveAttribute("aria-valuenow", "288");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.notes.sidebarWidth")))
      .toBe("288");
    await expectNoOverflow(page);
  });

  test("ужимает дерево по viewport и восстанавливает ширину после расширения", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openNotes(page);
    const handle = page.locator("[data-note-sidebar-resizer]");
    await handle.focus();
    await page.keyboard.press("End");

    const wide = await expectedSidebarMax(page);
    expect(wide).toBeGreaterThan(288);
    await expect.poll(() => noteSidebarWidth(page)).toBe(wide);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.notes.sidebarWidth")))
      .toBe(String(wide));

    // 1280 всё ещё шире потолка 560 px: ширина не меняется.
    await page.setViewportSize({ width: 1280, height: DESKTOP.height });
    const at1280 = await expectedSidebarMax(page);
    await expect.poll(() => noteSidebarWidth(page)).toBe(at1280);
    await expect(handle).toHaveAttribute("aria-valuemax", String(at1280));
    await expectNoOverflow(page);

    // 1152 — ещё desktop, но контейнер уже: максимум опускается, фактическая
    // ширина ужимается, редактор сохраняет минимум.
    await page.setViewportSize({ width: 1152, height: DESKTOP.height });
    const narrow = await expectedSidebarMax(page);
    expect(narrow).toBeLessThan(wide);
    await expect.poll(() => noteSidebarWidth(page)).toBe(narrow);
    await expect(handle).toHaveAttribute("aria-valuemax", String(narrow));
    await expect(handle).toHaveAttribute("aria-valuenow", String(narrow));
    expect(await noteEditorWidth(page)).toBeGreaterThanOrEqual(320);
    await expectNoOverflow(page);
    // Ужатие не перезаписывает желаемую ширину.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.notes.sidebarWidth")))
      .toBe(String(wide));

    // Возврат к 1440 восстанавливает желаемую ширину.
    await page.setViewportSize(DESKTOP);
    await expect.poll(() => noteSidebarWidth(page)).toBe(wide);
    await expect(handle).toHaveAttribute("aria-valuenow", String(wide));
    await expectNoOverflow(page);
  });

  test("не показывает resize на mobile 360 и не ломает полноэкранное дерево", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openNotes(page);
    const id = await createNote(page, title("Мобильное дерево"));

    const handle = page.locator("[data-note-sidebar-resizer]");
    await expect(handle).toBeHidden();
    await page.getByRole("button", { name: "Открыть дерево заметок" }).click();
    const sidebar = page.getByRole("complementary", { name: "Навигация по заметкам" });
    await expect(sidebar).toBeVisible();
    // Мобильный sidebar занимает весь экран и не получает resize UI.
    await expect(handle).toBeHidden();
    await expect.poll(() => noteSidebarWidth(page)).toBe(MOBILE.width);
    await expect(page.locator(`[data-note-select='${id}']`)).toBeVisible();
    await expectNoOverflow(page);
  });
});
