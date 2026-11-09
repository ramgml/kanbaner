import { expect, test, type Page } from "@playwright/test";

/**
 * Сквозные сценарии списка задач в production shell.
 *
 * Тест работает только через публичное поведение: UI-вклады приходят с
 * сервера, действия вызывают те же команды и запросы `kanbaner.tasks`, что и
 * HTTP API. Отдельная база создаётся Playwright-конфигурацией, поэтому
 * сценарии не зависят от пользовательских данных.
 */

const MOBILE_VIEWPORT = { width: 360, height: 740 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

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

function viewportIsMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? DESKTOP_VIEWPORT.width) < 768;
}

async function openProjectCreator(page: Page): Promise<import("@playwright/test").Locator> {
  // Видимая кнопка заголовка списка — единая точка входа на desktop и mobile.
  // Она открывает sidebar-форму либо bottom sheet, не кликая скрытый DOM.
  const opener = page.getByTestId("create-project-button");

  await expect(opener).toBeVisible();
  await opener.click();

  const form = page.getByTestId("project-form");

  await expect(form).toBeVisible();

  return form;
}

async function createProject(page: Page, title: string): Promise<void> {
  const beforeProjectId = new URL(page.url()).searchParams.get("project");
  const form = await openProjectCreator(page);

  await form.getByLabel("Название проекта", { exact: true }).fill(title);
  await form.getByRole("button", { name: "Создать проект" }).click();
  await expect(form).toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .not.toBe(beforeProjectId);
  await expect(page).toHaveURL(/[?&]project=/u);
  await expect(page.getByTestId("create-task-button")).toBeEnabled();
}

interface TaskSeed {
  readonly projectTitle: string;
  readonly title: string;
  readonly priority?: string;
  readonly status?: string;
  readonly dueAt?: string;
  readonly tags?: string;
  readonly parentTitle?: string;
}

function hasTaskExtras(seed: TaskSeed): boolean {
  return (
    seed.priority !== undefined ||
    (seed.status !== undefined && seed.status !== "todo") ||
    seed.dueAt !== undefined ||
    seed.tags !== undefined
  );
}

async function openTaskDetails(page: Page): Promise<import("@playwright/test").Locator> {
  const desktop = page.getByTestId("task-details-desktop");

  if ((await desktop.count()) > 0 && (await desktop.isVisible())) {
    return desktop;
  }

  return page.getByTestId("task-details-mobile");
}

async function editTaskDetails(page: Page, seed: TaskSeed): Promise<void> {
  const panel = await openTaskDetails(page);

  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Редактировать", exact: true }).click();

  const form = page.getByTestId("task-form-edit");

  await expect(form).toBeVisible();

  if (seed.priority !== undefined) {
    await form
      .getByRole("combobox", { name: "Приоритет", exact: true })
      .selectOption(seed.priority);
  }

  if (seed.dueAt !== undefined) {
    await form.getByLabel("Срок", { exact: true }).fill(seed.dueAt);
  }

  if (seed.tags !== undefined) {
    await form.getByLabel("Теги через запятую", { exact: true }).fill(seed.tags);
  }

  await form.getByRole("button", { name: "Сохранить задачу" }).click();
  await expect(form).toHaveCount(0);

  if (seed.status !== undefined && seed.status !== "todo") {
    const next = await openTaskDetails(page);
    const move = next.getByRole("button", { name: "Переместить", exact: true });

    await next
      .getByRole("combobox", { name: "Переместить в", exact: true })
      .selectOption(seed.status);
    await move.click();
    await expect(move).toBeDisabled();
  }
}

async function closeDetails(page: Page, variant: "mobile" | "desktop"): Promise<void> {
  if (!new URL(page.url()).searchParams.has("task")) {
    return;
  }

  const panel =
    variant === "mobile"
      ? page.getByTestId("task-details-mobile")
      : page.getByTestId("task-details-desktop");

  await panel.getByRole("button", { name: "Закрыть детали" }).click();
  await expect(page).not.toHaveURL(/[?&]task=/u);
}

/**
 * Создаёт подзадачу публичным путём: через форму подзадачи в Trello-модале.
 * `task.update` не меняет родителя, поэтому иного UI-способа нет.
 */
