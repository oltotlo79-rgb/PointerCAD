import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { PCAD_TEMPLATE_KIND, writePcadFile } from '../../packages/io/src/index.js';
import { createEmptyPartDocument, DEFAULT_TOOL_DEFAULTS, type PartDocument } from '../../packages/model/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';
import { commitCircle, enterCenter, openCircle } from './toolDefaultsSettingsFlow.js';

const radii = (document: PartDocument) => document.sketches.flatMap(sketch => sketch.features)
  .flatMap(feature => feature.kind === 'arc' && feature.startAngle.value === 0 && feature.endAngle.value === 360
    ? [feature.radius] : []);

/** 同じ実ファイルをWebとElectronの通常の「ひな形から新規」で読み込む。 */
export async function templateToolDefaultsFlow(page: Page, info: TestInfo,
  app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const templatePath = info.outputPath('inch-circle-default.pcadt');
  await writeFile(templatePath, writePcadFile(createEmptyPartDocument(), {
    kind: PCAD_TEMPLATE_KIND, lengthUnit: 'inch',
    toolDefaults: { ...DEFAULT_TOOL_DEFAULTS, circleRadius: '25.4' },
  }));
  const open = await beginRecompute(page);
  if (app === undefined) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'), chooseToolMenuItem(page, 'ファイルのほかの操作', 'ひな形から新規'),
    ]);
    await chooser.setFiles(templatePath);
  } else {
    await openTarget(app, templatePath);
    await chooseToolMenuItem(page, 'ファイルのほかの操作', 'ひな形から新規');
  }
  await waitForRecompute(page, open);

  // ひな形の25.4は内部mm。表示がinchでも円を25.4inchへ拡大しない。
  await openCircle(page); await enterCenter(page, '0');
  const field = page.locator('.pcad-popover .pcad-field').first();
  await expect(field.locator('input')).toHaveValue('25.4');
  await expect(field.locator('.pcad-field__unit')).toHaveText('mm');
  await expect(field.locator('.pcad-field__message')).toHaveText('= 1 in');
  await commitCircle(page);

  // 実際に入力した1はinch。原式と単位を保存し、同じ半径25.4mmを作る。
  await openCircle(page); await enterCenter(page, '3');
  await field.locator('input').fill('1');
  await expect(field.locator('.pcad-field__unit')).toHaveText('in');
  await expect(field.locator('.pcad-field__message')).toHaveText('= 1 in');
  await commitCircle(page);
  const saved = await savePart(page, info, 'inch-circle-defaults.pcad', app);
  expect(radii(saved).map(radius => radius.source)).toEqual(['25.4', '(1)in']);
  expect(radii(saved).map(radius => radius.value)).toEqual([25.4, 25.4]);

  // 開き直した文書の元の式・数値を通常の保存経路で確認する。
  await page.reload(); await waitForStartupHealth(page, info);
  const reopen = await beginRecompute(page), path = info.outputPath('inch-circle-defaults.pcad');
  if (app === undefined) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'), page.getByRole('button', { name: '開く', exact: true }).click(),
    ]);
    await chooser.setFiles(path);
  } else {
    await openTarget(app, path); await page.getByRole('button', { name: '開く', exact: true }).click();
  }
  await waitForRecompute(page, reopen);
  expect(await savePart(page, info, 'inch-circle-defaults-reopened.pcad', app)).toEqual(saved);
}
