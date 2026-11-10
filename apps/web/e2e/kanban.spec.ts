import { expect, test, type Locator, type Page } from "@playwright/test";

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
  backlog: "Backlog",
  todo: "ToDo",
  in_progress: "In Progress",
  done: "Done",
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

async function openProjectCreator(page: Page): Promise<Locator> {
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
  // URL с любым project= может совпасть со старым проектом: дожидаемся
  // именно нового id, иначе последующее чтение project из URL возьмёт чужой.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("project"))
    .not.toBe(beforeProjectId);
  await expect(page).toHaveURL(/[?&]project=/u);
  await expect(page.getByTestId("create-task-button")).toBeEnabled();
}

async function renameProject(page: Page, title: string): Promise<void> {
  await page.getByTestId("project-settings-button").click();

  const dialog = page.getByTestId("project-settings-dialog");

  await expect(dialog).toBeVisible();
  await page.getByTestId("project-settings-title-input").fill(title);
  await page.getByTestId("project-settings-title-save").click();
  await expect(page.getByTestId("project-settings-title-notice")).toContainText(
    "Название проекта сохранено",
  );
  await page.getByTestId("project-settings-done").click();
  await expect(dialog).toHaveCount(0);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTestId("project-settings-button").click();

  const dialog = page.getByTestId("project-settings-dialog");

  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("project-settings-columns")).toBeVisible();

  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId("project-settings-done").click();
  await expect(page.getByTestId("project-settings-dialog")).toHaveCount(0);
}

async function saveColumnTitle(page: Page, columnId: string, title: string): Promise<void> {
  await page.getByTestId(`project-settings-column-input-${columnId}`).fill(title);
  await page.getByTestId(`project-settings-column-save-${columnId}`).click();
  await expect(page.getByTestId(`project-settings-column-notice-${columnId}`)).toContainText(
    "Название колонки сохранено",
  );
}

async function settingsColumnIds(page: Page): Promise<string[]> {
  return page
    .locator("[data-settings-column-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-settings-column-id") ?? ""),
    );
}

interface TaskEditSeed {
  readonly priority?: string;
  readonly status?: keyof typeof STATUS_LABELS;
  readonly dueAt?: string;
  readonly tags?: string;
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

function hasTaskExtras(seed: TaskSeed): boolean {
  return (
    seed.priority !== undefined ||
    (seed.status !== undefined && seed.status !== "todo") ||
    seed.dueAt !== undefined ||
    seed.tags !== undefined
  );
}

async function openTaskDetails(page: Page): Promise<Locator> {
  const desktop = page.getByTestId("task-details-desktop");

  if ((await desktop.count()) > 0 && (await desktop.isVisible())) {
    return desktop;
  }

  return page.getByTestId("task-details-mobile");
}

async function editTaskDetails(page: Page, seed: TaskEditSeed): Promise<void> {
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
      .selectOption({ label: STATUS_LABELS[seed.status] });
    await move.click();
    await expect(move).toBeDisabled();
  }
}

async function editTaskInModal(page: Page, seed: TaskEditSeed): Promise<void> {
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

  if (seed.status !== undefined && seed.status !== "todo") {
    await page
      .getByTestId("kanban-modal-move-field")
      .selectOption({ label: STATUS_LABELS[seed.status] });
    await page.getByTestId("kanban-modal-move").click();
    await expect(page.getByTestId("kanban-modal-move")).toBeDisabled();
  }
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
      .getByRole("combobox", { name: "Колонка подзадачи", exact: true })
      .selectOption({ label: STATUS_LABELS[seed.status] });
  }

  await page.getByTestId("kanban-subtask-submit").click();

  const item = page.locator('[data-testid^="kanban-subtask-"]').filter({ hasText: seed.title });

  await expect(item).toHaveCount(1);

  const testId = await item.getAttribute("data-testid");
  const taskId = (testId ?? "").replace("kanban-subtask-", "");

  expect(taskId.length).toBeGreaterThan(0);

  if (seed.tags !== undefined || seed.dueAt !== undefined || seed.priority !== undefined) {
    await page.getByTestId(`kanban-subtask-${taskId}`).click();
    await editTaskInModal(page, {
      ...(seed.priority !== undefined ? { priority: seed.priority } : {}),
      ...(seed.dueAt !== undefined ? { dueAt: seed.dueAt } : {}),
      ...(seed.tags !== undefined ? { tags: seed.tags } : {}),
    });
  }

  if ((await page.getByTestId("kanban-details").count()) > 0) {
    await closeCardModal(page);
  }

  await page.goto(`/view/tasks?project=${projectId}`);
  await expect(page.getByTestId("task-list-view")).toBeVisible();

  return taskId;
}

async function createTask(page: Page, seed: TaskSeed): Promise<string> {
  if (new URL(page.url()).searchParams.has("task")) {
    await closeDetails(page);
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
  await expect(page).toHaveURL(/[?&]task=/u);

  const taskId = new URL(page.url()).searchParams.get("task");

  expect(taskId).not.toBeNull();

  if (hasTaskExtras(seed)) {
    await editTaskDetails(page, seed);
  }

  return taskId as string;
}

async function openKanban(page: Page, projectTitle: string): Promise<void> {
  await page.goto("/view/kanban");
  await expect(page.getByTestId("kanban-view")).toBeVisible();
  // Рабочее пространство само выбирает запомненный проект: отдельного экрана
  // выбора и фильтра проекта на доске больше нет.
  await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle, {
    timeout: 30_000,
  });
  await expect(page).toHaveURL(/[?&]project=/u);
  await expect(page.getByTestId("kanban-columns")).toBeVisible();
}

function column(page: Page, status: keyof typeof STATUS_LABELS) {
  return page.getByTestId(`kanban-column-${status}`);
}

function card(page: Page, taskId: string) {
  return page.getByTestId(`kanban-card-${taskId}`);
}

async function openCardModal(page: Page, taskId: string, title: string): Promise<Locator> {
  await page.getByTestId(`kanban-open-${taskId}`).click();

  const modal = page.getByTestId("kanban-details");

  await expect(modal).toBeVisible();
  await expect(page.getByTestId("kanban-modal-title")).toHaveText(title);

  return modal;
}

async function closeCardModal(page: Page): Promise<void> {
  await page.getByTestId("kanban-details-close").click();
  await expect(page.getByTestId("kanban-details")).toHaveCount(0);
}

async function expectCardInColumn(
  page: Page,
  taskId: string,
  status: keyof typeof STATUS_LABELS,
): Promise<void> {
  await expect(column(page, status).getByTestId(`kanban-card-${taskId}`)).toBeVisible();
  await expect(page.getByTestId(`kanban-pending-${taskId}`)).toHaveCount(0);
}

async function openCardActions(page: Page, taskId: string): Promise<Locator> {
  const trigger = page.getByTestId(`kanban-menu-${taskId}`);
  const menu = page.getByTestId(`kanban-card-menu-${taskId}`);

  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.focus();
    await page.keyboard.press("Enter");
  }

  await expect(menu).toBeVisible();

  return menu;
}

async function waitForCardSettled(page: Page, taskId: string): Promise<void> {
  await expect(card(page, taskId)).not.toHaveAttribute("aria-busy", "true");
}

async function moveWithMenu(
  page: Page,
  taskId: string,
  target: keyof typeof STATUS_LABELS,
): Promise<void> {
  const menu = await openCardActions(page, taskId);
  const button = menu.getByRole("menuitem", {
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
  const menu = await openCardActions(page, taskId);
  const button = menu.getByRole("menuitem", { name: label, exact: true });

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

async function columnIdByTitle(page: Page, title: string): Promise<string> {
  const boardColumn = page
    .locator("[data-kanban-column-id]")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

  await expect(boardColumn).toHaveCount(1);

  const id = await boardColumn.getAttribute("data-kanban-column-id");

  expect(id).not.toBeNull();

  return id as string;
}

async function columnIdList(page: Page): Promise<string[]> {
  return page
    .locator("[data-kanban-column-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-kanban-column-id") ?? ""),
    );
}

async function openColumnMenu(page: Page, columnId: string): Promise<void> {
  await page.locator(`[data-kanban-column-id="${columnId}"] header details summary`).click();
}

async function dragColumn(
  page: Page,
  sourceId: string,
  targetId: string,
  side: "left" | "right" | "center",
): Promise<void> {
  // Держим обе пользовательские колонки в viewport: иначе Playwright не может
  // доставить pointer события к правому краю широкой доски.
  await page.getByTestId("kanban-columns").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await page.waitForTimeout(100);

  const source = await page
    .locator(
      `[data-kanban-column-id="${sourceId}"] header button[aria-label^="Перетащить колонку"]`,
    )
    .boundingBox();
  const target = await page.locator(`[data-kanban-column-id="${targetId}"]`).boundingBox();

  expect(source).not.toBeNull();
  expect(target).not.toBeNull();

  if (source === null || target === null) {
    return;
  }

  const x =
    side === "left"
      ? target.x + 20
      : side === "right"
        ? target.x + target.width - 20
        : target.x + target.width / 2;

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, target.y + 24, { steps: 10 });
  await page.mouse.up();
}

async function addColumn(page: Page, title: string, type: "open" | "done"): Promise<string> {
  await page.getByTestId("kanban-add-column").click();
  await expect(page.getByTestId("kanban-column-form")).toBeVisible();
  await page.getByTestId("kanban-column-title-input").fill(title);
  await page.getByTestId("kanban-column-type").selectOption(type);
  await page.getByTestId("kanban-column-submit").click();
  await expect(page.getByTestId("kanban-column-form")).toHaveCount(0);

  return columnIdByTitle(page, title);
}

async function addCardToColumn(page: Page, columnId: string, title: string): Promise<void> {
  const boardColumn = page.locator(`[data-kanban-column-id="${columnId}"]`);

  await boardColumn.getByRole("button", { name: /Добавить карточку/u }).click();
  const input = boardColumn.locator('input[name="title"]');

  await input.fill(title);
  await input.press("Enter");
  await expect(boardColumn.getByText(title)).toBeVisible();
  await input.press("Escape");
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
  const y = position === "top" ? destination.y + 24 : destination.y + destination.height - 16;

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

/** Бросает карточку в нижнюю половину `afterTaskId`: между ней и следующей. */
async function dragCardAfter(page: Page, taskId: string, afterTaskId: string): Promise<void> {
  const handle = page.getByTestId(`kanban-drag-${taskId}`);
  const source = await handle.boundingBox();
  const after = page.getByTestId(`kanban-card-${afterTaskId}`);
  const destination = await after.boundingBox();

  expect(source).not.toBeNull();
  expect(destination).not.toBeNull();

  if (source === null || destination === null) {
    return;
  }

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    destination.x + destination.width / 2,
    destination.y + destination.height - 4,
    { steps: 10 },
  );
  await page.mouse.up();
}