async function createSubtask(page: Page, seed: TaskSeed): Promise<string> {
  const projectId = new URL(page.url()).searchParams.get("project");

  expect(projectId).not.toBeNull();
  await page.goto(`/view/kanban?project=${projectId}`);
  await expect(page.getByTestId("kanban-columns")).toBeVisible();

  const parent = page
    .getByTestId("kanban-view")
    .locator("[data-card-id]")
    .filter({ hasText: seed.parentTitle ?? "" });

  await expect(parent).toHaveCount(1);

  const parentId = await parent.getAttribute("data-card-id");

  expect(parentId).not.toBeNull();
  await page.getByTestId(`kanban-open-${parentId}`).click();
  await expect(page.getByTestId("kanban-details")).toBeVisible();
  await page.getByTestId("kanban-subtask-create").click();
  await page.getByTestId("kanban-subtask-input").fill(seed.title);

  if (seed.status !== undefined) {
    await page
      .getByRole("combobox", { name: "Статус подзадачи", exact: true })
      .selectOption(seed.status);
  }

  await page.getByTestId("kanban-subtask-submit").click();

  const item = page.locator('[data-testid^="kanban-subtask-"]').filter({ hasText: seed.title });

  await expect(item).toHaveCount(1);

  const testId = await item.getAttribute("data-testid");
  const taskId = (testId ?? "").replace("kanban-subtask-", "");

  expect(taskId.length).toBeGreaterThan(0);

  if (seed.tags !== undefined || seed.dueAt !== undefined || seed.priority !== undefined) {
    await page.getByTestId(`kanban-subtask-${taskId}`).click();
    await page.getByTestId("kanban-modal-edit").click();

    const form = page.getByTestId("task-form-edit");

    await expect(form).toBeVisible();

    if (seed.priority !== undefined) {
      await form
        .getByRole("combobox", { name: "Приоритет", exact: true })
        .selectOption(seed.priority);
    }

    if (seed.dueAt !== undefined) {
      await form.getByLabel("Срок", { exact: true }).fill(seed.dueAt);
    }

    if (seed.tags !== undefined) {
      await form.getByLabel("Теги через запятую", { exact: true }).fill(seed.tags);
    }

    await form.getByRole("button", { name: "Сохранить задачу" }).click();
    await expect(form).toHaveCount(0);
  }

  if ((await page.getByTestId("kanban-details").count()) > 0) {
    await page.getByTestId("kanban-details-close").click();
    await expect(page.getByTestId("kanban-details")).toHaveCount(0);
  }

  await page.goto(`/view/tasks?project=${projectId}`);
  await expect(page.getByTestId("task-list-view")).toBeVisible();

  return taskId;
}

async function createTask(page: Page, seed: TaskSeed): Promise<string> {
  if (new URL(page.url()).searchParams.has("task")) {
    await closeDetails(page, viewportIsMobile(page) ? "mobile" : "desktop");
  }

  if (seed.parentTitle !== undefined) {
    return createSubtask(page, seed);
  }

  await page.getByTestId("create-task-button").click();

  const input = page.getByTestId("task-list-create-input");

  await expect(input).toBeVisible();
  await input.fill(seed.title);
  await page.getByTestId("task-list-create-submit").click();
  await expect(page.getByTestId("task-list-create-panel")).toHaveCount(0);

  // После создания список открывает детали через query string.
  await expect(page).toHaveURL(/[?&]task=/u);

  const taskId = new URL(page.url()).searchParams.get("task");

  expect(taskId).not.toBeNull();

  if (hasTaskExtras(seed)) {
    await editTaskDetails(page, seed);
  }

  return taskId as string;
}

/**
 * Ограничивает общий список проектом сценария.
 *
 * База E2E общая для всех спеков (включая kanban), поэтому новая карточка не
 * обязана попадать на первую страницу общего списка по `position, id`.
 * Изоляция по проекту делает проверки независимыми от накопленного dataset.
 */
async function filterTaskListByProject(page: Page, projectTitle: string): Promise<void> {
  await page
    .getByTestId("task-filters")
    .getByRole("combobox", { name: "Проект", exact: true })
    .selectOption({ label: projectTitle });
  await expect(page).toHaveURL(/[?&]project=/u);
}

