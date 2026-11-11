import { expect, type Locator, type Page } from '@playwright/test';

/*
 * その場数値入力のポップアップ(.pcad-popover)と、その入力欄へ順に書き込む補助。
 * 12 の spec / flow に同じ本体で書き写していた物を 1 か所へ寄せた(P17)。本体は元の写しと同じ。
 * 本体の違う fillFields(cutPlaneMaterialsFlow.ts / exchange.spec.ts と 3 つの *CaptureSupport.ts)はそのまま残す。
 */

/** その場数値入力のポップアップ。開いていないときは 0 件になる。 */
export function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

/** ポップアップの式の欄。 */
export function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/** ポップアップの欄を埋める。null を渡した欄は既定値のままにする(NFR-UX-4)。 */
export async function fillFields(page: Page, sources: readonly (string | null)[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    if (source === null) {
      continue;
    }
    await inputs.nth(index).fill(source);
  }
}
