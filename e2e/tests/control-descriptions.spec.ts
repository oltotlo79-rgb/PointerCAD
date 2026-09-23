import { expect, test } from '@playwright/test';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';

test('P12-5 操作説明の読取りは実ブラウザーの名前と一致し、空の説明を見逃さない', async ({ page }) => {
  await page.setContent(`<main>
    <input id="title-only" title="透過率" value="0.5">
    <label for="labelled">密度</label><input id="labelled" title="材料の密度を指定します">
    <span id="field-name">色</span><input id="referenced" aria-labelledby="field-name" aria-label="旧名" title="色を指定します">
    <input id="aria" aria-label="粗さ" title="粗さを指定します">
    <button id="button" title="前の変更を取り消します">元に戻す</button>
    <input type="hidden" value="対象外"><input hidden value="対象外">
  </main>`);
  const expectedNames = ['透過率', '密度', '色', '粗さ', '元に戻す'];
  const ids = ['title-only', 'labelled', 'referenced', 'aria', 'button'];
  for (let i = 0; i < ids.length; i += 1) {
    await expect(page.locator(`#${ids[i]}`)).toHaveAccessibleName(expectedNames[i]);
  }
  await page.locator('#title-only').focus();
  const record = await assertRenderedControlDescriptions(page.locator('main'));
  expect(record.controls.map(control => control.name)).toEqual(expectedNames);
  expect(record.count).toBe(5);
  await expect(page.locator('#title-only')).toHaveValue('0.5');
  await expect(page.locator('#title-only')).toBeFocused();

  // A valid name must not conceal a missing explanation; an unrelated title
  // must not make a nameless field pass. Exercise the actual rejecting wrapper.
  for (const source of [
    '<input aria-label="密度" title=" ">',
    '<div title="外枠の説明"><input></div>',
  ]) {
    await page.setContent(`<main>${source}</main>`);
    await expect(assertRenderedControlDescriptions(page.locator('main'))).rejects.toThrow(
      'Every displayed native control needs a name and a nonempty description');
  }
});