async function dragCardFromPoint(
  page: Page,
  source: { readonly x: number; readonly y: number },
  target: keyof typeof STATUS_LABELS,
): Promise<void> {
  const destination = await column(page, target).boundingBox();

  expect(destination).not.toBeNull();

  if (destination === null) {
    return;
  }

  const x = destination.x + destination.width / 2;
  const y = destination.y + destination.height - 16;

  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

async function filterByProject(page: Page, projectTitle: string): Promise<void> {
  // Проект задаётся рабочим пространством, а не фильтром доски.
  await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
  await expect(page).toHaveURL(/[?&]project=/u);
}

async function openBoard(page: Page): Promise<void> {
  await page.goto("/view/kanban");
  await expect(page.getByTestId("kanban-view")).toBeVisible();
}

async function createProjectOnBoard(
  page: Page,
  title: string,
  options: { readonly doubleSubmit?: boolean; readonly description?: string } = {},
): Promise<void> {
  const firstProject = page.getByTestId("kanban-create-first-project");

  if (await firstProject.isVisible().catch(() => false)) {
    await firstProject.click();
  } else {
    await page.getByTestId("projects-create-button").click();
  }

  const form = page.getByTestId("project-form");

  await expect(form).toBeVisible();
  await form.getByLabel("Название проекта", { exact: true }).fill(title);

  if (options.description !== undefined) {
    await form.getByLabel("Описание (Markdown)", { exact: true }).fill(options.description);
  }

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
  await expect(page.getByTestId("kanban-board-title")).toHaveText(title);
  await expect(
    page.getByTestId("projects-sidebar-list").getByRole("button", { name: title, exact: true }),
  ).toHaveCount(1);
}

async function openProjectsMode(page: Page): Promise<void> {
  await page.goto("/view/projects");
  await expect(page.getByTestId("projects-overview")).toBeVisible();
}

/**
 * Вход в workspace из shell: единственный пункт «Проекты» ведёт в обзор с
 * `entry=1`, а обзор восстанавливает последнее представление.
 */
async function openProjectsFromNav(page: Page): Promise<void> {
  await page.goto("/");

  await page
    .getByTestId("desktop-sidebar")
    .getByRole("link", { name: "Проекты", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toMatch(/^\/view\/(projects|kanban|tasks)$/u);
}

/**
 * Догружает страницы сетки, пока карточка проекта не появится.
 *
 * Проекты упорядочены `createdAt asc`, поэтому только что созданный проект
 * может оказаться за границей первой страницы.
 */
async function revealProjectCard(page: Page, projectId: string): Promise<void> {
  const card = page.getByTestId(`projects-overview-card-${projectId}`);

  // До первой страницы обзора нет ни карточек, ни кнопки «Показать ещё».
  // Без ожидания цикл ниже мог сразу завершиться и не догрузить проект.
  await expect(page.getByTestId("projects-overview-grid")).toBeVisible();

  let guard = 0;

  while (
    !(await card.isVisible()) &&
    (await page.getByTestId("projects-overview-load-more").count()) > 0 &&
    guard < 30
  ) {
    const count = await page.locator('[data-testid^="projects-overview-card-"]').count();

    await page.getByTestId("projects-overview-load-more").click();
    await expect
      .poll(async () => page.locator('[data-testid^="projects-overview-card-"]').count())
      .toBeGreaterThan(count);
    guard += 1;
  }

  await expect(card).toBeVisible();
}

async function expectProjectCounts(
  page: Page,
  projectId: string,
  counts: Record<keyof typeof STATUS_LABELS, number>,
  overdue: number,
): Promise<void> {
  await expect(page.getByTestId(`projects-overview-card-${projectId}`)).toBeVisible();

  for (const status of Object.keys(STATUS_LABELS) as Array<keyof typeof STATUS_LABELS>) {
    await expect(page.getByTestId(`projects-overview-count-${projectId}-${status}`)).toHaveText(
      String(counts[status]),
    );
  }

  await expect(page.getByTestId(`projects-overview-total-${projectId}`)).toHaveText(
    String(Object.values(counts).reduce((sum, value) => sum + value, 0)),
  );
  await expect(page.getByTestId(`projects-overview-overdue-${projectId}`)).toHaveText(
    `Просрочено: ${String(overdue)}`,
  );
}

async function expectBoardSummary(
  page: Page,
  expected: {
    readonly total: number;
    readonly counts: Record<keyof typeof STATUS_LABELS, number>;
    readonly overdue: number;
  },
): Promise<void> {
  await expect(page.getByTestId("kanban-board-summary")).toBeVisible();
  await expect(page.getByTestId("kanban-summary-total")).toHaveText(String(expected.total));

  // Заголовок показывает фактические default-колонки нового проекта.
  for (const status of ["todo", "in_progress", "done"] as const) {
    await expect(page.getByTestId(`kanban-summary-${status}`)).toHaveText(
      String(expected.counts[status]),
    );
  }

  await expect(page.getByTestId("kanban-summary-overdue")).toHaveText(String(expected.overdue));
}

async function projectIdByOption(page: Page, title: string): Promise<string> {
  const item = page
    .getByTestId("projects-sidebar-list")
    .locator('[data-testid^="projects-sidebar-item-"]')
    .filter({ hasText: title });

  await expect(item).toHaveCount(1);

  const testId = await item.getAttribute("data-testid");
  const projectId = (testId ?? "").replace("projects-sidebar-item-", "");

  expect(projectId.length).toBeGreaterThan(0);

  return projectId;
}

interface BoardTaskSeed {
  readonly projectTitle?: string;
  readonly title: string;
  readonly status?: keyof typeof STATUS_LABELS;
  readonly parentTitle?: string;
  readonly tags?: string;
  readonly dueAt?: string;
  readonly priority?: string;
  /** Открыть общую кнопку «Новая задача», а не кнопку колонки. */
  readonly viaGeneral?: boolean;
  /** Проверить, что кнопка колонки предустановила статус. */
  readonly expectPrefilledStatus?: boolean;
}

async function createSubtaskOnBoard(page: Page, seed: BoardTaskSeed): Promise<string> {
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
      .getByRole("combobox", { name: "Колонка подзадачи", exact: true })
      .selectOption({ label: STATUS_LABELS[seed.status] });
  }

  await page.getByTestId("kanban-subtask-submit").click();

  const item = page.locator('[data-testid^="kanban-subtask-"]').filter({ hasText: seed.title });

  await expect(item).toHaveCount(1);

  const testId = await item.getAttribute("data-testid");
  const taskId = (testId ?? "").replace("kanban-subtask-", "");

  expect(taskId.length).toBeGreaterThan(0);

  if (seed.tags !== undefined || seed.dueAt !== undefined || seed.priority !== undefined) {
    await page.getByTestId(`kanban-subtask-${taskId}`).click();
    await editTaskInModal(page, {
      ...(seed.priority !== undefined ? { priority: seed.priority } : {}),
      ...(seed.dueAt !== undefined ? { dueAt: seed.dueAt } : {}),
      ...(seed.tags !== undefined ? { tags: seed.tags } : {}),
    });
  }

  if ((await page.getByTestId("kanban-details").count()) > 0) {
    await closeCardModal(page);
  }

  return taskId;
}

async function createTaskOnBoard(page: Page, seed: BoardTaskSeed): Promise<string> {
  if (seed.parentTitle !== undefined) {
    return createSubtaskOnBoard(page, seed);
  }

  const general = seed.viaGeneral === true || seed.status === undefined;
  const prefix = general ? "kanban-create" : `kanban-quick-add-${seed.status}`;
  const opener = general
    ? page.getByTestId("kanban-create-task")
    : page.getByTestId(`kanban-quick-add-${seed.status}`);

  await expect(opener).toBeEnabled();
  await opener.click();

  const form = page.getByTestId(`${prefix}-form`);

  await expect(form).toBeVisible();

  if (!general && seed.expectPrefilledStatus === true && seed.status !== undefined) {
    await expect(form).toHaveAttribute("aria-label", new RegExp(STATUS_LABELS[seed.status], "u"));
  }

  const input = page.getByTestId(`${prefix}-input`);

  await input.fill(seed.title);
  await page.keyboard.press("Enter");

  if (general) {
    await expect(form).toHaveCount(0);
  } else {
    // Колоночный composer остаётся открытым для следующей карточки.
    await expect(input).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
  }

  const taskId = await cardIdByTitle(page, seed.title);
  const needsMove = general && seed.status !== undefined && seed.status !== "todo";

  if (needsMove || seed.tags !== undefined || seed.dueAt !== undefined) {
    await page.getByTestId(`kanban-open-${taskId}`).click();
    await expect(page.getByTestId("kanban-details")).toBeVisible();
    await editTaskInModal(page, {
      ...(needsMove && seed.status !== undefined ? { status: seed.status } : {}),
      ...(seed.priority !== undefined ? { priority: seed.priority } : {}),
      ...(seed.dueAt !== undefined ? { dueAt: seed.dueAt } : {}),
      ...(seed.tags !== undefined ? { tags: seed.tags } : {}),
    });
    await closeCardModal(page);
  }

  return taskId;
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

    // Выполняется первым: база E2E-прогона ещё пуста, поэтому пустое
    // состояние можно проверить без искусственного удаления чужих данных.
    test("первый вход без сохранённого вида открывает пустой канбан и создаёт первый проект", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Первый проект канбана");

      await openProjectsFromNav(page);

      // Без localStorage вход по умолчанию ведёт в канбан, а не в обзор.
      await expect(page).toHaveURL(/\/view\/kanban(\?|$)/u);
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(page.getByTestId("kanban-empty-projects")).toBeVisible();
      await expect(page.getByTestId("projects-overview")).toHaveCount(0);

      await page.getByTestId("kanban-create-first-project").click();

      const form = page.getByTestId("project-form");

      await expect(form).toBeVisible();
      await form.getByLabel("Название проекта", { exact: true }).fill(projectTitle);
      await form.getByRole("button", { name: "Создать проект" }).click();
      await expect(form).toHaveCount(0);
      await expect(page).toHaveURL(/[?&]project=/u);

      // Создание проекта не изменилось: доска открывает новый проект сразу.
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
      await expect(page.getByTestId("kanban-summary-total")).toHaveText("0");
      await expect(page.getByTestId("kanban-empty-projects")).toHaveCount(0);
      await expect(
        page.getByTestId("projects-sidebar-list").getByRole("button", {
          name: projectTitle,
          exact: true,
        }),
      ).toHaveCount(1);

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
    });

    test("повторный вход из обзора снова открывает канбан без служебного entry", async ({
      page,
    }) => {
      await page.goto("/view/projects");
      await expect(page.getByTestId("projects-overview")).toBeVisible();

      const nav = page
        .getByTestId("desktop-sidebar")
        .getByRole("link", { name: "Проекты", exact: true });

      await nav.click();
      await expect(page).toHaveURL(/\/view\/kanban(\?|$)/u);
      await expect(page).not.toHaveURL(/[?&]entry=/u);

      await page.goto("/view/projects");
      await expect(page.getByTestId("projects-overview")).toBeVisible();

      await nav.click();
      await expect(page).toHaveURL(/\/view\/kanban(\?|$)/u);
      await expect(page).not.toHaveURL(/[?&]entry=/u);
      await expect(page.getByTestId("kanban-view")).toBeVisible();
    });

    test("список и канбан восстанавливаются после reload и повторного входа", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект сохранённого вида");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectId = new URL(page.url()).searchParams.get("project") ?? "";

      expect(projectId.length).toBeGreaterThan(0);

      // Явно выбираем список переключателем: последующий вход идёт в список.
      await page.getByTestId("project-view-list").click();
      await expect(page).toHaveURL(new RegExp(`/view/tasks\\?.*project=${projectId}`, "u"));
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.localStorage.getItem("kanbaner.projects.lastView")))
        .toBe("/view/tasks");

      await page.reload();
      await expect(page.getByTestId("task-list-view")).toBeVisible();

      await openProjectsFromNav(page);
      await expect(page).toHaveURL(new RegExp(`/view/tasks\\?.*project=${projectId}`, "u"));
      await expect(page.getByTestId("task-list-view")).toBeVisible();

      // Канбан сохраняется тем же переключателем и переживает reload и вход.
      await page.getByTestId("project-view-kanban").click();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
      await expect
        .poll(() => page.evaluate(() => window.localStorage.getItem("kanbaner.projects.lastView")))
        .toBe("/view/kanban");

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      await openProjectsFromNav(page);
      await expect(page).toHaveURL(new RegExp(`/view/kanban\\?.*project=${projectId}`, "u"));
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
    });

    test("неизвестное представление и ошибка чтения localStorage открывают канбан", async ({
      page,
    }) => {
      await page.goto("/view/projects");
      await expect(page.getByTestId("projects-overview")).toBeVisible();

      await page.evaluate(() => {
        window.localStorage.setItem("kanbaner.projects.lastView", '{"broken":true}');
      });

      await page.goto("/view/projects?entry=1");
      await expect(page).toHaveURL(/\/view\/kanban(\?|$)/u);
      await expect(page.getByTestId("kanban-view")).toBeVisible();

      // Запрет чтения ключа вида не должен ронять вход: fallback — канбан.
      await page.addInitScript(() => {
        const original = Storage.prototype.getItem;

        Storage.prototype.getItem = function (key: string): string | null {
          if (key === "kanbaner.projects.lastView") {
            throw new DOMException("Доступ запрещён", "SecurityError");
          }

          return original.call(this, key);
        };
      });

      await page.goto("/view/projects?entry=1");
      await expect(page).toHaveURL(/\/view\/kanban(\?|$)/u);
      await expect(page.getByTestId("kanban-view")).toBeVisible();
    });

    test("смена проекта сохраняет выбранное представление", async ({ page }) => {
      const firstTitle = uniqueTitle("Проект вида первый");
      const secondTitle = uniqueTitle("Проект вида второй");

      await openTaskList(page);
      await createProject(page, firstTitle);

      const firstId = new URL(page.url()).searchParams.get("project") ?? "";

      await createProject(page, secondTitle);

      const secondId = new URL(page.url()).searchParams.get("project") ?? "";

      expect(firstId.length).toBeGreaterThan(0);
      expect(secondId.length).toBeGreaterThan(0);
      expect(secondId).not.toBe(firstId);

      const sidebar = page.getByTestId("projects-sidebar-list");

      await page.getByTestId("project-view-list").click();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastView")))
        .toBe("/view/tasks");

      await sidebar.getByRole("button", { name: firstTitle, exact: true }).click();
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/view/tasks\\?.*project=${firstId}`, "u"));
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastView")))
        .toBe("/view/tasks");

      await page.getByTestId("project-view-kanban").click();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(firstTitle);
      await expect(page).toHaveURL(new RegExp(`/view/kanban\\?.*project=${firstId}`, "u"));
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastView")))
        .toBe("/view/kanban");

      await sidebar.getByRole("button", { name: secondTitle, exact: true }).click();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(secondTitle);
      // Ждём именно второй проект в URL: заголовок обновляется из состояния
      // раньше, чем router.replace фиксирует query string.
      await expect(page).toHaveURL(new RegExp(`/view/kanban\\?.*project=${secondId}`, "u"));
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastView")))
        .toBe("/view/kanban");
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastProjectId")))
        .toBe(secondId);

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(secondTitle);
    });

    test("настраивает проект из канбана с валидацией, dirty-confirm и сохранением query", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект настроек канбана");
      const renamedTitle = uniqueTitle("Канбан переименован");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectId = new URL(page.url()).searchParams.get("project") ?? "";

      expect(projectId.length).toBeGreaterThan(0);

      await page.goto(`/view/kanban?project=${projectId}&tag=release`);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      const opener = page.getByTestId("project-settings-button");
      const dialog = page.getByTestId("project-settings-dialog");
      const input = page.getByTestId("project-settings-title-input");

      // Кнопка доступна с клавиатуры и открывает modal-диалог.
      await opener.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue(projectTitle);

      const selection = await input.evaluate((element) => {
        const field = element as HTMLInputElement;

        return { start: field.selectionStart, end: field.selectionEnd };
      });

      expect(selection.start).toBe(0);
      expect(selection.end).toBe(projectTitle.length);

      // Список фактических колонок доступен, но создание/удаление/тип — нет.
      await expect(page.getByTestId("project-settings-columns")).toBeVisible();
      await expect(page.getByTestId("kanban-column-form")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Удалить колонку" })).toHaveCount(0);
      await expect(page.getByRole("combobox")).toHaveCount(0);

      // Пустое название не отправляется и не теряет введённое значение.
      await input.fill("   ");
      await page.getByTestId("project-settings-title-save").click();
      await expect(page.getByTestId("project-settings-title-validation")).toContainText(
        "Укажите название проекта",
      );
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue("   ");

      // Escape с несохранённым вводом требует подтверждения.
      await input.fill(renamedTitle);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("project-settings-dirty-confirm")).toBeVisible();
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue(renamedTitle);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      // Escape внутри подтверждения остаётся в настройках.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("project-settings-dirty-confirm")).toHaveCount(0);
      await expect(dialog).toBeVisible();

      // Отказ от сохранения закрывает только настройки и возвращает фокус.
      await page.getByTestId("project-settings-done").click();
      await page.getByTestId("project-settings-dirty-discard").click();
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      await opener.click();
      await expect(dialog).toBeVisible();
      await input.fill(renamedTitle);
      await page.getByTestId("project-settings-title-save").click();

      await expect(page.getByTestId("project-settings-title-notice")).toContainText(
        "Название проекта сохранено",
      );
      await expect(input).toHaveValue(renamedTitle);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(renamedTitle);
      await expect(
        page.getByTestId("projects-sidebar-list").getByRole("button", {
          name: renamedTitle,
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(
        page.getByTestId("projects-sidebar-list").getByRole("button", {
          name: projectTitle,
          exact: true,
        }),
      ).toHaveCount(0);
      // ID проекта, маршрут и фильтр не меняются.
      await expect(page).toHaveURL(
        new RegExp(`/view/kanban\\?[^#]*project=${projectId}[^#]*tag=release`, "u"),
      );

      await page.getByTestId("project-settings-done").click();
      await expect(dialog).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(renamedTitle);
      await expect(
        page.getByTestId("kanban-filters").getByRole("searchbox", { name: "Тег" }),
      ).toHaveValue("release");

      // Обзор после reload показывает новое название из хранилища.
      await page.goto(`/view/projects?project=${projectId}`);
      await expect(page.getByTestId("projects-overview")).toBeVisible();
      await revealProjectCard(page, projectId);
      await expect(page.getByTestId(`projects-overview-card-${projectId}`)).toContainText(
        renamedTitle,
      );
    });

    test("Escape в настройках не закрывает inline-создание с черновиком", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект настроек с черновиком");
      const draftTitle = uniqueTitle("Черновик задачи при настройках");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectId = new URL(page.url()).searchParams.get("project") ?? "";

      expect(projectId.length).toBeGreaterThan(0);

      await openKanban(page, projectTitle);
      await page.getByTestId("kanban-create-task").click();

      const createPanel = page.getByTestId("kanban-create-panel");
      const draftInput = page.getByTestId("kanban-create-input");

      await expect(createPanel).toBeVisible();
      await draftInput.fill(draftTitle);

      const before = new URL(page.url());

      await page.getByTestId("project-settings-button").click();

      const settingsDialog = page.getByTestId("project-settings-dialog");

      await expect(settingsDialog).toBeVisible();
      await page.keyboard.press("Escape");

      // Закрылись только настройки; inline create и черновик не тронуты.
      await expect(settingsDialog).toHaveCount(0);
      await expect(createPanel).toBeVisible();
      await expect(draftInput).toHaveValue(draftTitle);
      expect(new URL(page.url()).search).toBe(before.search);
      await expect(page.getByTestId("project-settings-button")).toBeFocused();

      // Повторный Escape уже закрывает inline create как раньше.
      await page.keyboard.press("Escape");
      await expect(createPanel).toHaveCount(0);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
    });

    test("не перезаписывает настройки проекта из второй вкладки и сохраняет ввод", async ({
      page,
      context,
    }) => {
      const projectTitle = uniqueTitle("Проект конфликта настроек");
      const firstTitle = uniqueTitle("Переименование вкладки A");
      const staleTitle = uniqueTitle("Переименование вкладки B");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectUrl = page.url();
      const projectId = new URL(projectUrl).searchParams.get("project") ?? "";

      expect(projectId.length).toBeGreaterThan(0);

      await page.goto(`/view/kanban?project=${projectId}`);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      const stalePage = await context.newPage();

      await stalePage.goto(`/view/kanban?project=${projectId}`);
      await expect(stalePage.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      // Вкладка B открывает настройки и держит версию до правки вкладки A.
      await stalePage.getByTestId("project-settings-button").click();

      const staleDialog = stalePage.getByTestId("project-settings-dialog");
      const staleInput = stalePage.getByTestId("project-settings-title-input");

      await expect(staleDialog).toBeVisible();
      await expect(staleInput).toHaveValue(projectTitle);
      await staleInput.fill(staleTitle);

      // Вкладка A сохраняет первую версию.
      await renameProject(page, firstTitle);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(firstTitle);

      // Вкладка B отправляет устаревшую версию и получает конфликт.
      await stalePage.getByTestId("project-settings-title-save").click();

      await expect(stalePage.getByTestId("project-settings-title-error")).toContainText(
        "Проект уже изменён в другом месте",
      );
      await expect(staleDialog).toBeVisible();
      await expect(staleInput).toHaveValue(staleTitle);
      // Данные перечитаны: за заголовком уже правка вкладки A.
      await expect(stalePage.getByTestId("kanban-board-title")).toHaveText(firstTitle);

      // Повторная попытка использует актуальную версию и сохраняет ввод.
      await stalePage.getByTestId("project-settings-title-save").click();
      await expect(stalePage.getByTestId("project-settings-title-notice")).toContainText(
        "Название проекта сохранено",
      );
      await expect(stalePage.getByTestId("kanban-board-title")).toHaveText(staleTitle);
      await stalePage.getByTestId("project-settings-done").click();
      await expect(staleDialog).toHaveCount(0);

      await stalePage.reload();
      await expect(stalePage.getByTestId("kanban-board-title")).toHaveText(staleTitle);
      await stalePage.close();
    });

    test("невалидный project из entry не затирает сохранённый проект", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект fallback входа");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectId = new URL(page.url()).searchParams.get("project") ?? "";

      expect(projectId.length).toBeGreaterThan(0);

      await openKanban(page, projectTitle);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastProjectId")))
        .toBe(projectId);

      await page.goto("/view/projects?entry=1&project=ghost");

      await expect(page).toHaveURL(new RegExp(`/view/kanban\\?project=${projectId}`, "u"));
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("kanbaner.projects.lastProjectId")))
        .toBe(projectId);

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
    });

    test("вставка над первой карточкой ставит задачу первой и сохраняется после reload", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект верхней вставки");
      const firstTitle = uniqueTitle("Верхняя первая");
      const secondTitle = uniqueTitle("Верхняя вторая");
      const moverTitle = uniqueTitle("Верхняя перемещаемая");

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
      const moverId = await createTask(page, {
        projectTitle,
        title: moverTitle,
        status: "in_progress",
      });

      await openKanban(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId]);

      // Целимся в composer под заголовком: раньше эта зона означала append.
      await dragCard(page, moverId, "todo", "top");
      await waitForCardSettled(page, moverId);

      await expect.poll(() => cardTitles(page, "todo")).toEqual([moverId, firstId, secondId]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([moverId, firstId, secondId]);

      await expectCardInColumn(page, moverId, "todo");
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("3");
    });

    test("вставляет между карточками и добавляет в конец с сохранением порядка", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект между карточками");
      const firstTitle = uniqueTitle("Между первая");
      const secondTitle = uniqueTitle("Между вторая");
      const moverTitle = uniqueTitle("Между перемещаемая");

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
      const moverId = await createTask(page, {
        projectTitle,
        title: moverTitle,
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId, moverId]);

      // Нижняя половина первой карточки — это реально между первой и второй.
      await dragCardAfter(page, moverId, firstId);
      await waitForCardSettled(page, moverId);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, moverId, secondId]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, moverId, secondId]);

      // Нижняя половина последней карточки — append, порядок снова исходный.
      await dragCardAfter(page, moverId, secondId);
      await waitForCardSettled(page, moverId);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId, moverId]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId, moverId]);
    });

    test("первая карточка на composer остаётся первой, а при прокрутке drop в composer идёт в начало", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект no-op composer");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const firstId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("No-op первая"),
        status: "todo",
      });
      const secondId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("No-op вторая"),
        status: "todo",
      });
      const thirdId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("No-op третья"),
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId, thirdId]);

      // Первая карточка на верхнюю drop-зону — no-op, не append.
      await dragCard(page, firstId, "todo", "top");
      await waitForCardSettled(page, firstId);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId, thirdId]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect.poll(() => cardTitles(page, "todo")).toEqual([firstId, secondId, thirdId]);

      // Длинная колонка и прокрутка: drop в composer всё равно вставляет
      // задачу перед первой, хотя её top уже отрицательный.
      const trigger = page.getByTestId("kanban-quick-add-todo");
      const input = page.getByTestId("kanban-quick-add-todo-input");
      const scroll = page.getByTestId("kanban-column-scroll-todo");

      await trigger.click();

      for (let index = 1; index <= 12; index += 1) {
        await input.fill(`Composer no-op ${String(index).padStart(2, "0")} ${projectTitle}`);
        await input.press("Enter");
      }

      await expect(page.getByTestId("kanban-count-todo")).toHaveText("15");

      // Последний submit мог ещё держать input disabled: Escape в этот момент
      // теряется и composer остаётся открытым. Сначала ждём возврат фокуса.
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toHaveCount(0);

      const loadAllTodo = async (expectedTotal: number): Promise<void> => {
        const loadMore = page.getByTestId("kanban-load-more-todo");

        // После reload доска сначала рендерит только первую страницу.
        // Проверка count() без ожидания данных видит 0 кнопок и завершает
        // цикл раньше времени, оставляя 10 карточек из 15.
        await expect
          .poll(async () => {
            const rendered = (await cardTitles(page, "todo")).length;

            return rendered >= expectedTotal || (await loadMore.count()) > 0;
          })
          .toBe(true);

        let guard = 0;

        while ((await loadMore.count()) > 0 && guard < 10) {
          const before = (await cardTitles(page, "todo")).length;

          await loadMore.click();
          await expect
            .poll(async () => (await cardTitles(page, "todo")).length)
            .toBeGreaterThan(before);
          guard += 1;
        }

        // Регрессия: догрузка обязана довести колонку до полного состава.
        await expect.poll(async () => (await cardTitles(page, "todo")).length).toBe(expectedTotal);
      };

      await loadAllTodo(15);
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      const ids = await cardTitles(page, "todo");
      const lastId = ids.at(-1) ?? "";

      expect(lastId.length).toBeGreaterThan(0);
      expect(ids).toHaveLength(15);

      await dragCard(page, lastId, "todo", "top");
      await waitForCardSettled(page, lastId);
      await expect
        .poll(() => cardTitles(page, "todo"))
        .toEqual([lastId, firstId, secondId, thirdId, ...ids.slice(3, -1)]);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await loadAllTodo(15);
      await expect
        .poll(() => cardTitles(page, "todo"))
        .toEqual([lastId, firstId, secondId, thirdId, ...ids.slice(3, -1)]);
    });

    test("кнопка добавления под заголовком видна при длинном списке и создаёт карточку", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект composer сверху");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const column = page.getByTestId("kanban-column-todo");
      const header = column.locator("header").first();
      const trigger = page.getByTestId("kanban-quick-add-todo");
      const scroll = page.getByTestId("kanban-column-scroll-todo");

      // Composer — единственная копия, сразу за header и вне прокрутки карточек.
      await expect(
        column.locator('header + [data-testid="kanban-quick-composer-todo"]'),
      ).toHaveCount(1);
      await expect(scroll.getByTestId("kanban-quick-add-todo")).toHaveCount(0);
      await expect(trigger).toHaveCount(1);

      const headerBox = await header.boundingBox();
      const triggerBox = await trigger.boundingBox();
      const scrollBox = await scroll.boundingBox();

      expect(headerBox).not.toBeNull();
      expect(triggerBox).not.toBeNull();
      expect(scrollBox).not.toBeNull();
      expect(triggerBox?.y ?? 0).toBeGreaterThanOrEqual(
        (headerBox?.y ?? 0) + (headerBox?.height ?? 0) - 1,
      );
      expect(scrollBox?.y ?? 0).toBeGreaterThan(triggerBox?.y ?? 0);

      await trigger.click();

      const input = page.getByTestId("kanban-quick-add-todo-input");

      await expect(input).toBeFocused();

      for (let index = 1; index <= 24; index += 1) {
        await input.fill(`Composer ${String(index).padStart(2, "0")} ${projectTitle}`);
        await input.press("Enter");
      }

      await expect(page.getByTestId("kanban-count-todo")).toHaveText("24");
      // Escape после последнего submit теряется, пока input disabled.
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toHaveCount(0);
      await expect(trigger).toBeVisible();

      // Длинный список получает собственный scroll: composer остаётся над ним
      // и не двигается при прокрутке карточек.
      const metrics = await scroll.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));

      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

      const afterListBox = await trigger.boundingBox();
      const scrollAfterListBox = await scroll.boundingBox();

      expect(afterListBox).not.toBeNull();
      expect(afterListBox?.y).toBeCloseTo(triggerBox?.y ?? 0, 0);
      expect(scrollAfterListBox?.y ?? 0).toBeGreaterThan(afterListBox?.y ?? 0);

      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(trigger).toBeVisible();

      const afterScrollBox = await trigger.boundingBox();

      expect(afterScrollBox?.y).toBeCloseTo(triggerBox?.y ?? 0, 0);
      await expect(scroll.getByTestId("kanban-quick-add-todo")).toHaveCount(0);
      await expect(
        column.locator("[data-card-id]").filter({ hasText: `Composer 24 ${projectTitle}` }),
      ).toHaveCount(1);

      // Inline-панель создания меняет верхнюю геометрию: высота колонок должна
      // пересчитаться и при открытии, и после закрытия.
      const columns = page.getByTestId("kanban-columns");
      const panel = page.getByTestId("kanban-create-panel");
      const heightBeforePanel = (await columns.boundingBox())?.height ?? 0;

      await page.getByTestId("kanban-create-task").click();
      await expect(panel).toBeVisible();
      await expect(trigger).toBeVisible();
      await expect
        .poll(async () => (await columns.boundingBox())?.height ?? 0)
        .toBeLessThan(heightBeforePanel);

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect
        .poll(async () => (await columns.boundingBox())?.height ?? 0)
        .toBeCloseTo(heightBeforePanel);
    });

    test("показывает проект и задачи в трёх default-колонках", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект доски");
      const todoTitle = uniqueTitle("Туду задача");
      const progressTitle = uniqueTitle("В работе задача");
      const doneTitle = uniqueTitle("Готовая задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
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

      await expect(page.getByTestId("kanban-column-title-todo")).toHaveText("ToDo");
      await expect(page.getByTestId("kanban-column-title-in_progress")).toHaveText("In Progress");
      await expect(page.getByTestId("kanban-column-title-done")).toHaveText("Done");
      await expect(page.getByTestId("kanban-column-backlog")).toHaveCount(0);

      await expect(column(page, "todo").getByTestId(`kanban-card-${todoId}`)).toBeVisible();
      await expect(
        column(page, "in_progress").getByTestId(`kanban-card-${progressId}`),
      ).toBeVisible();
      await expect(column(page, "done").getByTestId(`kanban-card-${doneId}`)).toBeVisible();
      await expect(column(page, "todo").locator('[data-testid^="kanban-card-"]')).toHaveCount(2);
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("2");
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("1");
      await expect(page.getByTestId("kanban-count-done")).toHaveText("1");

      const todoCard = card(page, todoId);

      await expect(todoCard).toContainText(todoTitle);
      await expect(todoCard).toContainText("Высокий");
      await expect(todoCard).toContainText("10.01.2030");
      await expect(todoCard).toContainText("release");
      await expect(page.getByTestId(`kanban-subtasks-${todoId}`)).toHaveText("Подзадачи: 1");
      await expect(page.getByTestId(`kanban-subtasks-${progressId}`)).toHaveText("Подзадачи: 0");

      // Колонки и задачи переживают полную перезагрузку страницы.
      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("2");
      await expect(page.getByTestId(`kanban-card-${todoId}`)).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test("добавляет, переименовывает и переставляет колонки с сохранением после reload", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект CRUD колонок");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const openId = await addColumn(page, "Проверка", "open");
      const doneId = await addColumn(page, "Done 2", "done");
      const openSlug = `column-${openId}`;

      // Переименование через меню заголовка.
      await openColumnMenu(page, openId);
      await page.getByTestId(`kanban-column-rename-${openSlug}`).click();
      await page.getByTestId(`kanban-column-rename-input-${openSlug}`).fill("Проверка 2");
      await page.getByTestId(`kanban-column-rename-submit-${openSlug}`).click();
      await expect(page.getByRole("heading", { name: "Проверка 2", exact: true })).toBeVisible();

      // Перемещение влево: пользовательская колонка встаёт перед Done.
      await openColumnMenu(page, openId);
      await page.getByTestId(`kanban-column-move-left-${openSlug}`).click();
      await expect
        .poll(async () => {
          const ids = await columnIdList(page);

          return ids.indexOf(openId);
        })
        .toBe(2);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      const order = await columnIdList(page);

      expect(order.indexOf(openId)).toBe(2);
      expect(order.indexOf(doneId)).toBe(4);
      await expect(page.getByRole("heading", { name: "Проверка 2", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Done 2", exact: true })).toBeVisible();
    });

    test("переставляет колонки pointer DnD до/после/no-op и card drop header не меняет порядок", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект DnD колонок");
      const taskTitle = uniqueTitle("Карточка DnD колонок");

      await openTaskList(page);
      await createProject(page, projectTitle);

      await createTask(page, { projectTitle, title: taskTitle, status: "todo" });
      await openKanban(page, projectTitle);

      const columnA = await addColumn(page, "DnD A", "open");
      const columnB = await addColumn(page, "DnD B", "open");
      const baseline = await columnIdList(page);

      // Перед A: B встаёт между Done и A.
      await dragColumn(page, columnB, columnA, "left");
      await expect
        .poll(async () => {
          const ids = await columnIdList(page);

          return ids.indexOf(columnB) === ids.indexOf(columnA) - 1;
        })
        .toBe(true);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect
        .poll(async () => {
          const ids = await columnIdList(page);

          return ids.indexOf(columnB) === ids.indexOf(columnA) - 1;
        })
        .toBe(true);

      // После A: исходный порядок.
      await dragColumn(page, columnB, columnA, "right");
      await expect.poll(() => columnIdList(page)).toEqual(baseline);

      // No-op: drag на себя не меняет порядок и не отправляет команду.
      await dragColumn(page, columnB, columnB, "center");
      await expect.poll(() => columnIdList(page)).toEqual(baseline);

      // Drop карточки на header целевой колонки не переставляет колонки.
      const taskId = await cardIdByTitle(page, taskTitle);

      await page.getByTestId("kanban-columns").evaluate((element) => {
        element.scrollLeft = 0;
      });
      await page.waitForTimeout(100);

      await dragCard(page, taskId, "in_progress", "top");
      await waitForCardSettled(page, taskId);
      await expectCardInColumn(page, taskId, "in_progress");
      await expect.poll(() => columnIdList(page)).toEqual(baseline);
    });

    test("удаляет колонку с переносом задач в выбранный target", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект удаления колонки");
      const movedTitle = uniqueTitle("Перенесённая задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const tempId = await addColumn(page, "Временная", "open");

      await addCardToColumn(page, tempId, movedTitle);
      await expect(page.getByTestId("kanban-count-column-" + tempId)).toHaveText("1");

      await openColumnMenu(page, tempId);
      await page.getByTestId(`kanban-column-delete-${"column-" + tempId}`).click();

      const dialog = page.getByTestId("kanban-column-delete-dialog");

      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("kanban-column-delete-moved-count")).toHaveText("1");
      await page.getByTestId("kanban-column-delete-target").selectOption({ label: "ToDo" });
      await page.getByTestId("kanban-column-delete-confirm").click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(`[data-kanban-column-id="${tempId}"]`)).toHaveCount(0);

      await expect(column(page, "todo").getByText(movedTitle)).toBeVisible();
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("1");

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.locator(`[data-kanban-column-id="${tempId}"]`)).toHaveCount(0);
      await expect(column(page, "todo").getByText(movedTitle)).toBeVisible();
    });

    test("поддерживает несколько Done-колонок и проставляет completedAt", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект двух Done");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const taskId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Задача в Done 2"),
        status: "todo",
      });

      await openKanban(page, projectTitle);

      const doneId = await addColumn(page, "Done 2", "done");

      const menu = await openCardActions(page, taskId);

      await menu.getByRole("menuitem", { name: "Переместить в Done 2", exact: true }).click();
      await waitForCardSettled(page, taskId);
      await expect(
        page.locator(`[data-kanban-column-id="${doneId}"]`).getByTestId(`kanban-card-${taskId}`),
      ).toBeVisible();

      await page.getByTestId(`kanban-open-${taskId}`).click();

      const details = page.getByTestId("kanban-details");

      await expect(details).toBeVisible();
      await expect(page.getByTestId("kanban-modal-completed")).toBeVisible();
      await expect(page.getByTestId("kanban-modal-status")).toHaveText("Done 2");
    });

    test("legacy Backlog материализуется публичным legacy status и виден на доске", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект legacy Backlog");
      const taskTitle = uniqueTitle("Legacy задача");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectId = new URL(page.url()).searchParams.get("project");

      expect(projectId).not.toBeNull();

      await page.goto(`/view/tasks?project=${String(projectId)}&status=backlog`);
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page.getByTestId("task-list-legacy-status")).toBeVisible();

      await page.getByTestId("create-task-button").click();
      await page.getByTestId("task-list-create-input").fill(taskTitle);
      await page.getByTestId("task-list-create-submit").click();
      await expect(page.getByTestId("task-list-create-panel")).toHaveCount(0);
      await closeDetails(page);

      await openKanban(page, projectTitle);

      await expect(page.getByTestId("kanban-column-title-backlog")).toHaveText("Backlog");
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("1");
      await expect(column(page, "backlog").getByText(taskTitle)).toBeVisible();

      const order = await columnIdList(page);

      expect(order).toHaveLength(4);
      expect(order[0]).toBe(`column-${String(projectId)}-legacy-backlog`);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-count-backlog")).toHaveText("1");
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
      await expect(page.getByTestId(`task-row-${draggedId}`)).toContainText("In Progress");

      // Команда из списка видна на доске.
      await page
        .getByTestId(`task-row-${draggedId}`)
        .getByRole("button", { name: `Открыть задачу ${draggedTitle}` })
        .click();

      const details = page.getByTestId("task-details-desktop");

      await expect(details).toContainText(draggedTitle);
      await details
        .getByRole("combobox", { name: "Переместить в", exact: true })
        .selectOption({ label: "Done" });
      await details.getByRole("button", { name: "Переместить", exact: true }).click();
      await expect(details).toContainText("Done");

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
      await expect(stalePage.getByTestId(`task-row-${taskId}`)).toContainText("Done");

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
      // Проект остаётся в URL: доска всегда привязана к проекту.
      await expect(page).toHaveURL(/[?&]project=/u);
      await expect(page).not.toHaveURL(/[?&]tag=/u);
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
            status: "in_progress",
          }),
        );
      }

      // Статус задаётся через «Переместить в», который вставляет карточку в
      // начало целевой колонки: DOM-порядок обратен порядку создания.
      const domOrder = [...ids].reverse();

      await openKanban(page, projectTitle);
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText(String(total));
      await expect(
        column(page, "in_progress").locator('[data-testid^="kanban-card-"]'),
      ).toHaveCount(10);
      await expect(page.getByTestId("kanban-load-more-in_progress")).toBeVisible();

      await page.getByTestId("kanban-load-more-in_progress").click();
      await expect(
        column(page, "in_progress").locator('[data-testid^="kanban-card-"]'),
      ).toHaveCount(total);
      await expect(page.getByTestId("kanban-load-more-in_progress")).toHaveCount(0);
      await expect.poll(async () => cardTitles(page, "in_progress")).toEqual(domOrder);

      // Повторный reload начинает колонку с первой страницы и не дублирует
      // уже загруженные карточки.
      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(
        column(page, "in_progress").locator('[data-testid^="kanban-card-"]'),
      ).toHaveCount(10);
      await page.getByTestId("kanban-load-more-in_progress").click();
      await expect.poll(async () => cardTitles(page, "in_progress")).toEqual(domOrder);
      expect(new Set(await cardTitles(page, "in_progress")).size).toBe(total);

      // «В конец» после догрузки считается по полному scope и не теряет
      // карточку за границей первой страницы.
      const firstCard = domOrder[0] as string;
      const rotated = [...domOrder.slice(1), firstCard];

      await reorderWithMenu(page, firstCard, "В конец");
      await expect.poll(async () => cardTitles(page, "in_progress")).toEqual(rotated);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await page.getByTestId("kanban-load-more-in_progress").click();
      await expect.poll(async () => cardTitles(page, "in_progress")).toEqual(rotated);
      expect(new Set(await cardTitles(page, "in_progress")).size).toBe(total);
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

    test("переключатель внутри модала и настоящая ссылка закрывают overlay", async ({ page }) => {
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

      // Переключатель внутри модала доступен, хотя фон нативного modal inert.
      // Обычный click (без evaluate) сохраняет выбранную задачу.
      await page.getByTestId("project-view-modal-list").click();

      await expect(page).toHaveURL(/\/view\/tasks\?[^#]*[?&]task=/u);
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page.getByTestId("task-details-desktop")).toBeVisible();
      await expect(page.getByTestId("task-details-desktop")).toContainText(taskTitle);

      // Обратный переход тоже сохраняет задачу и снова открывает overlay.
      await page.getByTestId("project-view-kanban").click();

      await expect(page).toHaveURL(/\/view\/kanban\?[^#]*[?&]task=/u);
      await expect(page.getByTestId("kanban-details")).toBeVisible();

      // Клавиатурный путь внутри модала: focus + Enter на настоящей ссылке.
      const modalList = page.getByTestId("project-view-modal-list");

      await modalList.focus();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(/\/view\/tasks\?[^#]*[?&]task=/u);
      await expect(page.getByTestId("task-details-desktop")).toContainText(taskTitle);

      // Уход на другой маршрут тоже скрывает уже открытый overlay.
      const settingsLink = page.getByTestId("desktop-sidebar").getByTestId("settings-link-desktop");

      await settingsLink.click();

      await expect(page).toHaveURL(/\/settings$/u);
      await expect(page.getByRole("heading", { name: "Настройки", level: 1 })).toBeVisible();
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
      // После создания первого проекта пустое состояние больше не показывается.
      await expect(page.getByTestId("kanban-create-first-project")).toHaveCount(0);
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
        status: "todo",
        tags: "release",
        expectPrefilledStatus: true,
      });

      await expectCardInColumn(page, parentId, "todo");

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

    test("создаёт задачи кнопками всех default-колонок", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект колонок создания");
      const created: Array<{
        readonly status: keyof typeof STATUS_LABELS;
        readonly title: string;
      }> = [];

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle);
      await filterByProject(page, projectTitle);

      for (const status of ["todo", "in_progress", "done"] as const) {
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
          status: "in_progress",
        });
      }

      await openKanban(page, projectTitle);
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("10");
      await expect(column(page, "in_progress").locator("[data-card-id]")).toHaveCount(10);

      await page.getByTestId("kanban-quick-add-in_progress").click();

      const form = page.getByTestId("kanban-quick-add-in_progress-form");
      const input = page.getByTestId("kanban-quick-add-in_progress-input");

      await expect(form).toHaveAttribute("aria-label", /In Progress/u);
      await input.fill(createdTitle);

      const submit = page.getByTestId("kanban-quick-add-in_progress-submit");

      // Два клика до завершения команды: UI обязан отправить только один.
      await submit.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });

      await expect(input).toHaveValue("");
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("11");

      await page.keyboard.press("Escape");
      await expect(form).toHaveCount(0);

      const createdCard = column(page, "in_progress").locator("[data-card-id]").filter({
        hasText: createdTitle,
      });

      await expect(createdCard).toHaveCount(1);
      const id = await createdCard.getAttribute("data-card-id");

      expect(id).not.toBeNull();
      await expectCardInColumn(page, id as string, "in_progress");

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("11");
      await expect(page.getByTestId("kanban-load-more-in_progress")).toBeVisible();
      await page.getByTestId("kanban-load-more-in_progress").click();
      await expectCardInColumn(page, id as string, "in_progress");
      await expect(column(page, "in_progress").locator("[data-card-id]")).toHaveCount(11);

      await expectTaskInList(page, projectTitle, id as string, createdTitle, "in_progress");
    });

    test("быстрый composer создаёт несколько задач подряд и закрывается по Escape", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект быстрого composer");
      const firstTitle = uniqueTitle("Быстрая первая");
      const secondTitle = uniqueTitle("Быстрая вторая");
      const thirdTitle = uniqueTitle("Быстрая третья");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const trigger = page.getByTestId("kanban-quick-add-todo");
      const input = page.getByTestId("kanban-quick-add-todo-input");
      const form = page.getByTestId("kanban-quick-add-todo-form");

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

      // Третья карточка тем же путём: создание остаётся последовательным.
      await page.keyboard.type(thirdTitle);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("kanban-count-todo")).toHaveText("3");
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: thirdTitle }),
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

      for (const title of [firstTitle, secondTitle, thirdTitle]) {
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

      const input = page.getByTestId("kanban-quick-add-todo-input");
      const error = page.getByTestId("kanban-quick-add-todo-error");

      await input.fill(tooLongTitle);
      await input.press("Enter");
      await expect(error).toContainText("валидацию");
      await expect(input).toHaveValue(tooLongTitle);
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toBeVisible();

      await input.fill(recoveredTitle);

      const submit = page.getByTestId("kanban-quick-add-todo-submit");

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
      await page.getByTestId("kanban-quick-add-in_progress").click();

      const input = page.getByTestId("kanban-quick-add-in_progress-input");

      for (let index = 0; index < 10; index += 1) {
        await input.fill(`Быстрая ${String(index + 1).padStart(2, "0")} ${projectTitle}`);
        await input.press("Enter");
        await expect(input).toHaveValue("");
      }

      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("10");
      await input.fill(boundaryTitle);
      await input.press("Enter");
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("11");
      await expect(
        column(page, "in_progress").locator("[data-card-id]").filter({ hasText: boundaryTitle }),
      ).toHaveCount(1);

      const id = await cardIdByTitle(page, boundaryTitle);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(page.getByTestId("kanban-load-more-in_progress")).toBeVisible();
      await page.getByTestId("kanban-load-more-in_progress").click();
      await expectCardInColumn(page, id, "in_progress");
      await expect(column(page, "in_progress").locator("[data-card-id]")).toHaveCount(11);

      await expectTaskInList(page, projectTitle, id, boundaryTitle, "in_progress");
    });

    test("без выбранного проекта доска предлагает выбрать проект и не создаёт карточку", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект выбора в composer");
      const title = uniqueTitle("После выбора проекта");

      await openTaskList(page);
      await createProject(page, projectTitle);

      // Сбрасываем запомненный проект: при нескольких проектах рабочее
      // пространство не выбирает проект молча.
      await page.goto("/view/kanban");
      await page.evaluate(() => {
        window.localStorage.clear();
      });
      await page.goto("/view/kanban");

      await expect(page.getByTestId("kanban-project-picker")).toBeVisible();
      await expect(page.getByTestId("kanban-quick-add-todo")).toHaveCount(0);
      await expect(page.getByTestId("kanban-columns")).toHaveCount(0);

      // Проект выбирается в боковой панели, после чего доска доступна.
      await page
        .getByTestId("projects-sidebar-list")
        .getByRole("button", { name: projectTitle, exact: true })
        .click();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
      await expect(page.getByTestId("kanban-columns")).toBeVisible();

      const id = await createTaskOnBoard(page, {
        projectTitle,
        title,
        status: "todo",
        expectPrefilledStatus: true,
      });

      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: title }),
      ).toHaveCount(1);
      // Бейджа проекта на карточке нет: доска показывает один проект.
      await expect(page.locator('[data-testid^="kanban-project-badge-"]')).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expect(page.getByTestId(`kanban-card-${id}`)).toBeVisible();

      await expectTaskInList(page, projectTitle, id, title, "todo");
    });

    test("быстрый composer создаёт только название, полная форма доступна при редактировании", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект quick draft");
      const draftTitle = uniqueTitle("Быстрый черновик формы");
      const description = "Описание из полной формы";

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const quickForm = page.getByTestId("kanban-quick-add-todo-form");
      const quickInput = page.getByTestId("kanban-quick-add-todo-input");

      await page.getByTestId("kanban-quick-add-todo").click();
      await expect(quickInput).toBeFocused();
      await page.keyboard.type(draftTitle);

      // Короткий composer не содержит отдельного пути в полную форму:
      // создание карточки требует только название.
      await expect(page.getByTestId("kanban-quick-details-todo")).toHaveCount(0);
      await expect(page.getByTestId("task-form-create")).toHaveCount(0);
      await expect(quickForm).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(quickForm).toHaveCount(0);
      await page.getByTestId("kanban-quick-add-todo").click();
      await expect(quickInput).toHaveValue("");

      await quickInput.fill(draftTitle);
      await page.keyboard.press("Enter");
      await expect(
        column(page, "todo").locator("[data-card-id]").filter({ hasText: draftTitle }),
      ).toHaveCount(1);

      const taskId = await cardIdByTitle(page, draftTitle);

      // Полная форма остаётся доступной для редактирования уже созданной
      // карточки и сохраняет все поля.
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await editTaskInModal(page, { tags: "draft", dueAt: "2030-05-05" });

      const form = page.getByTestId("task-form-edit");

      await expect(form).toHaveCount(0);
      await closeCardModal(page);
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await page.getByTestId("kanban-modal-edit").click();
      await page
        .getByTestId("task-form-edit")
        .locator('textarea[name="descriptionMarkdown"]')
        .fill(description);
      await page
        .getByTestId("task-form-edit")
        .getByRole("button", { name: "Сохранить задачу" })
        .click();
      await expect(page.getByTestId("kanban-modal-description")).toHaveText(description);
      await closeCardModal(page);
    });

    test("открытые composer в разных колонках независимы и сохраняют черновики", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект двух composer");
      const todoDraft = uniqueTitle("Черновик todo");
      const progressDraft = uniqueTitle("Черновик progress");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      await page.getByTestId("kanban-quick-add-todo").click();
      await expect(page.getByTestId("kanban-quick-add-todo-input")).toBeFocused();
      await page.keyboard.type(todoDraft);

      await page.getByTestId("kanban-quick-add-in_progress").click();
      await expect(page.getByTestId("kanban-quick-add-in_progress-input")).toBeFocused();
      await page.keyboard.type(progressDraft);

      await page
        .getByTestId("kanban-quick-add-todo-form")
        .getByRole("button", { name: "Закрыть добавление карточки" })
        .click();

      // Закрытие todo не теряет независимый черновик in_progress.
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toHaveCount(0);
      await expect(page.getByTestId("kanban-quick-add-in_progress-input")).toHaveValue(
        progressDraft,
      );
      await expect(page.getByTestId("kanban-quick-add-in_progress-form")).toBeVisible();

      await page.getByTestId("kanban-quick-add-in_progress-input").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("kanban-count-in_progress")).toHaveText("1");
      await expect(
        column(page, "in_progress").locator("[data-card-id]").filter({ hasText: progressDraft }),
      ).toHaveCount(1);
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

    test("открывает карточку Trello-модалом и сохраняет заголовок и описание", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект Trello-модала");
      const taskTitle = uniqueTitle("Задача Trello-модала");
      const updatedTitle = uniqueTitle("Обновлённая Trello-задача");
      const description = "Описание из Trello-модала\nвторая строка";

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      const modal = await openCardModal(page, taskId, taskTitle);

      await expect(modal).toHaveAttribute("data-variant", "desktop");
      expect(await modal.evaluate((element) => element.tagName)).toBe("DIALOG");
      expect(
        await modal.evaluate(
          (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
        ),
      ).toBe(true);
      await expect(modal).toHaveAttribute("aria-label", "Детали задачи");
      await expect(page.getByTestId("kanban-modal-project")).toHaveText(projectTitle);
      await expect(page.getByTestId("kanban-modal-status")).toHaveText(STATUS_LABELS.todo);
      await expect(page.getByTestId("kanban-modal-move-field")).toBeVisible();
      await expect(page.getByTestId("kanban-modal-priority")).toBeVisible();
      await expect(page.getByTestId("kanban-modal-due")).toBeVisible();
      await expect(page.getByTestId("kanban-modal-tags")).toBeVisible();

      const box = await modal.boundingBox();

      expect(box).not.toBeNull();

      if (box !== null) {
        expect(box.width).toBeGreaterThanOrEqual(760);
        expect(box.width).toBeLessThanOrEqual(860);
        expect(box.height).toBeLessThanOrEqual(DESKTOP_VIEWPORT.height);
        expect(Math.abs(box.x - (DESKTOP_VIEWPORT.width - box.width) / 2)).toBeLessThanOrEqual(2);
      }

      await page.getByTestId("kanban-modal-edit").click();

      const form = page.getByTestId("task-form-edit");

      await expect(form).toBeVisible();
      await expect(form.getByRole("combobox", { name: "Проект", exact: true })).toBeDisabled();
      await form.getByLabel("Название", { exact: true }).fill(updatedTitle);
      await form.locator('textarea[name="descriptionMarkdown"]').fill(description);
      await form.getByRole("button", { name: "Сохранить задачу" }).click();
      await expect(form).toHaveCount(0);

      await expect(page.getByTestId("kanban-modal-title")).toHaveText(updatedTitle);
      await expect(page.getByTestId("kanban-modal-description")).toHaveText(description);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);

      // Выбранная задача восстанавливается из query string после reload.
      await expect(page.getByTestId("kanban-details")).toBeVisible();
      await expect(page.getByTestId("kanban-modal-description")).toHaveText(description);

      await closeCardModal(page);
      await openCardModal(page, taskId, updatedTitle);
      await expect(page.getByTestId("kanban-modal-description")).toHaveText(description);
    });

    test("создаёт подзадачу в модале, открывает её и меняет статус", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект подзадач модала");
      const parentTitle = uniqueTitle("Родитель модала");
      const subtaskTitle = uniqueTitle("Подзадача модала");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const parentId = await createTask(page, {
        projectTitle,
        title: parentTitle,
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await openCardModal(page, parentId, parentTitle);

      await page.getByTestId("kanban-subtask-create").click();
      await page.getByTestId("kanban-subtask-input").fill(subtaskTitle);
      await page.getByTestId("kanban-subtask-submit").click();

      await expect(page.getByTestId("kanban-modal-subtasks")).toContainText(subtaskTitle);
      await expect(page.getByTestId("kanban-subtask-create")).toBeVisible();

      const subtaskId = await cardIdByTitle(page, subtaskTitle);

      await page.getByTestId(`kanban-subtask-${subtaskId}`).click();
      await expect(page.getByTestId("kanban-modal-title")).toHaveText(subtaskTitle);
      await expect(page.getByTestId("kanban-subtask-create")).toHaveCount(0);
      await expect(page.getByTestId("kanban-modal-parent")).toContainText(parentTitle);

      await page.getByTestId("kanban-modal-move-field").selectOption({ label: "Done (Done)" });
      await page.getByTestId("kanban-modal-move").click();
      await expect(page.getByTestId("kanban-modal-status")).toHaveText(STATUS_LABELS.done);
      await expect(page.getByTestId("kanban-modal-completed")).toBeVisible();

      await page.getByTestId("kanban-modal-parent").click();
      await expect(page.getByTestId("kanban-modal-title")).toHaveText(parentTitle);
      await expect(page.getByTestId(`kanban-subtask-${subtaskId}`)).toContainText(
        STATUS_LABELS.done,
      );

      await closeCardModal(page);
      await expectCardInColumn(page, subtaskId, "done");

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expectCardInColumn(page, subtaskId, "done");
      await expect(page.getByTestId(`kanban-subtasks-${parentId}`)).toHaveText("Подзадачи: 1");
    });

    test("не закрывает модал с несохранённым черновиком без подтверждения", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект черновика модала");
      const taskTitle = uniqueTitle("Задача черновика модала");
      const draftTitle = uniqueTitle("Черновик Trello");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await openCardModal(page, taskId, taskTitle);
      await page.getByTestId("kanban-modal-edit").click();

      const form = page.getByTestId("task-form-edit");
      const titleInput = form.getByLabel("Название", { exact: true });

      await titleInput.fill(draftTitle);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kanban-draft-confirm")).toBeVisible();
      await expect(page.getByTestId("kanban-details")).toBeVisible();
      await expect(titleInput).toHaveValue(draftTitle);

      await page.getByTestId("kanban-draft-keep").click();
      await expect(page.getByTestId("kanban-draft-confirm")).toHaveCount(0);
      await expect(titleInput).toHaveValue(draftTitle);

      // Backdrop тоже проходит через подтверждение и не теряет draft.
      await page.mouse.click(5, 5);
      await expect(page.getByTestId("kanban-draft-confirm")).toBeVisible();
      await expect(titleInput).toHaveValue(draftTitle);

      await page.getByTestId("kanban-draft-keep").click();
      await page.getByTestId("kanban-details-close").click();
      await expect(page.getByTestId("kanban-draft-confirm")).toBeVisible();
      await expect(page.getByTestId("kanban-details")).toBeVisible();

      await page.getByTestId("kanban-draft-discard").click();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);

      await openCardModal(page, taskId, taskTitle);
      await expect(page.getByTestId("kanban-modal-title")).toHaveText(taskTitle);
    });

    test("удерживает фокус в desktop-модале, подтверждении и возвращает на карточку", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект фокуса модала");
      const taskTitle = uniqueTitle("Задача фокуса модала");
      const draftTitle = uniqueTitle("Черновик фокуса модала");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);

      const opener = page.getByTestId(`kanban-open-${taskId}`);

      await opener.focus();
      const modal = await openCardModal(page, taskId, taskTitle);

      // Нативный dialog сразу переводит фокус внутрь.
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);

      // Tab и Shift+Tab не выходят за границы модала.
      for (let index = 0; index < 12; index += 1) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
          true,
        );
      }

      for (let index = 0; index < 12; index += 1) {
        await page.keyboard.press("Shift+Tab");
        expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
          true,
        );
      }

      // Черновик: фокус уходит в alertdialog и не покидает его.
      await page.getByTestId("kanban-modal-edit").click();

      const form = page.getByTestId("task-form-edit");
      const titleInput = form.getByLabel("Название", { exact: true });

      await titleInput.fill(draftTitle);
      await page.keyboard.press("Escape");

      const confirm = page.getByTestId("kanban-draft-confirm");

      await expect(confirm).toBeVisible();
      await expect
        .poll(async () =>
          page.evaluate(
            () => document.activeElement?.closest('[data-testid="kanban-draft-confirm"]') !== null,
          ),
        )
        .toBe(true);

      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(
            () => document.activeElement?.closest('[data-testid="kanban-draft-confirm"]') !== null,
          ),
        ).toBe(true);
      }

      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Shift+Tab");
        expect(
          await page.evaluate(
            () => document.activeElement?.closest('[data-testid="kanban-draft-confirm"]') !== null,
          ),
        ).toBe(true);
      }

      // «Продолжить редактирование» возвращает фокус в форму и сохраняет draft.
      await confirm.getByTestId("kanban-draft-keep").click();
      await expect(confirm).toHaveCount(0);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("name") ?? null))
        .toBe("title");
      await expect(titleInput).toHaveValue(draftTitle);

      // Закрытие с черновиком снова требует подтверждения.
      await page.getByTestId("kanban-details-close").click();
      await expect(confirm).toBeVisible();
      await expect(modal).toBeVisible();

      await page.getByTestId("kanban-draft-discard").click();
      await expect(modal).toHaveCount(0);

      // Фокус возвращается на карточку, открывшую модал.
      await expect
        .poll(async () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
        )
        .toBe(`Открыть карточку задачи ${taskTitle}`);
    });

    test("сохраняет быстрые черновики при чужой команде и смене breakpoint", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект черновиков модала");
      const taskTitle = uniqueTitle("Задача черновиков модала");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await openCardModal(page, taskId, taskTitle);

      const due = page.getByTestId("kanban-modal-due");
      const tags = page.getByTestId("kanban-modal-tags");
      const priority = page.getByTestId("kanban-modal-priority");
      const nextStatus = page.getByTestId("kanban-modal-move-field");

      await due.fill("2030-09-09");
      await priority.selectOption("high");

      // Успешная команда по приоритету не стирает несохранённый срок.
      await expect(priority).toHaveValue("high");
      await expect(due).toHaveValue("2030-09-09");

      await tags.fill("alpha, beta");
      await nextStatus.selectOption({ label: "In Progress" });

      // Breakpoint не стирает быстрые черновики.
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(page.getByTestId("kanban-details")).toHaveAttribute("data-variant", "mobile");
      await expect(due).toHaveValue("2030-09-09");
      await expect(tags).toHaveValue("alpha, beta");
      await expect(nextStatus.locator("option:checked")).toHaveText("In Progress");

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await expect(page.getByTestId("kanban-details")).toHaveAttribute("data-variant", "desktop");
      await expect(due).toHaveValue("2030-09-09");
      await expect(tags).toHaveValue("alpha, beta");
      await expect(nextStatus.locator("option:checked")).toHaveText("In Progress");

      // Закрытие с любым быстрым черновиком требует подтверждения.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kanban-draft-confirm")).toBeVisible();
      await expect(due).toHaveValue("2030-09-09");

      await page.getByTestId("kanban-draft-keep").click();
      await expect(page.getByTestId("kanban-draft-confirm")).toHaveCount(0);

      await page.getByTestId("kanban-details-close").click();
      await page.getByTestId("kanban-draft-discard").click();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
    });

    test("скрывает переключатель при каждом быстром черновике и не теряет ввод", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект guard черновика");
      const taskTitle = uniqueTitle("Задача guard черновика");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await openCardModal(page, taskId, taskTitle);

      const viewToggle = page.getByTestId("project-view-modal-list");
      const due = page.getByTestId("kanban-modal-due");
      const tags = page.getByTestId("kanban-modal-tags");
      const nextStatus = page.getByTestId("kanban-modal-move-field");

      await expect(viewToggle).toBeVisible();

      // Каждый быстрый черновик делает переключатель недоступным: обычный
      // click или Enter по нему физически невозможен, ввод остаётся в поле.
      await nextStatus.selectOption({ label: "In Progress" });
      await expect(viewToggle).toHaveCount(0);
      await expect(nextStatus.locator("option:checked")).toHaveText("In Progress");
      await nextStatus.selectOption({ label: "ToDo" });
      await expect(viewToggle).toBeVisible();

      await due.fill("2030-09-09");
      await expect(viewToggle).toHaveCount(0);
      await expect(due).toHaveValue("2030-09-09");
      await due.fill("");
      await expect(viewToggle).toBeVisible();

      await tags.fill("release");
      await expect(viewToggle).toHaveCount(0);
      await expect(tags).toHaveValue("release");
      await tags.fill("");
      await expect(viewToggle).toBeVisible();

      await page.getByTestId("kanban-subtask-create").click();

      const subtaskTitle = page.getByTestId("kanban-subtask-input");

      await subtaskTitle.fill("Черновик подзадачи");
      await expect(viewToggle).toHaveCount(0);
      await expect(subtaskTitle).toHaveValue("Черновик подзадачи");

      // Escape не теряет черновик, а показывает подтверждение.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kanban-draft-confirm")).toBeVisible();
      await expect(subtaskTitle).toHaveValue("Черновик подзадачи");
      await page.getByTestId("kanban-draft-keep").click();
      await expect(page.getByTestId("kanban-draft-confirm")).toHaveCount(0);
      await expect(viewToggle).toHaveCount(0);

      await page.getByTestId("kanban-subtask-cancel").click();
      await expect(viewToggle).toBeVisible();
      await page.getByTestId("kanban-details-close").click();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
    });

    test("при VERSION_CONFLICT показывает серверную версию и не перезаписывает чужую правку", async ({
      page,
      context,
    }) => {
      const projectTitle = uniqueTitle("Проект конфликта модала");
      const taskTitle = uniqueTitle("Задача конфликта модала");
      const serverTitle = uniqueTitle("Серверная правка модала");
      const staleTitle = uniqueTitle("Устаревшая правка модала");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);

      const stalePage = await context.newPage();

      await stalePage.goto(
        `/view/kanban?project=${new URL(page.url()).searchParams.get("project")}`,
      );
      await expect(stalePage.getByTestId("kanban-view")).toBeVisible();

      await openCardModal(page, taskId, taskTitle);
      await openCardModal(stalePage, taskId, taskTitle);

      await page.getByTestId("kanban-modal-edit").click();
      const freshForm = page.getByTestId("task-form-edit");

      await freshForm.getByLabel("Название", { exact: true }).fill(serverTitle);
      await freshForm.getByRole("button", { name: "Сохранить задачу" }).click();
      await expect(page.getByTestId("kanban-modal-title")).toHaveText(serverTitle);

      await stalePage.getByTestId("kanban-modal-edit").click();
      const staleForm = stalePage.getByTestId("task-form-edit");

      await staleForm.getByLabel("Название", { exact: true }).fill(staleTitle);
      await staleForm.getByRole("button", { name: "Сохранить задачу" }).click();

      await expect(stalePage.getByTestId("task-details-error")).toContainText(
        "Задача уже изменена в другом месте",
      );
      await expect(stalePage.getByTestId("task-form-edit")).toHaveCount(0);
      await expect(stalePage.getByTestId("kanban-modal-title")).toHaveText(serverTitle);

      await stalePage.reload();
      await expect(stalePage.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(stalePage, projectTitle);
      // Выбранная задача восстанавливается из query string; модал уже открыт.
      await expect(stalePage.getByTestId("kanban-details")).toBeVisible();
      await expect(stalePage.getByTestId("kanban-modal-title")).toHaveText(serverTitle);
      await expect(stalePage.getByTestId("kanban-modal-description")).toBeVisible();

      await stalePage.close();
    });

    test("удаляет задачу из модала только после подтверждения", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект удаления модала");
      const taskTitle = uniqueTitle("Задача удаления модала");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await openCardModal(page, taskId, taskTitle);

      await page.getByTestId("task-delete").click();
      await expect(page.getByTestId("task-delete-confirm-panel")).toBeVisible();
      await expect(card(page, taskId)).toBeVisible();

      await page.getByTestId("task-delete-cancel").click();
      await expect(page.getByTestId("task-delete-confirm-panel")).toHaveCount(0);

      await page.getByTestId("task-delete").click();
      await page.getByTestId("task-delete-confirm").click();

      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(card(page, taskId)).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await filterByProject(page, projectTitle);
      await expect(card(page, taskId)).toHaveCount(0);
    });

    test("показывает проекты карточками и открывает доску и список с проектом", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект карточек");
      const description = uniqueTitle("Описание проекта");
      const backlogTitle = uniqueTitle("В работе карточек");
      const overdueTitle = uniqueTitle("Просроченная карточка");
      const doneTitle = uniqueTitle("Готовая карточка");

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle, { description });

      const projectId = await projectIdByOption(page, projectTitle);

      await openTaskList(page);
      await page
        .getByTestId("task-filters")
        .getByRole("combobox", { name: "Проект", exact: true })
        .selectOption({ label: projectTitle });
      await createTask(page, { projectTitle, title: backlogTitle, status: "in_progress" });
      await createTask(page, {
        projectTitle,
        title: overdueTitle,
        status: "todo",
        dueAt: "2020-01-05",
      });
      await createTask(page, {
        projectTitle,
        title: doneTitle,
        status: "done",
        dueAt: "2020-01-06",
      });

      await openKanban(page, projectTitle);

      await expectBoardSummary(page, {
        total: 3,
        counts: { backlog: 0, todo: 1, in_progress: 1, done: 1 },
        overdue: 1,
      });

      await openProjectsMode(page);
      await revealProjectCard(page, projectId);

      const card = page.getByTestId(`projects-overview-card-${projectId}`);

      await expect(card).toContainText(projectTitle);
      await expect(card).toContainText(description);
      await expectProjectCounts(
        page,
        projectId,
        { backlog: 0, todo: 1, in_progress: 1, done: 1 },
        1,
      );

      await card.getByTestId(`projects-overview-open-${projectId}`).click();

      await expect(page).toHaveURL(new RegExp(`[?&]project=${projectId}`, "u"));
      await expect(page.getByTestId("kanban-columns")).toBeVisible();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);

      await openProjectsMode(page);
      await revealProjectCard(page, projectId);
      await page.getByTestId(`projects-overview-list-${projectId}`).click();

      await expect(page).toHaveURL(new RegExp(`/view/tasks\\?project=${projectId}`, "u"));
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(
        page.getByTestId("task-filters").getByRole("combobox", { name: "Проект", exact: true }),
      ).toHaveValue(projectId);
    });

    test("обновляет сводку после create, move, complete и delete", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект сводки");
      const taskTitle = uniqueTitle("Задача сводки");

      await openBoard(page);
      await createProjectOnBoard(page, projectTitle);

      const projectId = await projectIdByOption(page, projectTitle);

      await openKanban(page, projectTitle);
      await expectBoardSummary(page, {
        total: 0,
        counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
        overdue: 0,
      });

      // create
      await page.getByTestId("kanban-quick-add-todo").click();
      const input = page.getByTestId("kanban-quick-add-todo-input");

      await input.fill(taskTitle);
      await input.press("Enter");
      const taskId = await cardIdByTitle(page, taskTitle);

      await expectBoardSummary(page, {
        total: 1,
        counts: { backlog: 0, todo: 1, in_progress: 0, done: 0 },
        overdue: 0,
      });

      // move
      await moveWithMenu(page, taskId, "in_progress");
      await expectBoardSummary(page, {
        total: 1,
        counts: { backlog: 0, todo: 0, in_progress: 1, done: 0 },
        overdue: 0,
      });

      // complete
      await page.getByTestId(`kanban-open-${taskId}`).click();

      const details = page.getByTestId("kanban-details");

      await expect(details).toBeVisible();
      await details.getByRole("button", { name: "Завершить" }).click();
      await expectBoardSummary(page, {
        total: 1,
        counts: { backlog: 0, todo: 0, in_progress: 0, done: 1 },
        overdue: 0,
      });

      await details.getByRole("button", { name: "Закрыть детали" }).click();
      await expect(details).toHaveCount(0);

      // delete
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect(details).toBeVisible();
      await details.getByTestId("task-delete").click();
      await expect(page.getByTestId("task-delete-confirm-panel")).toBeVisible();
      await page.getByTestId("task-delete-confirm").click();

      await expectBoardSummary(page, {
        total: 0,
        counts: { backlog: 0, todo: 0, in_progress: 0, done: 0 },
        overdue: 0,
      });

      // Сетка использует ту же сводку и не отстаёт от доски.
      await openProjectsMode(page);
      await revealProjectCard(page, projectId);
      await expectProjectCounts(
        page,
        projectId,
        { backlog: 0, todo: 0, in_progress: 0, done: 0 },
        0,
      );
    });

    test("обновляет overdue после правки срока future → past → future", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект срока");
      const taskTitle = uniqueTitle("Задача срока");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: taskTitle,
        status: "todo",
        dueAt: "2030-01-10",
      });

      await openKanban(page, projectTitle);

      const projectId = await projectIdByOption(page, projectTitle);
      const expectedCounts = { backlog: 0, todo: 1, in_progress: 0, done: 0 } as const;

      await expectBoardSummary(page, { total: 1, counts: expectedCounts, overdue: 0 });

      const setDue = async (value: string): Promise<void> => {
        await page.getByTestId(`kanban-open-${taskId}`).click();

        const details = page.getByTestId("kanban-details");

        await expect(details).toBeVisible();
        await details.getByRole("button", { name: "Редактировать" }).click();

        const form = page.getByTestId("task-form-edit");

        await expect(form).toBeVisible();
        await form.getByLabel("Срок", { exact: true }).fill(value);
        await form.getByRole("button", { name: "Сохранить задачу" }).click();
        await expect(form).toHaveCount(0);

        await details.getByRole("button", { name: "Закрыть детали" }).click();
        await expect(details).toHaveCount(0);
      };

      // future → past: задача становится просроченной.
      await setDue("2020-01-05");
      await expectBoardSummary(page, { total: 1, counts: expectedCounts, overdue: 1 });

      await openProjectsMode(page);
      await revealProjectCard(page, projectId);
      await expectProjectCounts(page, projectId, expectedCounts, 1);

      await openKanban(page, projectTitle);

      // past → future: просрочка снимается.
      await setDue("2030-01-10");
      await expectBoardSummary(page, { total: 1, counts: expectedCounts, overdue: 0 });

      await openProjectsMode(page);
      await revealProjectCard(page, projectId);
      await expectProjectCounts(page, projectId, expectedCounts, 0);
    });

    test("показывает агрегат обзора проектов и не теряет проекты при пагинации", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект агрегата");
      const todoTitle = uniqueTitle("Задача агрегата");
      const doneTitle = uniqueTitle("Готовая задача агрегата");

      const readOverview = async (): Promise<{
        readonly total: number;
        readonly overdue: number;
      }> => {
        await expect(page.getByTestId("projects-overview-total-tasks")).toBeVisible();

        return {
          total: Number(
            (await page.getByTestId("projects-overview-total-tasks").textContent())?.trim() ??
              "NaN",
          ),
          overdue: Number(
            (await page.getByTestId("projects-overview-overdue").textContent())?.trim() ?? "NaN",
          ),
        };
      };

      await openProjectsMode(page);
      const before = await readOverview();

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, { projectTitle, title: todoTitle, status: "todo" });
      await createTask(page, { projectTitle, title: doneTitle, status: "done" });

      // Агрегат по всем проектам теперь живёт в обзоре, а не на доске:
      // доска всегда показывает один проект.
      await openProjectsMode(page);
      const after = await readOverview();

      expect(after.total).toBe(before.total + 2);
      expect(after.overdue).toBeGreaterThanOrEqual(before.overdue);

      // Догружаем все страницы проектов: сумма карточек должна совпасть с
      // агрегатом, который считается по полным данным.
      const cardTotals = page.locator('[data-testid^="projects-overview-total-project-"]');
      let guard = 0;

      while ((await page.getByTestId("projects-overview-load-more").count()) > 0 && guard < 20) {
        const count = await cardTotals.count();

        await page.getByTestId("projects-overview-load-more").click();
        await expect.poll(async () => cardTotals.count()).toBeGreaterThan(count);
        guard += 1;
      }

      const values = (await cardTotals.allTextContents()).map((value) => Number(value.trim()));

      expect(values.length).toBeGreaterThan(0);
      expect(values.reduce((sum, value) => sum + value, 0)).toBe(after.total);
    });

    test("настраивает колонки из канбана: rename, reorder и reload", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект настроек колонок канбана");
      const renamedTitle = uniqueTitle("Колонка A");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const todoId = await columnIdByTitle(page, "ToDo");
      const progressId = await columnIdByTitle(page, "In Progress");
      const doneId = await columnIdByTitle(page, "Done");

      await openSettings(page);

      expect(await settingsColumnIds(page)).toEqual([todoId, progressId, doneId]);
      await expect(page.getByTestId("kanban-column-form")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Удалить колонку" })).toHaveCount(0);
      await expect(page.getByRole("combobox")).toHaveCount(0);

      await saveColumnTitle(page, todoId, renamedTitle);
      await expect(page.getByTestId(`project-settings-column-input-${todoId}`)).toHaveValue(
        renamedTitle,
      );

      await page.getByTestId(`project-settings-column-down-${todoId}`).click();
      await expect.poll(async () => settingsColumnIds(page)).toEqual([progressId, todoId, doneId]);

      // Drag handle в модалке: Done перед In Progress.
      const handle = page.getByTestId(`project-settings-column-drag-${doneId}`);
      const target = page.getByTestId(`project-settings-column-${progressId}`);
      const sourceBox = await handle.boundingBox();
      const targetBox = await target.boundingBox();

      expect(sourceBox).not.toBeNull();
      expect(targetBox).not.toBeNull();

      if (sourceBox !== null && targetBox !== null) {
        await page.mouse.move(
          sourceBox.x + sourceBox.width / 2,
          sourceBox.y + sourceBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 6, {
          steps: 10,
        });
        await page.mouse.up();
      }

      await expect.poll(async () => settingsColumnIds(page)).toEqual([doneId, progressId, todoId]);
      await expect(page.getByTestId(`project-settings-column-notice-${doneId}`)).toContainText(
        "Порядок колонок сохранён",
      );

      await closeSettings(page);

      await expect.poll(async () => columnIdList(page)).toEqual([doneId, progressId, todoId]);
      await expect(page.getByTestId("kanban-column-title-todo")).toHaveText(renamedTitle);

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(projectTitle);
      await expect.poll(async () => columnIdList(page)).toEqual([doneId, progressId, todoId]);
      await expect(page.getByTestId("kanban-column-title-todo")).toHaveText(renamedTitle);
    });

    test("настраивает колонки из списка и сохраняет порядок после reload", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект настроек колонок списка");
      const renamedTitle = uniqueTitle("Колонка списка A");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await createTask(page, { projectTitle, title: uniqueTitle("Задача колонки списка") });

      const filter = page.getByTestId("task-filter-column");

      await filter.selectOption({ label: "ToDo" });
      await expect(page).toHaveURL(/[?&]column=/u);
      const todoId = new URL(page.url()).searchParams.get("column") ?? "";
      await filter.selectOption({ label: "In Progress" });
      await expect.poll(() => new URL(page.url()).searchParams.get("column")).not.toBe(todoId);
      const progressId = new URL(page.url()).searchParams.get("column") ?? "";
      await filter.selectOption({ label: "Done" });
      await expect.poll(() => new URL(page.url()).searchParams.get("column")).not.toBe(progressId);
      const doneId = new URL(page.url()).searchParams.get("column") ?? "";
      await filter.selectOption({ label: "Все колонки" });
      await expect.poll(() => new URL(page.url()).searchParams.get("column")).toBeNull();

      expect(todoId.length).toBeGreaterThan(0);
      expect(progressId.length).toBeGreaterThan(0);
      expect(doneId.length).toBeGreaterThan(0);

      await openSettings(page);
      await saveColumnTitle(page, todoId, renamedTitle);

      await page.getByTestId(`project-settings-column-down-${todoId}`).click();
      await expect.poll(async () => settingsColumnIds(page)).toEqual([progressId, todoId, doneId]);

      await page.getByTestId(`project-settings-column-down-${todoId}`).click();
      await expect.poll(async () => settingsColumnIds(page)).toEqual([progressId, doneId, todoId]);

      await closeSettings(page);

      await expect
        .poll(async () => filter.locator("option").allTextContents())
        .toEqual(["Все колонки", "In Progress", "Done", renamedTitle]);

      await page.reload();
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect
        .poll(async () => filter.locator("option").allTextContents())
        .toEqual(["Все колонки", "In Progress", "Done", renamedTitle]);

      await openSettings(page);
      expect(await settingsColumnIds(page)).toEqual([progressId, doneId, todoId]);
      await expect(page.getByTestId(`project-settings-column-input-${todoId}`)).toHaveValue(
        renamedTitle,
      );
      await closeSettings(page);
    });

    test("перетаскивает карточку за заголовок, теги и отступ, клик открывает", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект drag за области");
      const byTitleTitle = uniqueTitle("Карточка заголовка");
      const byTagTitle = uniqueTitle("Карточка тега");
      const byPaddingTitle = uniqueTitle("Карточка отступа");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const byTitleId = await createTask(page, {
        projectTitle,
        title: byTitleTitle,
        tags: "release",
      });
      const byTagId = await createTask(page, {
        projectTitle,
        title: byTagTitle,
        tags: "backend",
      });
      await createTask(page, { projectTitle, title: byPaddingTitle, status: "todo" });

      await openKanban(page, projectTitle);

      // Клик по заголовку открывает карточку.
      await page.getByTestId(`kanban-open-${byTitleId}`).click();
      await expect(page.getByTestId("kanban-details")).toBeVisible();
      await closeCardModal(page);

      // Drag из заголовка: карточка перемещается, modal не открывается.
      const titleBox = await page.getByTestId(`kanban-open-${byTitleId}`).boundingBox();

      expect(titleBox).not.toBeNull();

      if (titleBox !== null) {
        await dragCardFromPoint(
          page,
          { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 },
          "in_progress",
        );
      }

      await expectCardInColumn(page, byTitleId, "in_progress");
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);

      // Drag из тега.
      const tag = card(page, byTagId).getByText("backend", { exact: true });
      const tagBox = await tag.boundingBox();

      expect(tagBox).not.toBeNull();

      if (tagBox !== null) {
        await dragCardFromPoint(
          page,
          { x: tagBox.x + tagBox.width / 2, y: tagBox.y + tagBox.height / 2 },
          "done",
        );
      }

      await expectCardInColumn(page, byTagId, "done");
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);

      // Drag из пустого отступа article (3 px от края, вне кнопок).
      const cardBox = await card(page, byTitleId).boundingBox();

      expect(cardBox).not.toBeNull();

      if (cardBox !== null) {
        await dragCardFromPoint(page, { x: cardBox.x + 3, y: cardBox.y + 3 }, "todo");
      }

      await expectCardInColumn(page, byTitleId, "todo");
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);

      // После drag обычный клик снова открывает карточку.
      await page.getByTestId(`kanban-open-${byTitleId}`).click();
      await expect(page.getByTestId("kanban-details")).toBeVisible();
      await closeCardModal(page);
    });

    test("меню не меняет карточку, не обрезается колонкой, clamp и закрытие при scroll", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект меню карточки");
      const taskTitle = uniqueTitle("Карточка меню");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);

      const trigger = page.getByTestId(`kanban-menu-${taskId}`);
      const cardBoxBefore = await card(page, taskId).boundingBox();

      expect(cardBoxBefore).not.toBeNull();

      await trigger.click();

      const menu = page.getByTestId(`kanban-card-menu-${taskId}`);

      await expect(menu).toBeVisible();

      const cardBoxAfter = await card(page, taskId).boundingBox();

      expect(cardBoxAfter).not.toBeNull();

      if (cardBoxBefore !== null && cardBoxAfter !== null) {
        expect(cardBoxAfter.x).toBeCloseTo(cardBoxBefore.x, 0);
        expect(cardBoxAfter.y).toBeCloseTo(cardBoxBefore.y, 0);
        expect(cardBoxAfter.width).toBeCloseTo(cardBoxBefore.width, 0);
        expect(cardBoxAfter.height).toBeCloseTo(cardBoxBefore.height, 0);
      }

      const menuBox = await menu.boundingBox();

      expect(menuBox).not.toBeNull();

      if (menuBox !== null) {
        expect(menuBox.x).toBeGreaterThanOrEqual(0);
        expect(menuBox.y).toBeGreaterThanOrEqual(0);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(DESKTOP_VIEWPORT.width + 1);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(DESKTOP_VIEWPORT.height + 1);
      }

      expect(
        await menu.evaluate(
          (element) => element.closest('[data-testid="kanban-column-scroll-todo"]') !== null,
        ),
      ).toBe(false);
      expect(
        await menu.evaluate((element) => Number(getComputedStyle(element).zIndex)),
      ).toBeGreaterThan(0);

      await trigger.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();

      // Много карточек: прокрутка колонки уводит кнопку из viewport и меню
      // закрывается (reposition/close вместо зависания над пустым местом).
      const quickTrigger = page.getByTestId("kanban-quick-add-todo");
      const quickInput = page.getByTestId("kanban-quick-add-todo-input");

      await quickTrigger.click();

      for (let index = 1; index <= 14; index += 1) {
        await quickInput.fill(`Меню карточка ${String(index).padStart(2, "0")}`);
        await quickInput.press("Enter");
      }

      await expect(page.getByTestId("kanban-count-todo")).toHaveText("15");
      await quickInput.press("Escape");
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toHaveCount(0);

      await trigger.click();
      await expect(menu).toBeVisible();
      await page.getByTestId("kanban-column-scroll-todo").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(menu).toHaveCount(0);

      // Низкий viewport: меню раскрывается вверх и остаётся в границах.
      await page.setViewportSize({ width: 1440, height: 480 });
      await expect(page.getByTestId("kanban-columns")).toBeVisible();
      await page.getByTestId("kanban-column-scroll-todo").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });

      const lastCard = page.getByTestId("kanban-cards-todo").locator("[data-card-id]").last();
      const lastId = await lastCard.getAttribute("data-card-id");

      expect(lastId).not.toBeNull();
      await page.getByTestId(`kanban-menu-${lastId ?? ""}`).click();

      const flipped = page.getByTestId(`kanban-card-menu-${lastId ?? ""}`);

      await expect(flipped).toBeVisible();
      await expect(flipped).toHaveAttribute("data-placement", "top");

      const flippedBox = await flipped.boundingBox();

      expect(flippedBox).not.toBeNull();

      if (flippedBox !== null) {
        expect(flippedBox.y).toBeGreaterThanOrEqual(0);
        expect(flippedBox.y + flippedBox.height).toBeLessThanOrEqual(480);
        expect(flippedBox.x).toBeGreaterThanOrEqual(0);
        expect(flippedBox.x + flippedBox.width).toBeLessThanOrEqual(1440);
      }

      await flipped.press("Escape");
      await expect(flipped).toHaveCount(0);
    });

    test("открывает меню с клавиатуры и сразу выполняет первое действие", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект клавиатурного меню");
      const taskTitle = uniqueTitle("Карточка клавиатурного меню");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);

      const trigger = page.getByTestId(`kanban-menu-${taskId}`);

      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");

      const menu = page.getByTestId(`kanban-card-menu-${taskId}`);
      const firstAction = menu.getByRole("menuitem").first();

      await expect(firstAction).toBeFocused();
      await expect(firstAction).toHaveText("Переместить в In Progress");

      await page.keyboard.press("Enter");

      await expectCardInColumn(page, taskId, "in_progress");
      await expect(page.getByTestId(`kanban-card-menu-${taskId}`)).toHaveCount(0);
    });

    test("держит desktop-колонки 288 px при resize и не растягивает add-column", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект фиксированной ширины");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      for (let index = 1; index <= 5; index += 1) {
        await addColumn(page, `Width ${String(index)}`, "open");
      }

      const readMetrics = async () => {
        const columns = await page.locator("[data-kanban-column-id]").evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);

            return {
              width: rect.width,
              x: rect.x,
              grow: style.flexGrow,
              shrink: style.flexShrink,
              basis: style.flexBasis,
            };
          }),
        );
        const board = await page.getByTestId("kanban-columns").evaluate((element) => {
          const rect = element.getBoundingClientRect();

          return {
            x: rect.x,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          };
        });

        return { columns, board };
      };

      await page.getByTestId("kanban-columns").evaluate((element) => {
        element.scrollLeft = 0;
      });
      await expect
        .poll(async () =>
          page.getByTestId("kanban-columns").evaluate((element) => element.scrollLeft),
        )
        .toBe(0);

      const initial = await readMetrics();

      expect(initial.columns).toHaveLength(8);

      for (const column of initial.columns) {
        expect(Math.abs(column.width - 288)).toBeLessThanOrEqual(1);
        expect(column.grow).toBe("0");
        expect(column.shrink).toBe("0");
        expect(column.basis).toBe("288px");
      }

      expect(Math.abs((initial.columns[0]?.x ?? 0) - initial.board.x)).toBeLessThanOrEqual(2);
      expect(initial.board.scrollWidth).toBeGreaterThan(initial.board.clientWidth);

      const addColumnBox = await page.getByTestId("kanban-add-column").boundingBox();

      expect(addColumnBox).not.toBeNull();
      expect(addColumnBox?.width ?? 0).toBeLessThanOrEqual(230);

      await page.setViewportSize({ width: 1920, height: 900 });
      await expect(page.getByTestId("kanban-columns")).toBeVisible();
      await expect
        .poll(async () => {
          const metrics = await readMetrics();

          return {
            count: metrics.columns.length,
            maxWidth: Math.max(...metrics.columns.map((column) => column.width)),
            minWidth: Math.min(...metrics.columns.map((column) => column.width)),
            overflow: metrics.board.scrollWidth > metrics.board.clientWidth,
          };
        })
        .toEqual({ count: 8, maxWidth: 288, minWidth: 288, overflow: true });

      const resized = await readMetrics();

      for (const column of resized.columns) {
        expect(column.grow).toBe("0");
        expect(column.shrink).toBe("0");
        expect(column.basis).toBe("288px");
      }
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

      const mobileColumn = await column(page, "todo").boundingBox();

      expect(mobileColumn).not.toBeNull();
      expect(mobileColumn?.width ?? 0).toBeGreaterThanOrEqual(MOBILE_VIEWPORT.width * 0.7);
      expect(mobileColumn?.width ?? 0).toBeLessThanOrEqual(MOBILE_VIEWPORT.width * 0.85 + 1);

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

      await page.goto(`/settings/plugins?task=${taskId}`);
      await expect(page.getByRole("heading", { name: "Плагины" })).toBeVisible();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);

      // Breakpoint: mobile dialog закрывается на desktop и снова открывается
      // при возврате на мобильный.
      await openKanban(page, projectTitle);
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect(page.getByTestId("kanban-details")).toBeVisible();

      await page.setViewportSize(DESKTOP_VIEWPORT);
      const desktopOverlay = page.getByTestId("kanban-details");

      await expect(desktopOverlay).toBeVisible();
      await expect(desktopOverlay).toHaveAttribute("data-variant", "desktop");
      await expect
        .poll(async () =>
          desktopOverlay.evaluate(
            (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
          ),
        )
        .toBe(true);
      await expect.poll(async () => page.locator("dialog").count()).toBe(1);

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
      await expect(page.getByTestId("kanban-details")).toHaveAttribute("data-variant", "mobile");
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);
    });

    test("настраивает проект на мобильном и обновляет mobile sheet", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект мобильных настроек");
      const renamedTitle = uniqueTitle("Мобильный проект переименован");

      await openTaskList(page);
      await createProject(page, projectTitle);

      const projectId = new URL(page.url()).searchParams.get("project") ?? "";

      expect(projectId.length).toBeGreaterThan(0);

      await openKanban(page, projectTitle);
      await expectNoHorizontalOverflow(page);

      const opener = page.getByTestId("project-settings-button");

      await expect(opener).toBeVisible();
      await opener.click();

      const dialog = page.getByTestId("project-settings-dialog");

      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
      await expect(page.getByTestId("project-settings-columns")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.getByTestId("project-settings-title-input").fill(renamedTitle);
      await page.getByTestId("project-settings-title-save").click();
      await expect(page.getByTestId("project-settings-title-notice")).toContainText(
        "Название проекта сохранено",
      );
      await page.getByTestId("project-settings-done").click();

      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("kanban-board-title")).toHaveText(renamedTitle);
      await expect(page).toHaveURL(new RegExp(`/view/kanban\\?[^#]*project=${projectId}`, "u"));
      await expectNoHorizontalOverflow(page);

      // Mobile sheet перечитывает проекты по той же revision.
      await page.getByTestId("projects-mobile-trigger").click();

      const sheet = page.getByTestId("projects-mobile-sheet");

      await expect(sheet).toBeVisible();
      await expect(page.getByTestId(`projects-mobile-item-${projectId}`)).toContainText(
        renamedTitle,
      );

      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);

      await page.reload();
      await expect(page.getByTestId("kanban-board-title")).toHaveText(renamedTitle);
      await expectNoHorizontalOverflow(page);
    });

    test("на 360 px длинная колонка прокручивается внутри и переживает resize", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект мобильной прокрутки");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      const trigger = page.getByTestId("kanban-quick-add-todo");
      const input = page.getByTestId("kanban-quick-add-todo-input");
      const scroll = page.getByTestId("kanban-column-scroll-todo");
      const header = page.getByTestId("kanban-column-todo").locator("header").first();

      await trigger.click();

      for (let index = 1; index <= 18; index += 1) {
        await input.fill(`Мобильная длинная ${String(index).padStart(2, "0")} ${projectTitle}`);
        await input.press("Enter");
      }

      await expect(page.getByTestId("kanban-count-todo")).toHaveText("18");
      // Escape после последнего submit теряется, пока input disabled: composer
      // остаётся открытым, а trigger «Добавить карточку» не рендерится.
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toHaveCount(0);
      await expect(trigger).toBeVisible();

      const expectLongColumn = async (): Promise<void> => {
        await expectNoHorizontalOverflow(page);

        const metrics = await scroll.evaluate((element) => ({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }));

        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

        const beforeScroll = await trigger.boundingBox();

        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect(trigger).toBeVisible();

        const afterScroll = await trigger.boundingBox();
        const headerBox = await header.boundingBox();

        expect(headerBox).not.toBeNull();
        expect(afterScroll?.y ?? 0).toBeCloseTo(beforeScroll?.y ?? 0, 0);
        expect(afterScroll?.y ?? 0).toBeGreaterThanOrEqual(
          (headerBox?.y ?? 0) + (headerBox?.height ?? 0) - 1,
        );
      };

      await expectLongColumn();

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expectLongColumn();

      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(page.getByTestId("kanban-view")).toBeVisible();
      await expectLongColumn();
    });

    test("сохраняет черновик названия при mobile → desktop → mobile и возвращает фокус", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект мобильного создания");
      const draftTitle = uniqueTitle("Черновик мобильного layout");
      const taskTitle = uniqueTitle("Мобильная созданная задача");

      await openTaskList(page);
      await createProject(page, projectTitle);

      await openKanban(page, projectTitle);
      await expectNoHorizontalOverflow(page);

      const opener = page.getByTestId("kanban-create-task");

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

      // Короткий composer содержит только название.
      const input = page.getByTestId("kanban-create-input");

      await input.fill(draftTitle);

      const expectDraft = async (): Promise<void> => {
        await expect(page.getByTestId("kanban-create-input")).toHaveValue(draftTitle);
      };

      // mobile → desktop: форма размонтирована из dialog, draft сохранён.
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await expect(page.getByTestId("kanban-create-dialog")).toHaveCount(0);
      await expect(page.getByTestId("kanban-create-panel")).toBeVisible();
      await expectDraft();

      // Перед desktop → mobile фокус явно находится в inline-форме; после
      // Escape ModalDialog обязан вернуть его на кнопку открытия.
      await page.getByTestId("kanban-create-input").focus();
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("name")))
        .toBe("title");

      // desktop → mobile: значение и фокус на opener.
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(page.getByTestId("kanban-create-dialog")).toBeVisible();
      await expectDraft();

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
        .toBe("kanban-create-task");

      // Новая session: чистый draft.
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("kanban-create-input")).toHaveValue("");

      await page.getByTestId("kanban-create-input").fill(taskTitle);
      await page.getByTestId("kanban-create-input").press("Enter");

      await expect(page.getByTestId("kanban-create-form")).toHaveCount(0);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
        .toBe("kanban-create-task");

      const taskId = await cardIdByTitle(page, taskTitle);

      await expectCardInColumn(page, taskId, "todo");
      await expectNoHorizontalOverflow(page);

      await page.goto("/view/tasks");
      await expect(page.getByTestId("task-list-view")).toBeVisible();
      await expect(page.getByTestId("kanban-create-first-project")).toHaveCount(0);
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
      await expect(page.getByTestId("kanban-tab-todo")).toHaveAttribute("aria-selected", "true");

      const snapType = await page
        .getByTestId("kanban-columns")
        .evaluate((element) => getComputedStyle(element).scrollSnapType);

      expect(snapType).toContain("x");

      await page.getByTestId("kanban-tab-done").click();
      await expect(page.getByTestId("kanban-tab-done")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("kanban-tab-todo")).toHaveAttribute("aria-selected", "false");
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
        page.getByTestId(`kanban-menu-${taskId}`),
      ]) {
        const box = await target.boundingBox();

        expect(box).not.toBeNull();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }

      await page.getByTestId(`kanban-menu-${taskId}`).click();

      const menu = page.getByTestId(`kanban-card-menu-${taskId}`);
      const menuItems = menu.getByRole("menuitem");
      const buttonCount = await menuItems.count();

      expect(buttonCount).toBeGreaterThanOrEqual(6);

      for (let index = 0; index < buttonCount; index += 1) {
        const box = await menuItems.nth(index).boundingBox();

        expect(box).not.toBeNull();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
    });

    test("открывает карточку полноэкранным модалом с focus trap и переживает breakpoint", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект мобильного Trello-модала");
      const taskTitle = uniqueTitle("Мобильная Trello-задача");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await page.getByTestId(`kanban-open-${taskId}`).click();

      const dialog = page.getByTestId("kanban-details");

      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("kanban-modal-title")).toHaveText(taskTitle);
      expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
      expect(
        await dialog.evaluate(
          (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
        ),
      ).toBe(true);

      const box = await dialog.boundingBox();

      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(MOBILE_VIEWPORT.width - 1);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MOBILE_VIEWPORT.height - 1);
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.closest("dialog") !== null))
        .toBe(true);

      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
          true,
        );
      }

      // Escape без черновика закрывает и возвращает фокус на карточку.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(async () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
        )
        .toBe(`Открыть карточку задачи ${taskTitle}`);

      // mobile → desktop: тот же нативный dialog остаётся модальным,
      // меняется только раскладка.
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect(dialog).toBeVisible();
      await page.setViewportSize(DESKTOP_VIEWPORT);

      const desktopModal = page.getByTestId("kanban-details");

      await expect(desktopModal).toBeVisible();
      await expect(desktopModal).toHaveAttribute("data-variant", "desktop");
      await expect
        .poll(async () =>
          desktopModal.evaluate(
            (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
          ),
        )
        .toBe(true);
      await closeCardModal(page);

      // desktop → mobile: снова полноэкранный нативный dialog.
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.getByTestId(`kanban-open-${taskId}`).click();
      await expect
        .poll(async () =>
          page
            .getByTestId("kanban-details")
            .evaluate(
              (element) => (element as HTMLDialogElement).open && element.matches(":modal"),
            ),
        )
        .toBe(true);
    });
  });

  test.describe("мобильный touch", () => {
    test.use({ viewport: MOBILE_VIEWPORT, hasTouch: true, isMobile: true });

    test("long press 220 ms перетаскивает карточку без открытия modal", async ({
      page,
      context,
    }) => {
      const projectTitle = uniqueTitle("Проект touch drag");
      const firstTitle = uniqueTitle("Touch первая");
      const secondTitle = uniqueTitle("Touch вторая");

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

      const sourceBox = await page.getByTestId(`kanban-open-${secondId}`).boundingBox();
      const targetBox = await column(page, "todo").locator("header").first().boundingBox();

      expect(sourceBox).not.toBeNull();
      expect(targetBox).not.toBeNull();

      if (sourceBox === null || targetBox === null) {
        return;
      }

      const startX = sourceBox.x + sourceBox.width / 2;
      const startY = sourceBox.y + sourceBox.height / 2;
      const endX = targetBox.x + targetBox.width / 2;
      const endY = targetBox.y + targetBox.height / 2;

      const cdp = await context.newCDPSession(page);
      const touch = async (
        type: "touchStart" | "touchMove" | "touchEnd",
        x: number,
        y: number,
      ): Promise<void> => {
        await cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints:
            type === "touchEnd" ? [] : [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
        });
      };

      await touch("touchStart", startX, startY);
      await page.waitForTimeout(260);

      for (let step = 1; step <= 10; step += 1) {
        await touch(
          "touchMove",
          startX + ((endX - startX) * step) / 10,
          startY + ((endY - startY) * step) / 10,
        );
        await page.waitForTimeout(15);
      }

      await touch("touchEnd", endX, endY);
      await cdp.detach();

      await expect.poll(async () => await cardTitles(page, "todo")).toEqual([secondId, firstId]);
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);
    });

    test("вертикальный touch scroll не запускает drag карточки", async ({ page, context }) => {
      const projectTitle = uniqueTitle("Проект touch scroll");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const firstId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Touch scroll первая"),
        status: "todo",
      });

      await openKanban(page, projectTitle);

      const quickTrigger = page.getByTestId("kanban-quick-add-todo");
      const quickInput = page.getByTestId("kanban-quick-add-todo-input");

      await quickTrigger.click();

      for (let index = 1; index <= 14; index += 1) {
        await quickInput.fill(`Touch scroll ${String(index).padStart(2, "0")}`);
        await quickInput.press("Enter");
      }

      await expect(page.getByTestId("kanban-count-todo")).toHaveText("15");
      await quickInput.press("Escape");
      await expect(page.getByTestId("kanban-quick-add-todo-form")).toHaveCount(0);

      const scroll = page.getByTestId("kanban-column-scroll-todo");
      const scrollBox = await scroll.boundingBox();

      expect(scrollBox).not.toBeNull();
      await expect.poll(async () => (await cardTitles(page, "todo"))[0]).toBe(firstId);

      if (scrollBox !== null) {
        const cdp = await context.newCDPSession(page);
        const x = scrollBox.x + scrollBox.width / 2;
        const startY = scrollBox.y + scrollBox.height - 40;

        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y: startY, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
        });

        for (let step = 1; step <= 10; step += 1) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              {
                x,
                y: startY - (step * 180) / 10,
                radiusX: 4,
                radiusY: 4,
                force: 1,
                id: 1,
              },
            ],
          });
          await page.waitForTimeout(15);
        }

        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      }

      await expect
        .poll(async () => scroll.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      // Порядок не изменился: это была прокрутка, а не drag.
      await expect.poll(async () => (await cardTitles(page, "todo"))[0]).toBe(firstId);
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
    });

    test("горизонтальный touch swipe по карточке прокручивает доску без drag", async ({
      page,
      context,
    }) => {
      const projectTitle = uniqueTitle("Проект touch swipe");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, {
        projectTitle,
        title: uniqueTitle("Touch swipe карточка"),
        status: "todo",
      });

      await openKanban(page, projectTitle);
      await addColumn(page, "Swipe 1", "open");
      await addColumn(page, "Swipe 2", "open");
      await addColumn(page, "Swipe 3", "open");

      const board = page.getByTestId("kanban-columns");

      await board.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await expect.poll(async () => board.evaluate((element) => element.scrollLeft)).toBe(0);

      const cardBox = await card(page, taskId).boundingBox();

      expect(cardBox).not.toBeNull();

      if (cardBox !== null) {
        const cdp = await context.newCDPSession(page);
        const startX = cardBox.x + cardBox.width / 2;
        const y = cardBox.y + cardBox.height / 2;

        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: startX, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
        });

        for (let step = 1; step <= 10; step += 1) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              {
                x: startX - (step * 220) / 10,
                y,
                radiusX: 4,
                radiusY: 4,
                force: 1,
                id: 1,
              },
            ],
          });
          await page.waitForTimeout(15);
        }

        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      }

      await expect
        .poll(async () => board.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      await expect(page.getByTestId(`kanban-card-${taskId}`)).toBeVisible();
      await expect(page.getByTestId("kanban-details")).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]task=/u);
    });
  });

  test.describe("десктопный viewport", () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    test("показывает и скрывает scroll affordance при overflow", async ({ page }) => {
      const projectTitle = uniqueTitle("Проект scroll affordance");

      await openTaskList(page);
      await createProject(page, projectTitle);
      await openKanban(page, projectTitle);

      await addColumn(page, "Scroll 1", "open");
      await addColumn(page, "Scroll 2", "open");
      await addColumn(page, "Scroll 3", "open");

      const columns = page.getByTestId("kanban-columns");
      const metrics = await columns.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));

      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
      await columns.evaluate((element) => {
        element.style.scrollBehavior = "auto";
        element.scrollLeft = 0;
      });
      await expect.poll(async () => columns.evaluate((element) => element.scrollLeft)).toBe(0);
      await expect(page.getByTestId("kanban-scroll-hint")).toBeVisible();
      await expect(page.getByTestId("kanban-scroll-fade")).toHaveCount(1);

      await columns.evaluate((element) => {
        element.style.scrollBehavior = "auto";
        element.scrollLeft = element.scrollWidth;
      });

      await expect
        .poll(async () => columns.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      await expect(page.getByTestId("kanban-scroll-hint")).toHaveCount(0);
      await expect(page.getByTestId("kanban-scroll-fade")).toHaveCount(0);

      await columns.evaluate((element) => {
        element.style.scrollBehavior = "auto";
        element.scrollLeft = 0;
      });
      await expect(page.getByTestId("kanban-scroll-hint")).toBeVisible();
    });

    test("отключение kanbaner.projects скрывает доску и список, не удаляя задачи", async ({
      page,
    }) => {
      const projectTitle = uniqueTitle("Проект отключения projects");
      const taskTitle = uniqueTitle("Задача отключения projects");

      await openTaskList(page);
      await createProject(page, projectTitle);
      const taskId = await createTask(page, { projectTitle, title: taskTitle, status: "todo" });

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, taskId, "todo");

      await page.goto("/settings/plugins");

      const toggle = page.getByRole("switch", {
        name: "Включить плагин Kanbaner Projects",
      });

      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(page.getByRole("heading", { name: "Kanbaner Projects" })).toBeVisible();

      await page.goto("/view/kanban");
      await expect(page.getByTestId("plugin-view-empty")).toBeVisible();

      // Список задач — часть того же UI-плагина, поэтому маршрут тоже пуст.
      await page.goto("/view/tasks");
      await expect(page.getByTestId("plugin-view-empty")).toBeVisible();

      await page.goto("/settings/plugins");
      const restoredToggle = page.getByRole("switch", {
        name: "Включить плагин Kanbaner Projects",
      });

      await restoredToggle.click();
      await expect(restoredToggle).toHaveAttribute("aria-checked", "true");

      await openKanban(page, projectTitle);
      await expectCardInColumn(page, taskId, "todo");
      await expectNoHorizontalOverflow(page);
    });
  });
});
