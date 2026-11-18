/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-14 ケガキの位置: 線に沿って X の向きに長さ 1000 の系列の溝幅 6 20×20 を置き、その途中(x = 500)の +Y の側の面に、Y の向きの
 * 部材を T に当てて置く。上の向きは +Z なので、1 本目の局所 +X(右の面)は世界の +Y。ケガキの位置の欄には、1 本目の右の面に、
 * 相手(20×20)の両側の 490.0 と 510.0 が出る(手で解いた値)。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

async function placeLine(page: Page, layout: Locator, points: string, length: string): Promise<void> {
  await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true }).fill(points);
  await expectPreviewLengths(layout, [length]);
  const token = await beginRecompute(page);
  await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
  await waitForRecompute(page, token);
}

export function registerFrameScribeMarksTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-14 ケガキの位置', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('途中に T で当てた部材の両側(490.0 と 510.0)が、1 本目の右の面のケガキの位置に出る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = detailsOf(page, dialog, 'catalog.frameLayout.title');
      await layout.locator('summary').click();
      await placeLine(page, layout, '0 0 0\n1000 0 0', '1000');
      await placeLine(page, layout, '500 10 0\n500 300 0', '290');
      await expect(componentRows(page)).toHaveCount(2);
      const [first] = (await readAssemblyStats(page)).components;

      const scribe = detailsOf(page, dialog, 'catalog.scribe.title');
      await scribe.locator('summary').click();
      const marks = `${uiMessage('catalog', 'catalog.scribe.face.right')} 490.0, 510.0`;
      await expect(scribe.locator('li')).toHaveText([uiMessage('catalog', 'catalog.scribe.row').replace('{name}', first?.name ?? '')
        .replace('{length}', '1000.0').replace('{marks}', marks)]);
      await expect(scribe.getByRole('button', { name: uiMessage('catalog', 'catalog.scribe.csv.export'), exact: true })).toBeEnabled();
      expect(errors).toEqual([]);
    });
  });
}
