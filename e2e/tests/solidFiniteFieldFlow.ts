import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { solidFiniteAuthoringFlow } from './solidFiniteAuthoringFlow.js';

async function rendered(page: Page, previous: number): Promise<number> {
  await expect.poll(() => page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0)).toBeGreaterThan(previous);
  return page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
}

// Compare consecutive actual canvas captures, rather than treating a DOM legend as a draw.
async function stableCanvas(page: Page): Promise<Buffer> {
  await page.mouse.move(0, 0);
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  let previous = '', current = '';
  await expect.poll(async () => {
    current = (await canvas.screenshot()).toString('base64');
    const stable = current === previous;
    previous = current;
    return stable;
  }).toBe(true);
  return Buffer.from(current, 'base64');
}

export async function solidFiniteFieldFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  let workers = 0;
  page.on('worker', () => { workers += 1; });
  let firstField: Buffer = Buffer.alloc(0), secondField: Buffer = Buffer.alloc(0), renderCount = 0;
  await solidFiniteAuthoringFlow(page, info, app, {
    firstResultRows: 2,
    beforeFirstResult: async panel => {
      await panel.getByRole('button', { name: '\u30b9\u30c6\u30c3\u30d7\u3092\u8ffd\u52a0', exact: true }).click();
      await panel.getByTestId('solid-finite-forceFactors-1').fill('0.5');
      await panel.getByTestId('solid-finite-prescribedFactors-1').fill('1');
    },
    afterFirstResult: async panel => {
      const step = panel.getByTestId('solid-finite-field-step');
      const quantity = panel.getByTestId('solid-finite-field-quantity');
      const scale = panel.getByTestId('solid-finite-field-scale');
      const legend = panel.getByTestId('solid-finite-field-legend');
      await expect(step.locator('option')).toHaveCount(2);
      await expect(legend).toBeVisible();
      const workerCount = workers;
      renderCount = await page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
      await scale.fill('0'); renderCount = await rendered(page, renderCount);
      const undeformed = await stableCanvas(page);
      await scale.fill('1'); renderCount = await rendered(page, renderCount);
      await quantity.selectOption('xx'); renderCount = await rendered(page, renderCount);
      await expect(legend).toContainText('MPa');
      await scale.fill('5000'); renderCount = await rendered(page, renderCount);
      const deformed = await stableCanvas(page);
      expect(deformed.equals(undeformed)).toBe(false);
      await step.selectOption('2'); renderCount = await rendered(page, renderCount);
      firstField = await stableCanvas(page);
      expect(firstField.equals(deformed)).toBe(false);
      expect(workers).toBe(workerCount);
    },
    afterEdit: async () => {
      renderCount = await rendered(page, renderCount);
      expect((await stableCanvas(page)).equals(firstField)).toBe(false);
    },
    afterSecondResult: async () => {
      renderCount = await page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
      secondField = await stableCanvas(page);
    },
    afterClose: async () => {
      await rendered(page, renderCount);
      expect((await stableCanvas(page)).equals(secondField)).toBe(false);
    },
  });
}
