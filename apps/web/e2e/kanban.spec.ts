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

async function waitForCardSettled(page: Page, taskId: string): Promise<void> {
  await expect(card(page, taskId)).not.toHaveAttribute("aria-busy", "true");
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
  await waitForCardSettled(page, taskId);
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
  await waitForCardSettled(page, taskId);
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

async function openBoard(page: Page): Promise<void> {
  await page.goto("/view/kanban");
  await expect(page.getByTestId("kanban-view")).toBeVisible();
}

async function createProjectOnBoard(
  page: Page,
  title: string,
  options: { readonly doubleSubmit?: boolean } = {},
): Promise<void> {
  await page.getByTestId("kanban-create-project").click();

  const form = page.getByTestId("project-form");

  await expect(form).toBeVisible();
  await form.getByLabel("Название проекта", { exact: true }).fill(title);

  const submit = form.getByRole("button", { name: "Создать проект" });

  if (options.doubleSubmit === true) {
    await submit.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  } else {
    await submit.click();
  }

  await expect(form).toHaveCount(0);

  // Повторный project.list: проект сразу доступен в фильтре без reload,
  // ровно один раз даже после двойного клика.
  const projectSelect = page
    .getByTestId("kanban-filters")
    .getByRole("combobox", { name: "Проект", exact: true });

  await expect(projectSelect).toContainText(title);
  await expect(projectSelect.locator("option").filter({ hasText: title })).toHaveCount(1);
}

interface BoardTaskSeed {
  readonly projectTitle?: string;
  readonly title: string;
  readonly status?: keyof typeof STATUS_LABELS;
  readonly parentTitle?: string;
  readonly tags?: string;
  /** Открыть общую кнопку «Новая задача», а не кнопку колонки. */
  readonly viaGeneral?: boolean;
  /** Проверить, что кнопка колонки предустановила статус. */
  readonly expectPrefilledStatus?: boolean;
}

async function createTaskOnBoard(page: Page, seed: BoardTaskSeed): Promise<string> {
  const opener =
    seed.viaGeneral === true
      ? page.getByTestId("kanban-create-task")
      : seed.status === undefined
        ? page.getByTestId("kanban-create-task")
        : page.getByTestId(`kanban-create-task-${seed.status}`);

  await expect(opener).toBeEnabled();
  await opener.click();

  const form = page.getByTestId("task-form-create");

  await expect(form).toBeVisible();

  if (seed.expectPrefilledStatus === true && seed.status !== undefined) {
    await expect(form.getByRole("combobox", { name: "Статус", exact: true })).toHaveValue(
      seed.status,
    );
  }

  if (seed.projectTitle !== undefined) {
    await form
      .getByRole("combobox", { name: "Проект", exact: true })
      .selectOption({ label: seed.projectTitle });
  }

  await form.getByLabel("Название", { exact: true }).fill(seed.title);

  if (seed.status !== undefined) {
    await form.getByRole("combobox", { name: "Статус", exact: true }).selectOption(seed.status);
  }

  if (seed.parentTitle !== undefined) {
    const parent = form.getByRole("combobox", {
      name: "Родительская задача",
      exact: true,
    });

    await expect(parent).toContainText(seed.parentTitle);
    await parent.selectOption({ label: seed.parentTitle });
  }

  if (seed.tags !== undefined) {
    await form.getByLabel("Теги через запятую", { exact: true }).fill(seed.tags);
  }

  await form.getByRole("button", { name: "Создать задачу" }).click();
  await expect(form).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]task=/u);

  return cardIdByTitle(page, seed.title);
}

async function cardIdByTitle(page: Page, title: string): Promise<string> {
  const card = page.getByTestId("kanban-view").locator("[data-card-id]").filter({ hasText: title });

  await expect(card).toHaveCount(1);

  const id = await card.getAttribute("data-card-id");

  expect(id).not.toBeNull();

  return id as string;
}

