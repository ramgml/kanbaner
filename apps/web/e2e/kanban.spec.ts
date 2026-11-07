import { expect, test, type Page } from "@playwright/test";

/**
 * Сквозные сценарии канбана в production shell.
 *
 * Тест работает только через публичное поведение: UI-вклады приходят с
 * сервера, действия вызывают те же команды и запросы `kanbaner.tasks`, что и
 * HTTP API. Отдельная база создаётся Playwright-конфигурацией.
 */

const MOBILE_VIEWPORT = { width: 360, height: 740 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const STATUS_LABELS = {
  backlog: "Бэклог",
  todo: "К выполнению",
  in_progress: "В работе",
  done: "Готово",
} as const;

let sequence = 0;

function uniqueTitle(prefix: string): string {
  sequence += 1;

  return `${prefix} ${Date.now()}-${String(sequence)}`;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
}

async function openTaskList(page: Page): Promise<void> {
  await page.goto("/view/tasks");
  await expect(page.getByTestId("task-list-view")).toBeVisible();
  await expect(page.getByTestId("task-list-projects-loading")).toHaveText("Проекты загружены");
}

async function closeDetails(page: Page): Promise<void> {
  if (!page.url().includes("task=")) {
    return;
  }

  const desktop = page.getByTestId("task-details-desktop");

  if ((await desktop.count()) > 0 && (await desktop.isVisible())) {
    await desktop.getByRole("button", { name: "Закрыть детали" }).click();
  } else {
    const mobile = page.getByTestId("task-details-mobile");

    await expect(mobile).toBeVisible();
    await mobile.getByRole("button", { name: "Закрыть детали" }).click();
  }

  await expect(page).not.toHaveURL(/[?&]task=/u);
}

async function createProject(page: Page, title: string): Promise<void> {
  await page.getByTestId("create-project-button").click();

  const form = page.getByTestId("project-form");

  await expect(form).toBeVisible();
  await form.getByLabel("Название проекта", { exact: true }).fill(title);
  await form.getByRole("button", { name: "Создать проект" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("create-task-button")).toBeEnabled();
}

interface TaskSeed {
  readonly projectTitle: string;
  readonly title: string;
  readonly priority?: string;
  readonly status?: keyof typeof STATUS_LABELS;
  readonly dueAt?: string;
  readonly tags?: string;
  readonly parentTitle?: string;
}

async function createTask(page: Page, seed: TaskSeed): Promise<string> {
  await page.getByTestId("create-task-button").click();

  const form = page.getByTestId("task-form-create");

  await expect(form).toBeVisible();
  await form.getByRole("combobox", { name: "Проект", exact: true }).selectOption({
    label: seed.projectTitle,
  });
  await form.getByLabel("Название", { exact: true }).fill(seed.title);

  if (seed.priority !== undefined) {
    await form
      .getByRole("combobox", { name: "Приоритет", exact: true })
      .selectOption(seed.priority);
  }

  if (seed.status !== undefined) {
    await form.getByRole("combobox", { name: "Статус", exact: true }).selectOption(seed.status);
  }

  if (seed.dueAt !== undefined) {
    await form.getByLabel("Срок", { exact: true }).fill(seed.dueAt);
  }

  if (seed.tags !== undefined) {
    await form.getByLabel("Теги через запятую", { exact: true }).fill(seed.tags);
  }

  if (seed.parentTitle !== undefined) {
    const parentSelect = form.getByRole("combobox", { name: "Родительская задача", exact: true });

    await expect(parentSelect).toContainText(seed.parentTitle);
    await parentSelect.selectOption({ label: seed.parentTitle });
  }

  await form.getByRole("button", { name: "Создать задачу" }).click();
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]task=/u);

  const taskId = new URL(page.url()).searchParams.get("task");

  expect(taskId).not.toBeNull();

  await closeDetails(page);

  return taskId as string;
}

