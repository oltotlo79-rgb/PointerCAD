import { expect, test } from '@playwright/test';
import { waitForRecompute } from './recompute.js';

test.use({ screenshot: 'off' });

test('立体解析で材料と板厚の適用範囲を選び直す', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  await waitForRecompute(page);
  await page.getByRole('button', { name: /^見た目/u }).click();
  await page.getByRole('group', { name: '見た目', exact: true })
    .getByRole('button', { name: '簡易強度計算', exact: true }).click();
  await page.getByTestId('solid-analysis-open').click();

  const panel = page.getByTestId('solid-analysis-panel');
  await expect(panel).toBeVisible();
  const fields = panel.getByTestId('solid-material-fields');
  const material = fields.getByTestId('solid-material-condition');
  const thickness = fields.getByTestId('solid-material-thickness');
  const source = fields.getByRole('region', { name: '材料値の出典と適用条件' });
  const run = panel.getByTestId('solid-run');
  const save = panel.getByTestId('solid-save');
  await expect(material).toHaveValue('');
  await expect(run).toBeEnabled(); await expect(save).toBeEnabled();

  await material.selectOption('ss400-plate-0-16');
  await thickness.fill('16');
  await expect(thickness).toHaveAttribute('aria-invalid', 'false');
  await expect(run).toBeEnabled(); await expect(save).toBeEnabled();
  await expect(source.getByText('0 < t ≤ 16 mm', { exact: true })).toBeVisible();
  await expect(source.getByText(/245 MPa/u)).toBeVisible();
  await expect(source.getByText('日本鉄鋼連盟', { exact: true })).toBeVisible();
  await expect(source.getByText('JIS G 3101', { exact: true })).toBeVisible();

  await thickness.fill('17');
  await expect(thickness).toHaveValue('17');
  await expect(thickness).toHaveAttribute('aria-invalid', 'true');
  await expect(fields.getByRole('alert')).toContainText('素材の板厚が選んだ材料の適用範囲外です');
  await expect(run).toBeDisabled(); await expect(save).toBeDisabled();
  await expect(thickness).toHaveValue('17');

  await material.selectOption('ss400-plate-16-40');
  await expect(thickness).toHaveValue('17');
  await expect(thickness).toHaveAttribute('aria-invalid', 'false');
  await expect(source.getByText('16 < t ≤ 40 mm', { exact: true })).toBeVisible();
  await expect(source.getByText(/235 MPa/u)).toBeVisible();
  await expect(source.getByText('日本鉄鋼連盟', { exact: true })).toBeVisible();
  await expect(run).toBeEnabled(); await expect(save).toBeEnabled();

  await material.selectOption('ss400-plate-0-16');
  await thickness.fill('１６');
  await expect(thickness).toHaveValue('１６');
  await expect(thickness).toHaveAttribute('aria-invalid', 'false');
  await expect(source.getByText(/245 MPa/u)).toBeVisible();
  await expect(run).toBeEnabled(); await expect(save).toBeEnabled();

  await material.selectOption('');
  await expect(material).toHaveValue('');
  await expect(fields.getByText('降伏材料を選ばない場合、降伏比は表示しません。', { exact: false })).toBeVisible();
  await expect(source).toHaveCount(0);
  await expect(run).toBeEnabled(); await expect(save).toBeEnabled();
  expect(errors).toEqual([]);
});
