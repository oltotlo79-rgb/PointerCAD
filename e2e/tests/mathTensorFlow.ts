import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { uiMessage } from './uiMessages.js';
import { captureManualDetail } from './captureManualDetail.js';

/** Explicitly select every index, then retain those choices through a real CAD point's history. */
export async function mathTensorFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), dialog = page.locator('.pcad-math-dialog');
  const sources = ['tensorelement(tensorproduct([1,2],[3,4]),[2,1])',
    'tensorcontract([[1,2],[3,4]],1,2)', 'levicivita([1,3,2])'] as const;
  const values = [6,5,-1];
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (let axis = 0; axis < 3; axis += 1) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await expect(dialog.locator('textarea')).toBeFocused();
    if (axis === 0) {
      await dialog.locator('textarea').fill('tensorproduct([[1,2],[3,4]],[5,6])');
      await expect(dialog.locator('[role="status"]')).toHaveText(uiMessage('math', 'math.kind.tensor'));
      await expect(apply).toBeDisabled();
      await dialog.locator('textarea').fill('tensorelement([[1,2],[3,4]],[1])');
      await expect(dialog.locator('[role="status"]')).toContainText('各軸に1つずつ');
      await expect(apply).toBeDisabled();
      await dialog.locator('textarea').fill('tensorproduct([1,2],[3,4])');
      const picker = dialog.getByRole('group', { name: uiMessage('math','math.component.title'), exact: true });
      const choose = picker.getByRole('button', { name: uiMessage('math','math.component.choose'), exact: true });
      const index = (number: number) => picker.getByRole('spinbutton', { name: `${uiMessage('math','math.component.axis')} ${number}`, exact: true });
      await expect(picker).toBeVisible();
      await expect(index(1)).toHaveValue(''); await expect(index(2)).toHaveValue('');
      await expect(choose).toBeDisabled(); await expect(apply).toBeDisabled();
      await index(1).fill('2'); await expect(choose).toBeDisabled();
      await index(2).fill('0'); await expect(choose).toBeDisabled();
      await index(2).fill('1'); await expect(choose).toBeEnabled();
      await page.screenshot({ path: info.outputPath('math-tensor-component-picker.png'), fullPage: true });
      await captureManualDetail(page, info, {
        name: 'math-tensor-component-picker', dialog, script: new URL(import.meta.url),
        fixture: { kind: 'mathematics-input-example', coordinate: 'X',
          source: await dialog.locator('textarea').inputValue(),
          indices: [await index(1).inputValue(), await index(2).inputValue()] },
      });
      await index(2).press('Enter');
      await expect(dialog.locator('textarea')).toBeFocused();
      await expect(dialog.locator('textarea')).toHaveValue(sources[axis]);
      await expect(picker).toHaveCount(0);
    } else {
      await dialog.locator('textarea').fill(sources[axis]);
    }
    await expect(dialog.locator('[role="status"]')).toHaveText(`= ${values[axis]}`);
    if (axis === 0) {
      await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
      await expect(dialog.locator('math-field')).toBeFocused();
      await dialog.locator('summary').filter({ hasText: '記号と演算を探す' }).click();
      await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '線形代数' });
      await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('テンソル');
      await expect(dialog.getByRole('button', { name: /テンソル積/u })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /テンソルの成分を選ぶ/u })).toBeVisible();
      await page.screenshot({ path: info.outputPath('math-tensor-indices.png'), fullPage: true });
      await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
      await expect(dialog.locator('textarea')).toHaveValue(sources[axis]);
    }
    await apply.click(); await expect(dialog).toHaveCount(0);
    await expect(popover.locator('.pcad-field__message').nth(axis)).toHaveText(`= ${values[axis]}`);
  }
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const point = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(point).toBeVisible();
  const saved = await savePart(page, info, 'tensor-coordinates.pcad', app);
  const feature = saved.sketches[0].features.find(item => item.kind === 'point');
  expect(feature).toMatchObject({ at: { mode: 'absolute',
    x: { value: 6, source: sources[0], mathDefinition: { format: 'pointercad-math/1' } },
    y: { value: 5, source: sources[1], mathDefinition: { format: 'pointercad-math/1' } },
    z: { value: -1, source: sources[2], mathDefinition: { format: 'pointercad-math/1' } } } });
  await reopenPart(page, info, 'tensor-coordinates.pcad', app);
  await point.click();
  const properties = page.locator('.pcad-panel--right');
  await properties.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabProperties'), exact: true }).click();
  const xLabel = uiMessage('numericInput', 'numericInput.field.x');
  const xField = properties.getByRole('textbox', { name: xLabel, exact: true });
  await expect(xField).toHaveValue(sources[0]);
  await properties.getByRole('button', { name: `${xLabel}: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue(sources[0]);
  const edited = 'tensorelement(tensorproduct([1,2],[3,4]),[2,2])';
  await dialog.locator('textarea').fill(edited);
  await expect(dialog.locator('[role="status"]')).toHaveText('= 8');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('テンソルの軸と成分を指定する');
  await page.keyboard.press('Escape');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await expect(xField).toHaveValue(edited);
  const changed = await savePart(page, info, 'tensor-point-edited.pcad', app);
  expect(changed.sketches[0].features.find(item => item.kind === 'point')).toMatchObject({ at: {
    x: { value: 8, source: edited }, y: { value: 5 }, z: { value: -1 } } });
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(xField).toHaveValue(sources[0]);
  await page.keyboard.press('Control+y'); await expect(xField).toHaveValue(edited);
}