function mobileCard(page: Page, title: string) {
  return page.getByTestId("task-cards").getByRole("button", {
    name: `Открыть карточку задачи ${title}`,
  });
}

function desktopRow(page: Page, taskId: string) {
  return page.getByTestId(`task-row-${taskId}`);
}

test.describe("список задач в production shell", () => {
  test.describe.configure({ timeout: 90_000 });

  test.describe("мобильный viewport", () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test("создаёт проект и задачу и показывает их в списке", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект списка");
      const taskTitle = uniqueTitle("Первая задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        priority: "high",
        status: "todo",
        dueAt: "2030-01-10",
        tags: "release, backend",
      });

      await closeDetails(page, "mobile");
      await filterTaskListByProject(page, projectTitle);

      await expect(page.getByTestId(`task-card-${taskId}`)).toBeVisible();
      await expect(mobileCard(page, taskTitle)).toBeVisible();
      await expect(page.getByTestId(`task-card-${taskId}`)).toContainText(projectTitle);
      await expect(page.getByTestId(`task-card-${taskId}`)).toContainText("К выполнению");
      await expect(page.getByTestId(`task-card-${taskId}`)).toContainText("Высокий");
      await expect(page.getByTestId(`task-card-${taskId}`)).toContainText("10.01.2030");
      await expect(page.getByTestId("task-pagination")).toContainText("Всего задач:");

      // Список задач читает те же данные после полной перезагрузки.
      await page.reload();
      await openTaskList(page);
      await filterTaskListByProject(page, projectTitle);
      await expect(mobileCard(page, taskTitle)).toBeVisible();
    });

    test("фильтрует, сортирует и сохраняет состояние в адресе", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект фильтров");
      const alphaTitle = `Alpha ${projectTitle}`;
      const betaTitle = `Beta ${projectTitle}`;

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, {
        projectTitle,
        title: alphaTitle,
        priority: "high",
        dueAt: "2030-01-10",
        tags: "release",
      });
      await closeDetails(page, "mobile");
      await createTask(page, {
        projectTitle,
        title: betaTitle,
        priority: "low",
        dueAt: "2030-02-20",
        tags: "backend",
      });
      await closeDetails(page, "mobile");

      // Общий список уже содержит задачи kanban и других спеков, поэтому
      // сразу ограничиваем его проектом сценария: Alpha и Beta не обязаны
      // попадать на первую страницу по общему dataset.
      const filters = page.getByTestId("task-filters");

      await filterTaskListByProject(page, projectTitle);
      await expect(mobileCard(page, alphaTitle)).toBeVisible();
      await expect(mobileCard(page, betaTitle)).toBeVisible();

      // Приоритет: остаётся только задача с высоким приоритетом.
      await filters.getByRole("combobox", { name: "Приоритет", exact: true }).selectOption("high");
      await expect(page).toHaveURL(/[?&]priority=high/u);
      await expect(mobileCard(page, alphaTitle)).toBeVisible();
      await expect(mobileCard(page, betaTitle)).toHaveCount(0);

      // Состояние переживает перезагрузку страницы.
      await page.reload();
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(filters.getByRole("combobox", { name: "Приоритет", exact: true })).toHaveValue(
        "high",
      );
      await expect(mobileCard(page, alphaTitle)).toBeVisible();
      await expect(mobileCard(page, betaTitle)).toHaveCount(0);

      // Сброс фильтров очищает приоритет, но сохраняет проект: проект задаётся
      // рабочим пространством, а не фильтром списка.
      await page.getByRole("button", { name: "Сбросить фильтры" }).click();
      await expect(page).toHaveURL(/[?&]project=/u);
      await expect(page).not.toHaveURL(/[?&]priority=/u);
      await expect(filters.getByRole("combobox", { name: "Проект", exact: true })).not.toHaveValue(
        "",
      );

      await filterTaskListByProject(page, projectTitle);
      await expect(mobileCard(page, alphaTitle)).toBeVisible();
      await expect(mobileCard(page, betaTitle)).toBeVisible();

      // Сортировка по названию: по возрастанию, затем по убыванию.
      const sortSelect = page.getByRole("combobox", { name: "Сортировка", exact: true });

      await sortSelect.selectOption("title");
      await expect(page).toHaveURL(/[?&]sort=title/u);
      await expect
        .poll(async () => page.getByTestId("task-cards").getByRole("button").allTextContents())
        .toEqual([alphaTitle, betaTitle]);

      await page.getByRole("button", { name: "Направление: по возрастанию" }).click();
      await expect(page).toHaveURL(/[?&]dir=desc/u);
      await expect
        .poll(async () => page.getByTestId("task-cards").getByRole("button").allTextContents())
        .toEqual([betaTitle, alphaTitle]);
    });

    test("на 360 px показывает карточки и полноэкранные детали без overflow", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект 360");
      const taskTitle = uniqueTitle("Мобильная задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, {
        projectTitle,
        title: taskTitle,
        priority: "medium",
        tags: "mobile",
      });
      await closeDetails(page, "mobile");
      await filterTaskListByProject(page, projectTitle);

      await expect(page.getByTestId("task-cards")).toBeVisible();
      await expect(page.getByTestId("task-table")).toBeHidden();
      await expectNoHorizontalOverflow(page);

      await mobileCard(page, taskTitle).click();

      const overlay = page.getByTestId("task-details-mobile");

      await expect(overlay).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Детали задачи" })).toBeVisible();
      await expect(overlay).toContainText(taskTitle);
      expect(await overlay.evaluate((element) => element.tagName)).toBe("DIALOG");
      await expect(page.getByTestId("task-details-desktop")).toBeHidden();
      await expectNoHorizontalOverflow(page);

      await overlay.getByRole("button", { name: "Закрыть детали" }).click();
      await expect(overlay).toHaveCount(0);
      // После закрытия фокус возвращается на карточку, открывшую детали.
      await expect
        .poll(async () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
        )
        .toBe(`Открыть карточку задачи ${taskTitle}`);
    });

    test("открывает карточку и закрывает детали с клавиатуры", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект клавиатуры");
      const taskTitle = uniqueTitle("Клавиатурная задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, { projectTitle, title: taskTitle });
      await closeDetails(page, "mobile");
      await filterTaskListByProject(page, projectTitle);

      // Снимаем фокус с исчезнувшей кнопки и проходим Tab-порядок shell.
      // Заголовок списка — название выбранного проекта.
      await page.getByTestId("project-board-title").click();

      let reachedCard = false;

      for (let index = 0; index < 120; index += 1) {
        await page.keyboard.press("Tab");

        const focused = await page.evaluate(() => ({
          label: document.activeElement?.getAttribute("aria-label") ?? null,
        }));

        if (focused.label === `Открыть карточку задачи ${taskTitle}`) {
          reachedCard = true;
          break;
        }
      }

      expect(reachedCard).toBe(true);

      await page.keyboard.press("Enter");

      const dialog = page.getByRole("dialog", { name: "Детали задачи" });

      await expect(dialog).toBeVisible();

      // После showModal фокус находится внутри диалога, а Tab не выходит за
      // его пределы: нативный <dialog> удерживает focus trap.
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);

      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
          true,
        );
      }

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);
      // Escape закрывает диалог и возвращает фокус на карточку.
      await expect
        .poll(async () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
        )
        .toBe(`Открыть карточку задачи ${taskTitle}`);
    });

    test("переключает вид внутри мобильного модала кликом и клавиатурой", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект modal toggle");
      const taskTitle = uniqueTitle("Задача modal toggle");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, { projectTitle, title: taskTitle });
      await closeDetails(page, "mobile");
      await filterTaskListByProject(page, projectTitle);

      await mobileCard(page, taskTitle).click();

      const dialog = page.getByTestId("task-details-mobile");

      await expect(dialog).toBeVisible();

      const list = dialog.getByTestId("task-details-view-list");
      const kanban = dialog.getByTestId("task-details-view-kanban");

      await expect(list).toHaveAttribute("aria-pressed", "true");
      await expect(kanban).toHaveAttribute("aria-pressed", "false");
      await expect(dialog).toHaveAttribute("aria-label", "Детали задачи");

      // Обычный click по ссылке внутри inert-диалога без evaluate.
      await kanban.click();

      await expect(page).toHaveURL(/\/view\/kanban\?[^#]*[?&]task=/u);
      await expect(page.getByTestId("kanban-details")).toBeVisible();

      // Обратно — клавиатурой по переключателю внутри уже канбан-модала.
      const back = page.getByTestId("project-view-modal-list");

      await back.focus();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(/\/view\/tasks\?[^#]*[?&]task=/u);
      await expect(page.getByTestId("task-details-mobile")).toBeVisible();
    });
  });

  test.describe("десктопный viewport", () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test("показывает детали и редактирует задачу, родитель только для чтения", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект редактора");
      const taskTitle = uniqueTitle("Задача редактора");
      const updatedTitle = uniqueTitle("Обновлённая задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        priority: "low",
        dueAt: "2031-05-05",
        tags: "ui, edit",
      });

      await filterTaskListByProject(page, projectTitle);
      await expect(page.getByTestId("task-table")).toBeVisible();
      await expect(page.getByTestId("task-cards")).toBeHidden();
      await expect(desktopRow(page, taskId)).toContainText(taskTitle);

      const details = page.getByTestId("task-details-desktop");

      await expect(details).toBeVisible();
      await expect(details).toContainText("Версия");
      await details.getByRole("button", { name: "Редактировать" }).click();

      const form = page.getByTestId("task-form-edit");

      await expect(form).toBeVisible();
      await expect(form.getByText("Родительская задача")).toBeVisible();
      await expect(form.getByText("Без родителя (корневая)")).toBeVisible();
      // Осознанное ограничение: `task.update` не меняет parentTaskId,
      // поэтому в edit родитель показан только для чтения.
      await expect(form.locator('select[name="parentTaskId"]')).toHaveCount(0);
      await expect(form.getByRole("combobox", { name: "Проект", exact: true })).toBeDisabled();

      await form.getByLabel("Название", { exact: true }).fill(updatedTitle);
      await form.getByRole("combobox", { name: "Приоритет", exact: true }).selectOption("high");
      await form.getByLabel("Теги через запятую", { exact: true }).fill("ui, edited");
      await form.getByRole("button", { name: "Сохранить задачу" }).click();

      await expect(form).toHaveCount(0);
      await expect(details.getByRole("heading", { name: updatedTitle })).toBeVisible();
      await expect(details).toContainText("Высокий");
      await expect(desktopRow(page, taskId)).toContainText(updatedTitle);

      await page.reload();
      await openTaskList(page);
      await filterTaskListByProject(page, projectTitle);
      await expect(desktopRow(page, taskId)).toContainText(updatedTitle);
    });

    test("не перезаписывает задачу при VERSION_CONFLICT из второй вкладки", async ({
      page,
      context,
    }) => {
      const projectTitle = uniqueTitle("Проект конфликта");
      const taskTitle = uniqueTitle("Задача конфликта");
      const firstTitle = uniqueTitle("Правка вкладки A");
      const staleTitle = uniqueTitle("Правка вкладки B");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle });

      await filterTaskListByProject(page, projectTitle);

      const taskUrl = page.url();

      const stalePage = await context.newPage();

      await stalePage.goto(taskUrl);
      await expect(stalePage.getByTestId("task-details-desktop")).toContainText(taskTitle);

      // Вкладка A сохраняет первую версию.
      const firstDetails = page.getByTestId("task-details-desktop");

      await firstDetails.getByRole("button", { name: "Редактировать" }).click();

      const firstForm = page.getByTestId("task-form-edit");

      await firstForm.getByLabel("Название", { exact: true }).fill(firstTitle);
      await firstForm.getByRole("button", { name: "Сохранить задачу" }).click();
      await expect(firstDetails.getByRole("heading", { name: firstTitle })).toBeVisible();

      // Вкладка B держит устаревшую версию и не должна её перезаписать.
      const staleDetails = stalePage.getByTestId("task-details-desktop");

      await staleDetails.getByRole("button", { name: "Редактировать" }).click();

      const staleForm = stalePage.getByTestId("task-form-edit");

      await staleForm.getByLabel("Название", { exact: true }).fill(staleTitle);
      await staleForm.getByRole("button", { name: "Сохранить задачу" }).click();

      await expect(stalePage.getByTestId("task-details-error")).toContainText(
        "Задача уже изменена в другом месте",
      );
      // Данные перечитаны: видна правка A, правка B не потеряна молча в UI.
      await expect(staleDetails.getByRole("heading", { name: firstTitle })).toBeVisible();
      await expect(staleDetails).not.toContainText(staleTitle);

      await firstDetails.getByRole("button", { name: "Закрыть детали" }).click();
      await page.reload();
      await openTaskList(page);
      await filterTaskListByProject(page, projectTitle);
      await expect(desktopRow(page, taskId)).toContainText(firstTitle);
      await expect(desktopRow(page, taskId)).not.toContainText(staleTitle);

      await stalePage.close();
    });

    test("удаляет задачу только после inline-подтверждения", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект удаления");
      const taskTitle = uniqueTitle("Удаляемая задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle });

      await filterTaskListByProject(page, projectTitle);

      const details = page.getByTestId("task-details-desktop");

      await expect(details.getByTestId("task-delete-confirm-panel")).toHaveCount(0);
      await details.getByTestId("task-delete").click();
      await expect(details.getByTestId("task-delete-confirm-panel")).toBeVisible();
      await expect(desktopRow(page, taskId)).toBeVisible();

      // Отмена не удаляет задачу.
      await details.getByTestId("task-delete-cancel").click();
      await expect(details.getByTestId("task-delete-confirm-panel")).toHaveCount(0);
      await expect(desktopRow(page, taskId)).toBeVisible();

      await details.getByTestId("task-delete").click();
      await details.getByTestId("task-delete-confirm").click();

      await expect(details).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);
      await expect(desktopRow(page, taskId)).toHaveCount(0);

      await page.reload();
      await openTaskList(page);
      await expect(desktopRow(page, taskId)).toHaveCount(0);
    });

    test("не показывает детали вне /view/tasks и скрывает их при переходе по Link", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект маршрута");
      const taskTitle = uniqueTitle("Задача маршрута");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle });

      await closeDetails(page, "desktop");

      // Прямой адрес чужого раздела с task= не должен открывать детали.
      await page.goto(`/settings/plugins?task=${taskId}`);
      await expect(page.getByRole("heading", { name: "Плагины" })).toBeVisible();
      await expect(page.getByTestId("task-details-desktop")).toHaveCount(0);
      await expect(page.getByTestId("task-details-mobile")).toHaveCount(0);

      // Открываем детали на своём маршруте и уходим client-side Link-ом.
      await page.goto(`/view/tasks?task=${taskId}`);
      await expect(page.getByTestId("task-details-desktop")).toBeVisible();

      await page.getByTestId("settings-link-desktop").click();
      await expect(page.getByRole("heading", { name: "Настройки", level: 1 })).toBeVisible();
      await expect(page.getByTestId("task-details-desktop")).toHaveCount(0);
      await expect(page.getByTestId("task-details-mobile")).toHaveCount(0);
    });

    test("сохраняет задачу, тег и проект при переключении вида", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект toggle");
      const otherProjectTitle = uniqueTitle("Второй проект toggle");
      const taskTitle = uniqueTitle("Задача toggle");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        tags: "release",
      });

      await closeDetails(page, "desktop");
      await createProject(page, otherProjectTitle);

      // Возвращаемся в первый проект и задаём тег: дальше проверяем, что
      // toggle и смена проекта в sidebar не теряют query-контекст.
      await page
        .getByTestId("projects-sidebar-list")
        .getByRole("button", { name: projectTitle, exact: true })
        .click();

      const filters = page.getByTestId("task-filters");

      await filters.getByLabel("Тег", { exact: true }).fill("release");
      await expect(page).toHaveURL(/[?&]tag=release/u);

      await desktopRow(page, taskId)
        .getByRole("button", { name: `Открыть задачу ${taskTitle}` })
        .click();
      await expect(page).toHaveURL(new RegExp(`[?&]task=${taskId}`, "u"));

      const projectId = new URL(page.url()).searchParams.get("project");

      expect(projectId).not.toBeNull();

      // Внутри одного проекта toggle сохраняет project, tag и task.
      await page.getByTestId("project-view-kanban").click();

      await expect(page).toHaveURL(
        new RegExp(
          `/view/kanban\\?[^#]*project=${projectId}[^#]*tag=release[^#]*task=${taskId}`,
          "u",
        ),
      );
      await expect(page.getByTestId("kanban-details")).toBeVisible();

      // Обратно в список тем же доступным переключателем внутри модала.
      await page.getByTestId("project-view-modal-list").click();

      await expect(page).toHaveURL(/\/view\/tasks\?[^#]*tag=release[^#]*task=/u);
      await expect(page.getByTestId("task-details-desktop")).toContainText(taskTitle);

      // Смена проекта в sidebar сохраняет тег, но осознанно снимает task:
      // он принадлежит прежнему проекту.
      await page
        .getByTestId("projects-sidebar-list")
        .getByRole("button", { name: otherProjectTitle, exact: true })
        .click();

      await expect(page).toHaveURL(/[?&]project=/u);
      await expect(page).not.toHaveURL(/[?&]task=/u);
      await expect(page).toHaveURL(/[?&]tag=release/u);

      // Переключение представления после смены проекта сохраняет оба фильтра.
      await page.getByTestId("project-view-kanban").click();

      await expect(page).toHaveURL(/\/view\/kanban\?[^#]*tag=release/u);
      await expect(page).not.toHaveURL(/[?&]task=/u);

      await page.getByTestId("project-view-list").click();

      await expect(page).toHaveURL(/\/view\/tasks\?[^#]*tag=release/u);
      await expect(filters.getByLabel("Тег", { exact: true })).toHaveValue("release");
    });

    test("синхронизирует native dialog с breakpoint mobile→desktop→mobile", async ({ page }) => {
      test.setTimeout(120_000);

      const projectTitle = uniqueTitle("Проект resize");
      const taskTitle = uniqueTitle("Задача resize");

      await page.setViewportSize(MOBILE_VIEWPORT);
      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle });

      const dialog = page.getByTestId("task-details-mobile");

      await expect(dialog).toBeVisible();
      expect(
        await dialog.evaluate(
          (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
        ),
      ).toBe(true);

      // mobile → desktop: modal закрывается, :modal/inert-блокировка снята.
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await expect
        .poll(async () => dialog.evaluate((element) => (element as HTMLDialogElement).open))
        .toBe(false);
      expect(
        await page.evaluate(() => document.querySelector("dialog")?.matches(":modal") ?? false),
      ).toBe(false);

      const details = page.getByTestId("task-details-desktop");

      await expect(details).toBeVisible();

      // Фокус возвращён на видимый desktop-элемент, а не на скрытую карточку.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;

            return (
              element !== null &&
              element.getClientRects().length > 0 &&
              element.closest('[data-testid="task-cards"]') === null
            );
          }),
        )
        .toBe(true);

      // Desktop-панель полностью интерактивна при закрытом modal.
      await details.getByRole("button", { name: "Редактировать", exact: true }).click();

      const form = page.getByTestId("task-form-edit");

      await expect(form).toBeVisible();
      await form.getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(form).toHaveCount(0);

      // desktop → mobile: showModal и initial focus выполняются заново.
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect
        .poll(async () =>
          dialog.evaluate(
            (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
          ),
        )
        .toBe(true);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);
      await expect(dialog).toContainText(taskTitle);
      await expect(page.locator(`[data-testid="task-row-${taskId}"]`)).toBeHidden();
    });

    test("пагинирует больше 25 задач с page=2 в URL и переживает reload", async ({ page }) => {
      test.setTimeout(180_000);

      const projectTitle = uniqueTitle("Проект пагинации");
      const titles = Array.from(
        { length: 26 },
        (_, index) => `${projectTitle} задача ${String(index + 1).padStart(2, "0")}`,
      );
      const lastTitle = titles[25] ?? "";

      await openTaskList(page);
      await createProject(page, projectTitle);

      for (const title of titles) {
        await createTask(page, { projectTitle, title, status: "todo" });
      }

      await closeDetails(page, "desktop");

      const filters = page.getByTestId("task-filters");

      await filters
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await page.getByRole("combobox", { name: "Сортировка", exact: true }).selectOption("title");

      const rows = page.locator('[data-testid^="task-row-"]');

      await expect(page.getByTestId("task-pagination")).toContainText("Страница 1 из 2");
      await expect(rows).toHaveCount(25);

      await page.getByRole("button", { name: "Вперёд", exact: true }).click();

      await expect(page).toHaveURL(/[?&]page=2/u);
      await expect(page.getByTestId("task-pagination")).toContainText("Страница 2 из 2");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(lastTitle);

      // Offset вычисляется из URL после полной перезагрузки.
      await page.reload();
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page.getByTestId("task-pagination")).toContainText("Страница 2 из 2");
      await expect(page.locator('[data-testid^="task-row-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid^="task-row-"]').first()).toContainText(lastTitle);
    });

    test("переживает отключение и включение kanbaner.projects без потери задач", async ({
      page,
    }) => {
      test.setTimeout(180_000);

      const projectTitle = uniqueTitle("Проект отключения");
      const taskTitle = uniqueTitle("Задача отключения");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle });

      await closeDetails(page, "desktop");

      await page.goto("/settings/plugins");

      const toggle = page.getByRole("switch", {
        name: "Включить плагин Kanbaner Projects",
      });

      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(page.getByRole("heading", { name: "Kanbaner Projects" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Плагины" })).toBeVisible();

      // Без UI-плагина не зарегистрированы оба маршрута рабочего пространства,
      // но shell жив.
      await page.goto("/view/tasks");
      await expect(page.getByTestId("plugin-view-empty")).toBeVisible();

      await page.goto("/view/kanban");
      await expect(page.getByTestId("plugin-view-empty")).toBeVisible();

      await page.goto("/settings/plugins");

      const restoredToggle = page.getByRole("switch", {
        name: "Включить плагин Kanbaner Projects",
      });

      await restoredToggle.click();
      await expect(restoredToggle).toHaveAttribute("aria-checked", "true");

      // Данные остались в kanbaner.tasks: список снова показывает задачу.
      await page.goto("/view/tasks");
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await page
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await expect(desktopRow(page, taskId)).toContainText(taskTitle);
    });

    test("подзадача, завершение и фильтры status/tag/due", async ({ page }) => {
      test.setTimeout(120_000);

      const projectTitle = uniqueTitle("Проект подзадачи");
      const parentTitle = uniqueTitle("Родительская задача");
      const childTitle = uniqueTitle("Дочерняя задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, {
        projectTitle,
        title: parentTitle,
        status: "todo",
        tags: "parenttag",
        dueAt: "2030-03-15",
      });
      await closeDetails(page, "desktop");

      const childId = await createTask(page, {
        projectTitle,
        title: childTitle,
        parentTitle,
        status: "in_progress",
        tags: "childtag",
        dueAt: "2030-04-20",
      });

      await closeDetails(page, "desktop");
      await filterTaskListByProject(page, projectTitle);

      await page.getByRole("button", { name: `Открыть задачу ${childTitle}` }).click();

      const details = page.getByTestId("task-details-desktop");

      await expect(details).toContainText("Родительская задача");
      await expect(details).toContainText(parentTitle);

      // complete выставляет статус и completedAt; completedAt проверяется
      // server-side integration-тестом, здесь — наблюдаемый статус.
      await details.getByRole("button", { name: "Завершить", exact: true }).click();
      await expect(details).toContainText("Готово");
      await expect(details.getByRole("button", { name: "Завершить", exact: true })).toHaveCount(0);

      const filters = page.getByTestId("task-filters");

      await filters
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });

      await filters.getByRole("combobox", { name: "Статус", exact: true }).selectOption("done");
      await expect(desktopRow(page, childId)).toContainText(childTitle);
      await expect(page.locator('[data-testid^="task-row-"]')).toHaveCount(1);

      await filters.getByRole("combobox", { name: "Статус", exact: true }).selectOption("");
      await filters.getByLabel("Тег", { exact: true }).fill("childtag");
      await expect(desktopRow(page, childId)).toContainText(childTitle);
      await expect(page.locator('[data-testid^="task-row-"]')).toHaveCount(1);

      await page.getByRole("button", { name: "Сбросить фильтры", exact: true }).click();
      await filters
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await filters.getByLabel("Срок с", { exact: true }).fill("2030-04-01");
      await filters.getByLabel("Срок по", { exact: true }).fill("2030-04-30");

      await expect(desktopRow(page, childId)).toContainText(childTitle);
      await expect(page.locator('[data-testid^="task-row-"]')).toHaveCount(1);
    });
  });
});
