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
  readonly status?: string;
  readonly dueAt?: string;
  readonly tags?: string;
}

async function createTask(page: Page, seed: TaskSeed): Promise<string> {
  await page.getByTestId("create-task-button").click();

  const form = page.getByTestId("task-form-create");

  await expect(form).toBeVisible();
  // <select> вложен в <label>, поэтому label.textContent включает тексты
  // option; надёжнее адресоваться по доступному имени combobox.
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

  await form.getByRole("button", { name: "Создать задачу" }).click();
  await expect(form).toHaveCount(0);

  // После создания список открывает детали через query string.
  await expect(page).toHaveURL(/[?&]task=/u);

  const taskId = new URL(page.url()).searchParams.get("task");

  expect(taskId).not.toBeNull();

  return taskId as string;
}

async function closeDetails(page: Page, variant: "mobile" | "desktop"): Promise<void> {
  const panel =
    variant === "mobile"
      ? page.getByTestId("task-details-mobile")
      : page.getByTestId("task-details-desktop");

  await panel.getByRole("button", { name: "Закрыть детали" }).click();
  await expect(page).not.toHaveURL(/[?&]task=/u);
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

      await expect(mobileCard(page, alphaTitle)).toBeVisible();
      await expect(mobileCard(page, betaTitle)).toBeVisible();

      // Проект: обе задачи принадлежат выбранному проекту.
      const filters = page.getByTestId("task-filters");

      await filters
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await expect(page).toHaveURL(/[?&]project=/u);

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

      // Сброс фильтров возвращает обе задачи и очищает query string.
      await page.getByRole("button", { name: "Сбросить фильтры" }).click();
      await expect(page).not.toHaveURL(/[?&](project|priority)=/u);
      await expect(mobileCard(page, betaTitle)).toBeVisible();

      // Для детерминированной сортировки снова ограничиваем список проектом:
      // в общей базе E2E уже есть задачи из предыдущих сценариев.
      await filters
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });

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

      await expect(page.getByTestId("task-cards")).toBeVisible();
      await expect(page.getByTestId("task-table")).toBeHidden();
      await expectNoHorizontalOverflow(page);

      await mobileCard(page, taskTitle).click();

      const overlay = page.getByTestId("task-details-mobile");

      await expect(overlay).toBeVisible();
      await expect(overlay).toHaveAttribute("role", "dialog");
      await expect(overlay).toContainText(taskTitle);
      await expect(page.getByTestId("task-details-desktop")).toBeHidden();
      await expectNoHorizontalOverflow(page);

      await overlay.getByRole("button", { name: "Закрыть детали" }).click();
      await expect(overlay).toHaveCount(0);
    });

    test("открывает карточку и закрывает детали с клавиатуры", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект клавиатуры");
      const taskTitle = uniqueTitle("Клавиатурная задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, { projectTitle, title: taskTitle });
      await closeDetails(page, "mobile");

      // Снимаем фокус с исчезнувшей кнопки и проходим Tab-порядок shell.
      await page.locator("h1", { hasText: "Задачи" }).click();

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
      await expect(page.getByTestId("task-details-mobile")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(page.getByTestId("task-details-mobile")).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);
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
  });
});
