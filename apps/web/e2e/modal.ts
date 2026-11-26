import { expect, type Page } from "@playwright/test";

/**
 * Ждёт применения quick-save вместе с завершением refresh.
 *
 * Отдельные expect(input enabled) и expect(save disabled) не атомарны: между
 * ними может начаться loading, который тоже отключает Save. В этот момент Close
 * ещё видит прежний dirty draft и открывает ложное подтверждение.
 */
export async function expectModalQuickSaveSettled(
  page: Page,
  inputTestId: string,
  saveTestId: string,
): Promise<void> {
  await expect
    .poll(() =>
      page.getByTestId("kanban-modal").evaluate(
        (modal, ids) => {
          const input = modal.querySelector<HTMLInputElement | HTMLSelectElement>(
            `[data-testid="${ids.input}"]`,
          );
          const save = modal.querySelector<HTMLButtonElement>(`[data-testid="${ids.save}"]`);

          return input?.disabled === false && save?.disabled === true;
        },
        { input: inputTestId, save: saveTestId },
      ),
    )
    .toBe(true);
}