async function openKanban(page: Page, projectTitle: string): Promise<void> {
  await page.goto("/view/kanban");
  await expect(page.getByTestId("kanban-view")).toBeVisible();

  const filters = page.getByTestId("kanban-filters");
  const projectSelect = filters.getByRole("combobox", { name: "Проект", exact: true });

  await expect(projectSelect).toContainText(projectTitle, { timeout: 30_000 });
  await projectSelect.selectOption({ label: projectTitle });
  await expect(page).toHaveURL(/[?&]project=/u);
  await expect(page.getByTestId("kanban-columns")).toBeVisible();
}

function column(page: Page, status: keyof typeof STATUS_LABELS) {
  return page.getByTestId(`kanban-column-${status}`);
}

function card(page: Page, taskId: string) {
  return page.getByTestId(`kanban-card-${taskId}`);
}

async function expectCardInColumn(
  page: Page,
  taskId: string,
  status: keyof typeof STATUS_LABELS,
): Promise<void> {
  await expect(column(page, status).getByTestId(`kanban-card-${taskId}`)).toBeVisible();
  await expect(page.getByTestId(`kanban-pending-${taskId}`)).toHaveCount(0);
}

async function openCardActions(page: Page, taskId: string): Promise<void> {
  const menuCard = card(page, taskId);
  const details = menuCard.locator("details");

  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await menuCard.locator("summary").focus();
    await page.keyboard.press("Enter");
  }

  await expect(details).toHaveAttribute("open", /.*/u);
}

async function moveWithMenu(
  page: Page,
  taskId: string,
  target: keyof typeof STATUS_LABELS,
): Promise<void> {
  await openCardActions(page, taskId);

  const button = card(page, taskId).getByRole("button", {
    name: `Переместить в ${STATUS_LABELS[target]}`,
  });

  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press("Enter");
}

async function reorderWithMenu(
  page: Page,
  taskId: string,
  label: "Выше" | "Ниже" | "В начало" | "В конец",
): Promise<void> {
  await openCardActions(page, taskId);

  const button = card(page, taskId).getByRole("button", { name: label, exact: true });

  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press("Enter");
}

async function cardTitles(page: Page, status: keyof typeof STATUS_LABELS): Promise<string[]> {
  const cards = column(page, status).locator('[data-testid^="kanban-card-"]');

  return cards.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-card-id") ?? ""),
  );
}

