/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows, fastenedBadges } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';
import { installSaveCapture, savedDocument } from './usabilityKeyboardFlow.js';
import { fieldByMessageKey } from './fieldByLabel.js';

/*
 * E-10 パネルと扉(第 3 段):
 * 1. 600 × 400 の枠(内側 580 × 380)に、板の押さえ(最初の行・間隔 300)と平たいつなぎ(最初の行)も選んで扉を付けると、板 488 × 288 の各辺に
 *    押さえ 2 つずつ(488 ÷ 300・288 ÷ 300 を切り上げて 2 以上。手で解いた値)の 8 つと、扉の枠の 4 隅のつなぎ 4 つを予告し、扉の枠 4・板 1・
 *    ヒンジ 2・押さえ 8・つなぎ 4 の 19 個を 1 回で置く。部品の木の「締結」の印(互いに固定した組の部品に付く)は、扉の部品 17 個(ヒンジを
 *    除く)にだけ付く。保存した文書(e2e の共通の読み方 savedDocument)でも、17 個が同じ 1 つの組で、元の枠 4 本とヒンジ 2 つは組に入らない。
 * 2. 安全柵(線 0 0 → 600 0・閉じない・高さ 600・横の材 100 と 500)を置いた後、扉の窓で区画の 4 本(柱 2・横の材 2)を選んで扉を付けられる
 *    (開口は柱と横の材の内側 580 × 380 で、上と同じ 7 個)。柵の窓に扉は足さない(統括の決定 ⑥ A)。
 */
/** 保存した組立の部品ごとの、互いに固定した組の id(組に入っていなければ null)。 */
function rigidGroupIds(document: unknown): readonly (string | null)[] {
  const components: unknown = typeof document === 'object' && document !== null ? Reflect.get(document, 'components') : undefined;
  if (!Array.isArray(components)) throw new Error('保存した組立に部品の並びがありません。');
  return components.map((component: unknown) => {
    const id: unknown = typeof component === 'object' && component !== null ? Reflect.get(component, 'rigidGroupId') : undefined;
    return typeof id === 'string' && id !== '' ? id : null;
  });
}

function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

function field(page: Page, scope: Locator, key: string): Locator {
  return fieldByMessageKey(page, scope, 'catalog', key, { fieldSelector: 'label.pcad-field', controlSelector: 'input, textarea' });
}

async function openSeries(page: Page, app: ElectronApplication | undefined): Promise<Locator> {
  await startAssembly(page, app);
  const dialog = await openFramePicker(page);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
  return dialog;
}

/** 木の 4 行を選び、扉の窓を開いて、板・扉の枠・ヒンジ(と求めがあれば押さえ・つなぎ)の最初の行を選ぶ。 */
async function chooseDoor(page: Page, dialog: Locator, keys: readonly string[]): Promise<Locator> {
  await componentRows(page).nth(0).click();
  for (const index of [1, 2, 3]) await componentRows(page).nth(index).click({ modifiers: ['Shift'] });
  const door = detailsOf(page, dialog, 'catalog.frameDoor.title');
  await door.locator('summary').click();
  for (const key of keys) {
    const rows = choice(door, 'catalog', key);
    await expect(rows.locator('option')).not.toHaveCount(1);
    await rows.selectOption({ index: 1 });
  }
  return door;
}

async function placeDoor(page: Page, door: Locator, count: number): Promise<void> {
  const token = await beginRecompute(page);
  await door.getByRole('button', { name: uiMessage('catalog', 'catalog.frameDoor.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(door.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameDoor.placed').replace('{count}', String(count)));
}

const ROWS = ['catalog.frameDoor.board', 'catalog.frameDoor.frame', 'catalog.frameDoor.hinge'];

export function registerFrameDoorPartsTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-10 扉の第 3 段', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('板の押さえ 8・平たいつなぎ 4 も一緒に 19 個を置き、ヒンジを除く扉の部品 17 個を 1 つの組にまとめる', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      const dialog = await openSeries(page, app);
      const layout = detailsOf(page, dialog, 'catalog.frameLayout.title');
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0 0 0', '600 0 0', '600 400 0', '0 400 0'].join('\n'));
      await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
      const token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);

      const door = await chooseDoor(page, dialog, [...ROWS, 'catalog.frameDoor.holder', 'catalog.frameDoor.connector']);
      await expect(door.getByText(uiMessage('catalog', 'catalog.frameDoor.groupNote'), { exact: true })).toBeVisible();
      await expect(door.getByText(uiMessage('catalog', 'catalog.frameDoor.preview').replace('{width}', '576').replace('{height}', '376')
        .replace('{boardWidth}', '488').replace('{boardHeight}', '288')
        + uiMessage('catalog', 'catalog.frameDoor.previewParts').replace('{holders}', '8').replace('{connectors}', '4'), { exact: true }))
        .toBeVisible();
      await placeDoor(page, door, 19);
      await expect(componentRows(page)).toHaveCount(23);
      // 「締結」の印は扉の部品 17 個にだけ付く(元の枠 4 本とヒンジ 2 つの 6 行には付かない)。
      await expect(fastenedBadges(page)).toHaveCount(17);
      // 保存した文書(e2e の共通の読み方 savedDocument)で、17 個が同じ 1 つの組で、残り 6 個は組に入らない事。
      await installSaveCapture(page);
      const groups = rigidGroupIds(await savedDocument(page, 'assembly'));
      const grouped = groups.filter((group) => group !== null);
      expect(grouped).toHaveLength(17);
      expect(new Set(grouped).size).toBe(1);
      expect(groups.filter((group) => group === null)).toHaveLength(6);
      expect(errors).toEqual([]);
    });

    test('安全柵を置いた後、扉の窓で区画の 4 本(柱 2・横の材 2)を選んで扉を付けられる', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const dialog = await openSeries(page, appForPage(page));
      const fence = detailsOf(page, dialog, 'catalog.fence.title');
      await fence.locator('summary').click();
      await field(page, fence, 'catalog.fence.points').fill(['0 0', '600 0'].join('\n'));
      await fence.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.fence.closed'), exact: true }).uncheck();
      await field(page, fence, 'catalog.fence.height').fill('600');
      await field(page, fence, 'catalog.fence.railHeights').fill('100, 500');
      const token = await beginRecompute(page);
      await fence.getByRole('button', { name: uiMessage('catalog', 'catalog.fence.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(fence.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.fence.placed').replace('{count}', '4'));
      await expect(componentRows(page)).toHaveCount(4);

      const door = await chooseDoor(page, dialog, ROWS);
      await placeDoor(page, door, 7);
      await expect(componentRows(page)).toHaveCount(11);
      expect(errors).toEqual([]);
    });
  });
}