async function expectTaskInList(
  page: Page,
  projectTitle: string,
  taskId: string,
  title: string,
  status: keyof typeof STATUS_LABELS,
): Promise<void> {
  await openTaskList(page);
  await page
    .getByTestId("task-filters")
    .getByRole("combobox", { name: "Проект", exact: true })
    .selectOption({ label: projectTitle });

  const row = page.getByTestId(`task-row-${taskId}`);

  await expect(row).toContainText(title);
  await expect(row).toContainText(STATUS_LABELS[status]);
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

      // «В конец» после догрузки считается по полному scope и не теряет
      // карточку за границей первой страницы.
      const rotated = [...ids.slice(1), ids[0] as string];

      await reorderWithMenu(page, ids[0] as string, "В конец");
      await expect.poll(async () => cardTitles(page, "backlog")).toEqual(rotated);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await page.getByTestId("kanban-load-more-backlog").click();
      await expect.poll(async () => cardTitles(page, "backlog")).toEqual(rotated);
      expect(new Set(await cardTitles(page, "backlog")).size).toBe(total);
    });

    test("переставляет filtered-карточку по полному scope, не теряя скрытого соседа", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект скрытого соседа");
      const visibleTitle = uniqueTitle("Видимая A");
      const hiddenTitle = uniqueTitle("Скрытая соседняя");
      const secondTitle = uniqueTitle("Видимая C");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const visibleId = await createTask(page, {
        projectTitle,
        title: visibleTitle,
        status: "todo",
        tags: "release",
      });
      const hiddenId = await createTask(page, {
        projectTitle,
        title: hiddenTitle,
        status: "todo",
        tags: "backend",
      });
      const secondId = await createTask(page, {
        projectTitle,
        title: secondTitle,
        status: "todo",
        tags: "release",
      });

      await openKanban(page, projectTitle);
      await expect
        .poll(async () => cardTitles(page, "todo"))
        .toEqual([visibleId, hiddenId, secondId]);

      const filters = page.getByTestId("kanban-filters");

      await filters.getByLabel("Тег", { exact: true }).fill("release");
      await expect(page).toHaveURL(/[?&]tag=release/u);
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([visibleId, secondId]);

      // В видимом списке «В конец» дал бы позицию 1; полный scope требует 2,
      // поэтому скрытая карточка остаётся перед видимой C.
      await reorderWithMenu(page, visibleId, "В конец");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([secondId, visibleId]);

      await filters.getByLabel("Тег", { exact: true }).fill("");
      await expect
        .poll(async () => cardTitles(page, "todo"))
        .toEqual([hiddenId, secondId, visibleId]);
    });

    test("«Выше» и «Ниже» в filtered-колонке работают по видимому порядку", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект видимого порядка");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const beforeId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Скрытая до"),
        status: "todo",
        tags: "backend",
      });
      const visibleAId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Видимая A"),
        status: "todo",
        tags: "release",
      });
      const middleId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Скрытая между"),
        status: "todo",
        tags: "backend",
      });
      const visibleCId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Видимая C"),
        status: "todo",
        tags: "release",
      });
      const afterId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Скрытая после"),
        status: "todo",
        tags: "backend",
      });

      await openKanban(page, projectTitle);
      await expect
        .poll(async () => cardTitles(page, "todo"))
        .toEqual([beforeId, visibleAId, middleId, visibleCId, afterId]);

      const filters = page.getByTestId("kanban-filters");
      const tagInput = filters.getByLabel("Тег", { exact: true });

      await tagInput.fill("release");
      await expect(page).toHaveURL(/[?&]tag=release/u);
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([visibleAId, visibleCId]);

      // «Ниже» для A должно опустить её под C в видимом списке, а не
      // остановиться перед скрытой M: полный порядок заканчивается на A.
      await reorderWithMenu(page, visibleAId, "Ниже");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([visibleCId, visibleAId]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(page).toHaveURL(/[?&]tag=release/u);
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([visibleCId, visibleAId]);

      await tagInput.fill("");
      await expect
        .poll(async () => cardTitles(page, "todo"))
        .toEqual([beforeId, middleId, visibleCId, afterId, visibleAId]);

      // «Выше» для A из [C, A] поднимает её над C, сохраняя скрытые соседи
      // по обе стороны от видимой пары.
      await tagInput.fill("release");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([visibleCId, visibleAId]);
      await reorderWithMenu(page, visibleAId, "Выше");
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([visibleAId, visibleCId]);

      await tagInput.fill("");
      await expect
        .poll(async () => cardTitles(page, "todo"))
        .toEqual([beforeId, middleId, visibleAId, visibleCId, afterId]);
    });

    test("после перемещения догружает target колонку на 10 и 12 задач", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект границы страницы");
      const progressTotal = 10;
      const doneTotal = 12;

      await openTaskList(page);
      await createProject(page, projectTitle);

      for (let index = 0; index < progressTotal; index += 1) {
        await createTask(page, {
          projectTitle,
          title: `Прогресс ${String(index + 1).padStart(2, "0")} ${projectTitle}`,
          status: "in_progress",
        });
      }

      for (let index = 0; index < doneTotal; index += 1) {
        await createTask(page, {
          projectTitle,
          title: `Готово ${String(index + 1).padStart(2, "0")} ${projectTitle}`,
          status: "done",
        });
      }

      const progressMoverId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("В прогресс после 10"),
        status: "todo",
      });
      const doneMoverId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("В готово после 12"),
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText(String(progressTotal));
      await expect(page.getByTestId("kanban-count-done")).toHaveText(String(doneTotal));

      await moveWithMenu(page, progressMoverId, "in_progress");
      await expectCardInColumn(page, progressMoverId, "in_progress");
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText(
        String(progressTotal + 1),
      );

      await moveWithMenu(page, doneMoverId, "done");
      await expectCardInColumn(page, doneMoverId, "done");
      await expect(page.getByTestId("kanban-count-done")).toHaveText(String(doneTotal + 1));

      // После свежей загрузки страницы колонки снова начинаются с первой
      // страницы; карточки за границей появляются после «Показать ещё».
      // Auto-include относится к reloadBoard сразу после move (выше).
      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-load-more-in_progress")).toBeVisible();
      await page.getByTestId("kanban-load-more-in_progress").click();
      await expectCardInColumn(page, progressMoverId, "in_progress");
      await expect(page.getByTestId("kanban-load-more-done")).toBeVisible();
      await page.getByTestId("kanban-load-more-done").click();
      await expectCardInColumn(page, doneMoverId, "done");
    });

    test("настоящий Link меняет query на том же маршруте и закрывает overlay", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект Link навигации");
      const taskTitle = uniqueTitle("Задача Link навигации");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect(page.getByTestId("kanban-details")).toBeVisible();
      await expect(page).toHaveURL(/[?&]task=/u);

      // Клик по настоящей Next Link-навигации на тот же /view/kanban убирает
      // только query string: overlay закрывается без полной перезагрузки.
      await page
        .getByTestId("desktop-sidebar")
        .getByRole("link", { name: "Канбан", exact: true })
        .click();

      await expect(page).toHaveURL(/\/view\/kanban$/u);
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(page.getByTestId("kanban-view")).toBeVisible();

      // Уход на другой маршрут тоже скрывает overlay.
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect(page.getByTestId("kanban-details")).toBeVisible();
      await page
        .getByTestId("desktop-sidebar")
        .getByRole("link", { name: "Плагины", exact: true })
        .click();

      await expect(page).toHaveURL(/\/plugins$/u);
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
    });

    test("создаёт проект и задачу прямо на доске без списка", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект создания на доске");
      const taskTitle = uniqueTitle("Задача создания на доске");

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle, { doubleSubmit: true });
      await filterByProject(page, projectTitle);
      await expect(page).toHaveURL(/[?&]project=/u);

      const taskId = await createTaskOnBoard(page, {
        projectTitle,
        title: taskTitle,
        status: "todo",
        expectPrefilledStatus: true,
      });

      await expectCardInColumn(page, taskId, "todo");
      await expect(page.getByTestId(`kanban-card-${taskId}`)).toContainText(taskTitle);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expectCardInColumn(page, taskId, "todo");

      await expectTaskInList(page, projectTitle, taskId, taskTitle, "todo");
      await expect(page.getByTestId("kanban-create-project")).toHaveCount(0);
    });

    test("создаёт через общую кнопку с проектом, статусом и родителем", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект общей кнопки");
      const parentTitle = uniqueTitle("Корневая для родителя");
      const childTitle = uniqueTitle("Дочерняя с общей кнопки");

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle);
      await filterByProject(page, projectTitle);

      const parentId = await createTaskOnBoard(page, {
        projectTitle,
        title: parentTitle,
        status: "backlog",
        tags: "release",
        expectPrefilledStatus: true,
      });

      await expectCardInColumn(page, parentId, "backlog");

      // Активный фильтр тега не мешает созданию: новая задача получает тег.
      // Фильтр нормализуется через normalizeTag, поэтому Release == release.
      await page.getByTestId("kanban-filters").getByLabel("Тег", { exact: true }).fill("Release");
      await expect(page).toHaveURL(/[?&]tag=Release/u);

      const childId = await createTaskOnBoard(page, {
        projectTitle,
        title: childTitle,
        status: "in_progress",
        parentTitle,
        tags: "release",
        viaGeneral: true,
      });

      await expectCardInColumn(page, childId, "in_progress");
      await expect(page.getByTestId(`kanban-card-${childId}`)).toContainText("release");
      await expect(page).toHaveURL(/[?&]project=/u);
      await expect(page).toHaveURL(/[?&]tag=Release/u);
      await expect(page.getByTestId(`kanban-subtasks-${parentId}`)).toHaveText("Подзадачи: 1");

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(
        page.getByTestId("kanban-filters").getByLabel("Тег", { exact: true }),
      ).toHaveValue("Release");
      await expectCardInColumn(page, childId, "in_progress");

      // Реально несовпадающий тег сбрасывается, чтобы созданная карточка была
      // видна; фильтр проекта при этом сохраняется.
      const otherTag = `other-${String(Date.now())}`;
      const visibleTitle = uniqueTitle("Видна после сброса тега");

      await page.getByTestId("kanban-filters").getByLabel("Тег", { exact: true }).fill(otherTag);
      await expect(page).toHaveURL(new RegExp(`[?&]tag=${otherTag}`, "u"));

      const visibleId = await createTaskOnBoard(page, {
        projectTitle,
        title: visibleTitle,
        status: "todo",
        tags: "release",
      });

      await expect(page).not.toHaveURL(/[?&]tag=/u);
      await expect(page).toHaveURL(/[?&]project=/u);
      await expectCardInColumn(page, visibleId, "todo");
    });

    test("создаёт задачи кнопками всех четырёх колонок", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект колонок создания");
      const created: Array<{
        readonly status: keyof typeof STATUS_LABELS;
        readonly title: string;
      }> = [];

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle);
      await filterByProject(page, projectTitle);

      for (const status of ["backlog", "todo", "in_progress", "done"] as const) {
        const title = uniqueTitle(`Создано в ${STATUS_LABELS[status]}`);

        created.push({ status, title });
        await createTaskOnBoard(page, {
          projectTitle,
          title,
          status,
          expectPrefilledStatus: true,
        });
      }

      for (const item of created) {
        const card = column(page, item.status).locator("[data-card-id]").filter({
          hasText: item.title,
        });

        await expect(card).toHaveCount(1);
        await expect(page.getByTestId(`kanban-count-${item.status}`)).toHaveText("1");
      }

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);

      const ids = new Map<string, string>();

      for (const item of created) {
        const id = await cardIdByTitle(page, item.title);

        ids.set(item.title, id);
        await expectCardInColumn(page, id, item.status);
      }

      // Список показывает все четыре статуса, включая in_progress и done.
      await openTaskList(page);
      await page
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });

      for (const item of created) {
        const row = page.getByTestId(`task-row-${ids.get(item.title) ?? ""}`);

        await expect(row).toContainText(item.title);
        await expect(row).toContainText(STATUS_LABELS[item.status]);
      }
    });

    test("догружает созданную за границей страницы карточку и не дублирует её", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект границы создания");
      const createdTitle = uniqueTitle("Создана за границей");

      await openTaskList(page);
      await createProject(page, projectTitle);

      for (let index = 0; index < 10; index += 1) {
        await createTask(page, {
          projectTitle,
          title: `Старая ${String(index)} ${projectTitle}`,
          status: "backlog",
        });
      }

      await openKanban(page, projectTitle);
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("10");
      await expect(column(page, "backlog").locator("[data-card-id]")).toHaveCount(10);

      await page.getByTestId("kanban-create-task-backlog").click();

      const form = page.getByTestId("task-form-create");

      await expect(form.getByRole("combobox", { name: "Статус", exact: true })).toHaveValue(
        "backlog",
      );
      await form.getByLabel("Название", { exact: true }).fill(createdTitle);

      const submit = form.getByRole("button", { name: "Создать задачу" });

      // Два клика до завершения команды: UI обязан отправить только один.
      await submit.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });

      await expect(form).toHaveCount(0);
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("11");

      const card = column(page, "backlog").locator("[data-card-id]").filter({
        hasText: createdTitle,
      });

      await expect(card).toHaveCount(1);
      const id = await card.getAttribute("data-card-id");

      expect(id).not.toBeNull();
      await expectCardInColumn(page, id as string, "backlog");

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("11");
      await expect(page.getByTestId("kanban-load-more-backlog")).toBeVisible();
      await page.getByTestId("kanban-load-more-backlog").click();
      await expectCardInColumn(page, id as string, "backlog");
      await expect(column(page, "backlog").locator("[data-card-id]")).toHaveCount(11);

      await expectTaskInList(page, projectTitle, id as string, createdTitle, "backlog");
    });

    test("быстрый composer создаёт несколько задач подряд, Shift+Enter и Escape", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект быстрого composer");
      const firstTitle = uniqueTitle("Быстрая первая");
      const secondTitle = uniqueTitle("Быстрая вторая");
      const multilineFirst = uniqueTitle("Многострочная первая");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const trigger = page.getByTestId("kanban-quick-add-todo");
      const input = page.getByTestId("kanban-quick-add-input-todo");
      const form = page.getByTestId("kanban-quick-add-form-todo");

      await trigger.click();
      await expect(form).toBeVisible();
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();

      await page.keyboard.type(firstTitle);
      await page.keyboard.press("Enter");
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: firstTitle }),
      ).toHaveCount(1);

      // Composer не закрывается: следующая карточка создаётся сразу с
      // клавиатуры, без повторного locator.fill.
      await page.keyboard.type(secondTitle);
      await page.keyboard.press("Enter");
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: secondTitle }),
      ).toHaveCount(1);
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("2");

      // Shift+Enter добавляет строку, а не отправляет форму.
      await page.keyboard.type(multilineFirst);
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("вторая строка");
      await expect(input).toHaveValue(`${multilineFirst}\nвторая строка`);
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("2");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("3");
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: multilineFirst }),
      ).toHaveCount(1);

      await page.keyboard.press("Escape");
      await expect(form).toHaveCount(0);
      await expect(trigger).toBeVisible();
      await expect(trigger).toBeFocused();

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("3");
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: firstTitle }),
      ).toHaveCount(1);
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: secondTitle }),
      ).toHaveCount(1);

      // Список видит те же три задачи.
      await openTaskList(page);
      await page
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });

      for (const title of [firstTitle, secondTitle, multilineFirst]) {
        await expect(page.getByTestId("task-list-view")).toContainText(title);
      }
    });

    test("быстрый composer сохраняет текст при ошибке и не создаёт дубль", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект ошибки composer");
      const recoveredTitle = uniqueTitle("Восстановленная после ошибки");
      const tooLongTitle = "Д".repeat(201);

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);
      await page.getByTestId("kanban-quick-add-todo").click();

      const input = page.getByTestId("kanban-quick-add-input-todo");
      const error = page.getByTestId("kanban-quick-add-error-todo");

      await input.fill(tooLongTitle);
      await input.press("Enter");
      await expect(error).toContainText("валидацию");
      await expect(input).toHaveValue(tooLongTitle);
      await expect(page.getByTestId("kanban-quick-add-form-todo")).toBeVisible();

      await input.fill(recoveredTitle);

      const submit = page.getByTestId("kanban-quick-add-submit-todo");

      // Два клика до завершения команды: guard обязан отправить один create.
      await submit.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });

      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: recoveredTitle }),
      ).toHaveCount(1);
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("1");
      await expect(error).toHaveCount(0);
    });

    test("быстрый composer догружает созданную за границей страницы задачу", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект границы composer");
      const boundaryTitle = uniqueTitle("Быстрая за границей");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);
      await page.getByTestId("kanban-quick-add-backlog").click();

      const input = page.getByTestId("kanban-quick-add-input-backlog");

      for (let index = 0; index < 10; index += 1) {
        await input.fill(`Быстрая ${String(index + 1).padStart(2, "0")} ${projectTitle}`);
        await input.press("Enter");
        await expect(input).toHaveValue("");
      }

      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("10");
      await input.fill(boundaryTitle);
      await input.press("Enter");
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("11");
      await expect(
        column(page, "backlog").locator("[data-card-id]").filter({ hasText: boundaryTitle }),
      ).toHaveCount(1);

      const id = await cardIdByTitle(page, boundaryTitle);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-load-more-backlog")).toBeVisible();
      await page.getByTestId("kanban-load-more-backlog").click();
      await expectCardInColumn(page, id, "backlog");
      await expect(column(page, "backlog").locator("[data-card-id]")).toHaveCount(11);

      await expectTaskInList(page, projectTitle, id, boundaryTitle, "backlog");
    });

    test("без фильтра проекта composer предлагает выбрать проект и не теряет заголовок", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект выбора в composer");
      const title = uniqueTitle("Без фильтра проекта");

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle);

      // Фильтр не выбираем: доска остаётся в режиме «Все проекты».
      await expect(page.getByTestId("kanban-board-title")).toHaveText("Все проекты");
      await page.getByTestId("kanban-quick-add-backlog").click();

      const form = page.getByTestId("kanban-quick-add-form-backlog");
      const input = page.getByTestId("kanban-quick-add-input-backlog");
      const projectSelect = form.getByRole("combobox", { name: "Проект", exact: true });

      await expect(projectSelect).toBeVisible();
      await input.fill(title);

      const submit = page.getByTestId("kanban-quick-add-submit-backlog");

      await expect(submit).toBeDisabled();
      await projectSelect.selectOption({ label: projectTitle });
      await expect(input).toHaveValue(title);
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(
        column(page, "backlog").locator("[data-card-id]").filter({ hasText: title }),
      ).toHaveCount(1);
      const id = await cardIdByTitle(page, title);

      await expect(page.getByTestId(`kanban-project-badge-${id}`)).toHaveText(projectTitle);
      await expect(page).not.toHaveURL(/[?&]project=/u);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(page.getByTestId(`kanban-card-${id}`)).toBeVisible();

      await expectTaskInList(page, projectTitle, id, title, "backlog");
    });

    test("quick draft переходит в полную форму, сохраняется при cancel и очищается после создания", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект quick draft");
      const draftTitle = uniqueTitle("Быстрый черновик формы");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const quickForm = page.getByTestId("kanban-quick-add-form-todo");
      const quickInput = page.getByTestId("kanban-quick-add-input-todo");

      await page.getByTestId("kanban-quick-add-todo").click();
      await expect(quickInput).toBeFocused();
      await page.keyboard.type(draftTitle);

      // При открытом composer остаётся один путь в полную форму.
      await expect(page.getByTestId("kanban-create-task-todo")).toHaveCount(0);
      await expect(page.getByTestId("kanban-quick-details-todo")).toBeVisible();
      await expect(quickForm).toBeVisible();

      await page.getByTestId("kanban-quick-details-todo").click();

      const form = page.getByTestId("task-form-create");

      await expect(form).toBeVisible();
      await expect(form.getByLabel("Название", { exact: true })).toHaveValue(draftTitle);

      const projectId = new URL(page.url()).searchParams.get("project");

      expect(projectId).not.toBeNull();
      await expect(form.getByRole("combobox", { name: "Проект", exact: true })).toHaveValue(
        projectId ?? "",
      );

      await form.getByRole("button", { name: "Отмена" }).click();
      await expect(form).toHaveCount(0);
      // Cancel полной формы сохраняет originating quick draft.
      await expect(quickInput).toHaveValue(draftTitle);
      await expect(quickForm).toBeVisible();

      await page.getByTestId("kanban-quick-details-todo").click();
      await expect(form).toBeVisible();
      await form.getByRole("button", { name: "Создать задачу" }).click();
      await expect(form).toHaveCount(0);

      // После успешного создания originating quick draft очищается.
      await expect(quickInput).toHaveValue("");
      await expect(quickForm).toBeVisible();
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: draftTitle }),
      ).toHaveCount(1);
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("1");
    });

    test("показывает место вставки между карточками при drag-and-drop", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект placeholder");
      const firstTitle = uniqueTitle("Первая placeholder");
      const secondTitle = uniqueTitle("Вторая placeholder");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const firstId = await createTask(page, {
        projectTitle,
        title: firstTitle,
        status: "todo",
      });
      const secondId = await createTask(page, {
        projectTitle,
        title: secondTitle,
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([firstId, secondId]);

      const handle = page.getByTestId(`kanban-drag-${secondId}`);
      const target = page.getByTestId(`kanban-card-${firstId}`);
      const source = await handle.boundingBox();
      const destination = await target.boundingBox();

      expect(source).not.toBeNull();
      expect(destination).not.toBeNull();

      if (source === null || destination === null) {
        return;
      }

      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(destination.x + destination.width / 2, destination.y + 6, { steps: 8 });

      const placeholder = page.getByTestId("kanban-drop-placeholder");

      await expect(placeholder).toBeVisible();
      const placeholderBox = await placeholder.boundingBox();
      const firstBox = await target.boundingBox();

      expect(placeholderBox).not.toBeNull();
      expect(firstBox).not.toBeNull();

      if (placeholderBox !== null && firstBox !== null) {
        expect(placeholderBox.y).toBeLessThanOrEqual(firstBox.y + 1);
      }

      await page.mouse.up();
      await expect.poll(async () => cardTitles(page, "todo")).toEqual([secondId, firstId]);
      await expect(placeholder).toHaveCount(0);
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

    test("сохраняет черновик при mobile → desktop → mobile и возвращает фокус", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект мобильного создания");
      const parentTitle = uniqueTitle("Родитель мобильного черновика");
      const draftTitle = uniqueTitle("Черновик мобильного layout");
      const taskTitle = uniqueTitle("Мобильная созданная задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const parentId = await createTask(page, {
        projectTitle,
        title: parentTitle,
        status: "backlog",
      });

      await openKanban(page, projectTitle);
      await expectNoHorizontalOverflow(page);

      const filters = page.getByTestId("kanban-filters");
      const projectId = await filters
        .getByRole("combobox", { name: "Проект", exact: true })
        .inputValue();
      const opener = page.getByTestId("kanban-create-task-todo");

      await opener.focus();
      await page.keyboard.press("Enter");

      const dialog = page.getByTestId("kanban-create-dialog");

      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
      expect(
        await dialog.evaluate(
          (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
        ),
      ).toBe(true);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);
      await expectNoHorizontalOverflow(page);

      // Заполняем все поля ДО смены layout.
      let form = page.getByTestId("task-form-create");
      const parentSelect = form.getByRole("combobox", {
        name: "Родительская задача",
        exact: true,
      });

      await expect(parentSelect).toContainText(parentTitle);
      await form.getByLabel("Название", { exact: true }).fill(draftTitle);
      await form.locator('textarea[name="descriptionMarkdown"]').fill("Описание черновика");
      await form.getByLabel("Теги через запятую", { exact: true }).fill("release, draft");
      await form.getByRole("combobox", { name: "Статус", exact: true }).selectOption("in_progress");
      await parentSelect.selectOption({ label: parentTitle });

      const expectDraft = async (): Promise<void> => {
        form = page.getByTestId("task-form-create");
        await expect(form.getByRole("combobox", { name: "Проект", exact: true })).toHaveValue(
          projectId,
        );
        await expect(form.getByLabel("Название", { exact: true })).toHaveValue(draftTitle);
        await expect(form.locator('textarea[name="descriptionMarkdown"]')).toHaveValue(
          "Описание черновика",
        );
        await expect(form.getByLabel("Теги через запятую", { exact: true })).toHaveValue(
          "release, draft",
        );
        await expect(form.getByRole("combobox", { name: "Статус", exact: true })).toHaveValue(
          "in_progress",
        );
        await expect(
          form.getByRole("combobox", { name: "Родительская задача", exact: true }),
        ).toHaveValue(parentId);
      };

      // mobile → desktop: форма размонтирована, draft сохранён.
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await expect(page.getByTestId("kanban-create-dialog")).toHaveCount(0);
      await expect(page.getByTestId("kanban-create-panel")).toBeVisible();
      await expectDraft();

      // Перед desktop → mobile фокус явно находится в inline-форме; после
      // Escape ModalDialog обязан вернуть его на кнопку открытия.
      await form.getByLabel("Название", { exact: true }).focus();
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("name")))
        .toBe("title");

      // desktop → mobile: все значения и фокус на opener.
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(page.getByTestId("kanban-create-dialog")).toBeVisible();
      await expectDraft();

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
        .toBe("kanban-create-task-todo");

      // Новая session: чистый draft с предустановкой колонки.
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      form = page.getByTestId("task-form-create");
      await expect(form.getByLabel("Название", { exact: true })).toHaveValue("");
      await expect(form.getByRole("combobox", { name: "Статус", exact: true })).toHaveValue("todo");
      await expect(form.getByRole("combobox", { name: "Проект", exact: true })).toHaveValue(
        projectId,
      );

      await form.getByLabel("Название", { exact: true }).fill(taskTitle);
      await form.getByLabel("Название", { exact: true }).press("Enter");

      await expect(form).toHaveCount(0);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
        .toBe("kanban-create-task-todo");

      const taskId = await cardIdByTitle(page, taskTitle);

      await expectCardInColumn(page, taskId, "todo");
      await expectNoHorizontalOverflow(page);

      await page.goto("/view/tasks");
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page.getByTestId("kanban-create-project")).toHaveCount(0);
      await expect(page.getByTestId("kanban-create-task")).toHaveCount(0);
    });

    test("показывает вкладки статусов, scroll-snap и переключает колонки", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект мобильных вкладок");
      const taskTitle = uniqueTitle("Задача мобильных вкладок");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        status: "todo",
      });

      await openKanban(page, projectTitle);

      const tabs = page.getByTestId("kanban-mobile-tabs");

      await expect(tabs).toBeVisible();
      await expect(page.getByTestId("kanban-tab-backlog")).toHaveAttribute("aria-selected", "true");

      const snapType = await page
        .getByTestId("kanban-columns")
        .evaluate((element) => getComputedStyle(element).scrollSnapType);

      expect(snapType).toContain("x");

      await page.getByTestId("kanban-tab-done").click();
      await expect(page.getByTestId("kanban-tab-done")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("kanban-tab-backlog")).toHaveAttribute(
        "aria-selected",
        "false",
      );
      await expect
        .poll(async () => {
          const box = await column(page, "done").boundingBox();

          return box !== null && box.x >= -2 && box.x < MOBILE_VIEWPORT.width;
        })
        .toBe(true);
      await expectNoHorizontalOverflow(page);

      await page.getByTestId("kanban-tab-todo").click();
      await expect(page.getByTestId("kanban-tab-todo")).toHaveAttribute("aria-selected", "true");
      await expectCardInColumn(page, taskId, "todo");
      await expect
        .poll(async () => {
          const box = await column(page, "todo").boundingBox();

          return box !== null && box.x >= -2 && box.x < MOBILE_VIEWPORT.width;
        })
        .toBe(true);
    });
    test("интерактивные элементы карточки не меньше 40 px", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект hit targets");
      const taskTitle = uniqueTitle("Карточка hit targets");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        status: "todo",
      });

      await openKanban(page, projectTitle);

      const card = page.getByTestId(`kanban-card-${taskId}`);

      await expect(card).toBeVisible();

      for (const target of [
        page.getByTestId(`kanban-open-${taskId}`),
        page.getByTestId(`kanban-drag-${taskId}`),
        card.locator("summary"),
      ]) {
        const box = await target.boundingBox();

        expect(box).not.toBeNull();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }

      await card.locator("summary").click();

      const menu = card.getByRole("group", { name: `Перемещение задачи ${taskTitle}` });
      const menuButtons = menu.getByRole("button");
      const buttonCount = await menuButtons.count();

      expect(buttonCount).toBeGreaterThanOrEqual(7);

      for (let index = 0; index < buttonCount; index += 1) {
        const box = await menuButtons.nth(index).boundingBox();

        expect(box).not.toBeNull();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
    });
  });

  test.describe("десктопный viewport", () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test("показывает и скрывает scroll affordance при overflow", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект scroll affordance");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const columns = page.getByTestId("kanban-columns");
      const metrics = await columns.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));

      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
      await expect(page.getByTestId("kanban-scroll-hint")).toBeVisible();
      await expect(page.getByTestId("kanban-scroll-fade")).toHaveCount(1);

      await columns.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });

      await expect
        .poll(async () => columns.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      await expect(page.getByTestId("kanban-scroll-hint")).toHaveCount(0);
      await expect(page.getByTestId("kanban-scroll-fade")).toHaveCount(0);

      await columns.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await expect(page.getByTestId("kanban-scroll-hint")).toBeVisible();
    });

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