async function dragCard(
  page: Page,
  taskId: string,
  target: keyof typeof STATUS_LABELS,
  position: "top" | "bottom" = "bottom",
): Promise<void> {
  const handle = page.getByTestId(`kanban-drag-${taskId}`);
  const source = await handle.boundingBox();
  const destination = await column(page, target).boundingBox();

  expect(source).not.toBeNull();
  expect(destination).not.toBeNull();

  if (source === null || destination === null) {
    return;
  }

  const x = destination.x + destination.width / 2;
  const y = position === "top" ? destination.y + 45 : destination.y + destination.height - 16;

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

async function filterByProject(page: Page, projectTitle: string): Promise<void> {
  const filters = page.getByTestId("kanban-filters");

  await filters
    .getByRole("combobox", { name: "Проект", exact: true })
    .selectOption({ label: projectTitle });
}

test.describe("канбан в production shell", () => {
  test.describe.configure({ timeout: 240_000 });

  test.describe("десктопный viewport", () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test("показывает проект и задачи в четырёх фиксированных колонках", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект доски");
      const backlogTitle = uniqueTitle("Бэклог задача");
      const todoTitle = uniqueTitle("Туду задача");
      const progressTitle = uniqueTitle("В работе задача");
      const doneTitle = uniqueTitle("Готовая задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const backlogId = await createTask(page, {
        projectTitle,
        title: backlogTitle,
        status: "backlog",
      });
      const todoId = await createTask(page, {
        projectTitle,
        title: todoTitle,
        status: "todo",
        priority: "high",
        dueAt: "2030-01-10",
        tags: "release, backend",
      });
      const progressId = await createTask(page, {
        projectTitle,
        title: progressTitle,
        status: "in_progress",
      });
      const doneId = await createTask(page, {
        projectTitle,
        title: doneTitle,
        status: "done",
      });
      const childTitle = uniqueTitle("Подзадача доски");

      await createTask(page, {
        projectTitle,
        title: childTitle,
        status: "todo",
        parentTitle: todoTitle,
      });

      await openKanban(page, projectTitle);

      await expect(column(page, "backlog").getByTestId(`kanban-card-${backlogId}`)).toBeVisible();
      await expect(column(page, "todo").getByTestId(`kanban-card-${todoId}`)).toBeVisible();
      await expect(
        column(page, "in_progress").getByTestId(`kanban-card-${progressId}`),
      ).toBeVisible();
      await expect(column(page, "done").getByTestId(`kanban-card-${doneId}`)).toBeVisible();
      await expect(column(page, "todo").locator('[data-testid^="kanban-card-"]')).toHaveCount(2);
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("1");
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("2");
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("1");
      await expect(page.getByTestId("kanban-count-done")).toHaveText("1");

      const todoCard = card(page, todoId);

      await expect(todoCard).toContainText(todoTitle);
      await expect(todoCard).toContainText("Высокий");
      await expect(todoCard).toContainText("10.01.2030");
      await expect(todoCard).toContainText("release");
      await expect(page.getByTestId(`kanban-subtasks-${todoId}`)).toHaveText("Подзадачи: 1");
      await expect(page.getByTestId(`kanban-subtasks-${backlogId}`)).toHaveText("Подзадачи: 0");

      // Колонки и задачи переживают полную перезагрузку страницы.
      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("2");
      await expect(page.getByTestId(`kanban-card-${todoId}`)).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test("перемещает карточку drag-and-drop и синхронизирует список", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект DnD");
      const draggedTitle = uniqueTitle("Перетаскиваемая задача");
      const otherTitle = uniqueTitle("Соседняя задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const draggedId = await createTask(page, {
        projectTitle,
        title: draggedTitle,
        status: "todo",
      });
      await createTask(page, { projectTitle, title: otherTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, draggedId, "todo");

      await dragCard(page, draggedId, "in_progress");
      await expectCardInColumn(page, draggedId, "in_progress");
      await expect(page.getByTestId(`kanban-card-${draggedId}`)).not.toHaveAttribute(
        "aria-busy",
        "true",
      );

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expectCardInColumn(page, draggedId, "in_progress");

      // Список показывает тот же статус после команды на доске.
      await openTaskList(page);
      await page
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await expect(page.getByTestId(`task-row-${draggedId}`)).toContainText("В работе");

      // Команда из списка видна на доске.
      await page
        .getByTestId(`task-row-${draggedId}`)
        .getByRole("button", { name: `Открыть задачу ${draggedTitle}` })
        .click();

      const details = page.getByTestId("task-details-desktop");

      await expect(details).toContainText(draggedTitle);
      await details
        .getByRole("combobox", { name: "Переместить в", exact: true })
        .selectOption("done");
      await details.getByRole("button", { name: "Переместить", exact: true }).click();
      await expect(details).toContainText("Готово");

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, draggedId, "done");
    });

    test("перемещает и переупорядочивает карточки с клавиатуры, порядок переживает reload", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект клавиатуры канбана");
      const firstTitle = uniqueTitle("Первая");
      const secondTitle = uniqueTitle("Вторая");
      const thirdTitle = uniqueTitle("Третья");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const firstId = await createTask(page, { projectTitle, title: firstTitle, status: "todo" });
      const secondId = await createTask(page, { projectTitle, title: secondTitle, status: "todo" });
      const thirdId = await createTask(page, { projectTitle, title: thirdTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([firstId, secondId, thirdId]);

      // Меню с клавиатуры: «В конец» переставляет первую карточку.
      await reorderWithMenu(page, firstId, "В конец");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([secondId, thirdId, firstId]);

      // «Выше» возвращает её на одну позицию.
      await reorderWithMenu(page, firstId, "Выше");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([secondId, firstId, thirdId]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([secondId, firstId, thirdId]);

      // Меню «Переместить в…» с клавиатуры меняет статус.
      await moveWithMenu(page, thirdId, "done");
      await expectCardInColumn(page, thirdId, "done");

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expectCardInColumn(page, thirdId, "done");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([secondId, firstId]);
    });

    test("при VERSION_CONFLICT откатывает карточку и не перезаписывает чужую правку", async ({
      page,
      context,
    }) => {
      const projectTitle = uniqueTitle("Проект конфликта канбана");
      const taskTitle = uniqueTitle("Задача конфликта канбана");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, taskId, "todo");

      // Вторая вкладка держит ту же версию задачи.
      const stalePage = await context.newPage();

      await stalePage.goto(
        `/view/kanban?project=${new URL(page.url()).searchParams.get("project")}`,
      );
      await expect(stalePage.getByTestId("kanban-view")).toBeVisible();
      await expect(stalePage.getByTestId(`kanban-card-${taskId}`)).toBeVisible();

      await moveWithMenu(page, taskId, "done");
      await expectCardInColumn(page, taskId, "done");

      await moveWithMenu(stalePage, taskId, "in_progress");
      await expect(stalePage.getByTestId("kanban-error")).toContainText(
        "Задача уже изменена в другом месте",
      );
      await expect(stalePage.getByTestId(`kanban-conflict-${taskId}`)).toBeVisible();
      // Откат + повторный запрос: карточка показывает серверную правку, а не
      // устаревшую команду второй вкладки.
      await expectCardInColumn(stalePage, taskId, "done");
      await expect(
        column(stalePage, "in_progress").getByTestId(`kanban-card-${taskId}`),
      ).toHaveCount(0);

      // Данные не потеряны и видны в списке в статусе первой вкладки.
      await openTaskList(stalePage);
      await stalePage
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await expect(stalePage.getByTestId(`task-row-${taskId}`)).toContainText("Готово");

      await stalePage.close();
    });

    test("фильтрует по проекту и тегу с сохранением в query string", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект фильтров канбана");
      const releaseTitle = uniqueTitle("Релизная задача");
      const backendTitle = uniqueTitle("Бэкенд задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const releaseId = await createTask(page, {
        projectTitle,
        title: releaseTitle,
        status: "todo",
        tags: "release",
      });
      const backendId = await createTask(page, {
        projectTitle,
        title: backendTitle,
        status: "todo",
        tags: "backend",
      });

      await openKanban(page, projectTitle);
      await expect(page.getByTestId(`kanban-card-${releaseId}`)).toBeVisible();
      await expect(page.getByTestId(`kanban-card-${backendId}`)).toBeVisible();
      expect(new URL(page.url()).searchParams.get("project")).not.toBeNull();

      const filters = page.getByTestId("kanban-filters");

      await filters.getByLabel("Тег", { exact: true }).fill("release");
      await expect(page).toHaveURL(/[?&]tag=release/u);
      await expect(page.getByTestId(`kanban-card-${releaseId}`)).toBeVisible();
      await expect(page.getByTestId(`kanban-card-${backendId}`)).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(filters.getByLabel("Тег", { exact: true })).toHaveValue("release");
      await expect(page.getByTestId(`kanban-card-${releaseId}`)).toBeVisible();
      await expect(page.getByTestId(`kanban-card-${backendId}`)).toHaveCount(0);

      await page.getByRole("button", { name: "Сбросить фильтры" }).click();
      await expect(page).not.toHaveURL(/[?&](project|tag)=/u);
      await expect(page.getByTestId(`kanban-card-${backendId}`)).toBeVisible();
    });

    test("догружает колонку страницами больше page size без дублей", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект пагинации канбана");
      const total = 12;

      await openTaskList(page);
      await createProject(page, projectTitle);

      const ids: string[] = [];

      for (let index = 0; index < total; index += 1) {
        ids.push(
          await createTask(page, {
            projectTitle,
            title: `P${String(index + 1).padStart(2, "0")} ${projectTitle}`,
            status: "backlog",
          }),
        );
      }

      await openKanban(page, projectTitle);
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText(String(total));
      await expect(column(page, "backlog").locator('[data-testid^="kanban-card-"]')).toHaveCount(
        10,
      );
      await expect(page.getByTestId("kanban-load-more-backlog")).toBeVisible();

      await page.getByTestId("kanban-load-more-backlog").click();
      await expect(column(page, "backlog").locator('[data-testid^="kanban-card-"]')).toHaveCount(
        total,
      );
      await expect(page.getByTestId("kanban-load-more-backlog")).toHaveCount(0);
      await expect.poll(async () => cardTitles(page, "backlog")).toEqual(ids);

      // Повторный reload начинает колонку с первой страницы и не дублирует
      // уже загруженные карточки.
      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(column(page, "backlog").locator('[data-testid^="kanban-card-"]')).toHaveCount(
        10,
      );
      await page.getByTestId("kanban-load-more-backlog").click();
      await expect.poll(async () => cardTitles(page, "backlog")).toEqual(ids);
      expect(new Set(await cardTitles(page, "backlog")).size).toBe(total);
    });
  });

  test.describe("мобильный viewport", () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test("на 360 px прокручивает только колонки и открывает overlay с фокусом", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект мобильного канбана");
      const taskTitle = uniqueTitle("Мобильная карточка канбана");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        status: "todo",
        priority: "high",
      });

      await openKanban(page, projectTitle);
      await expect(page.getByTestId(`kanban-card-${taskId}`)).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const metrics = await page.getByTestId("kanban-columns").evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));

      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

      // Overlay появляется только на /view/kanban и при выбранной карточке.
      await page.getByTestId(`kanban-open-${taskId}`).click();

      const dialog = page.getByTestId("kanban-details");

      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(taskTitle);
      expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
      expect(
        await dialog.evaluate(
          (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
        ),
      ).toBe(true);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);

      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
          true,
        );
      }

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);
      await expect
        .poll(async () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
        )
        .toBe(`Открыть карточку задачи ${taskTitle}`);

      // Чужой маршрут с task= не показывает overlay канбана.
      await page.goto(`/view/tasks?task=${taskId}`);
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);

      await page.goto(`/plugins?task=${taskId}`);
      await expect(page.getByRole("heading", { name: "Плагины" })).toBeVisible();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);

      // Breakpoint: mobile dialog закрывается на desktop и снова открывается
      // при возврате на мобильный.
      await openKanban(page, projectTitle);
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect(page.getByTestId("kanban-details")).toBeVisible();

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await expect.poll(async () => page.locator("dialog").count()).toBe(0);
      const desktopOverlay = page.getByTestId("kanban-details");

      await expect(desktopOverlay).toBeVisible();
      await expect(desktopOverlay).toHaveAttribute("data-variant", "desktop");
      expect(
        await page.evaluate(() => document.querySelector("dialog")?.matches(":modal") ?? false),
      ).toBe(false);

      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect
        .poll(async () =>
          page
            .getByTestId("kanban-details")
            .evaluate(
              (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
            ),
        )
        .toBe(true);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);
    });
  });

  test.describe("десктопный viewport", () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test("отключение канбана не влияет на задачи и список", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект отключения канбана");
      const taskTitle = uniqueTitle("Задача отключения канбана");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, taskId, "todo");

      await page.goto("/plugins");

      const toggle = page.getByRole("switch", {
        name: "Включить плагин Kanbaner Kanban",
      });

      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(page.getByRole("heading", { name: "Kanbaner Kanban" })).toBeVisible();

      await page.goto("/view/kanban");
      await expect(page.getByTestId("plugin-view-empty")).toBeVisible();

      // Данные принадлежат kanbaner.tasks и остаются в списке.
      await page.goto("/view/tasks");
      await page
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await expect(page.getByTestId(`task-row-${taskId}`)).toContainText(taskTitle);

      await page.goto("/plugins");
      const restoredToggle = page.getByRole("switch", {
        name: "Включить плагин Kanbaner Kanban",
      });

      await restoredToggle.click();
      await expect(restoredToggle).toHaveAttribute("aria-checked", "true");

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, taskId, "todo");
      await expectNoHorizontalOverflow(page);
    });
  });
});
