import { expect, test, type Locator } from '@playwright/test';
import { placeAndSelectBox, propertySection, runMeasure } from './measurementCaptureSupport.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

test.use({ viewport: { width: 1440, height: 900 } });

function value(section: Locator, label: string): Locator {
  return section.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
}

test('FIX-02 密度の不正式から復帰し、測定済みの結果をインチへ切り替える', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await placeAndSelectBox(page);
  await runMeasure(page);
  const mass = propertySection(page, '質量特性');
  const measurement = propertySection(page, '測定');
  await expect(value(mass, '質量')).toHaveText('62.8 g', { timeout: KERNEL_TIMEOUT_MS });
  await expect(value(measurement, '測定した対象')).toHaveText('箱1');
  const density = mass.getByLabel('密度', { exact: true });
  await density.fill('1/2');
  await expect(value(mass, '質量')).toHaveText('4 g');
  for (const source of ['unknown_name', '1/0', '', '0', '-1', '-1/2', 'Infinity', '1+']) {
    await density.fill(source);
    await expect(density).toHaveAttribute('aria-invalid', 'true');
    await expect(value(mass, '質量')).toHaveText('未計算');
    await expect(value(mass, '慣性モーメント')).toHaveText('未計算');
    await expect(value(mass, '体積')).toHaveText('8000 mm³');
    await density.fill('1/2');
    await expect(value(mass, '質量')).toHaveText('4 g');
  }
  await page.locator('.pcad-statusbar__unit').click();
  await expect(value(measurement, '結果')).toHaveText('立体の体積: 0.488 in³');
  await expect(value(mass, '体積')).toHaveText('0.488 in³');
  await expect(value(mass, '重心')).toHaveText('0.000, 0.000, 0.000 in');
  await expect(value(mass, '慣性モーメント')).toContainText('g·mm²');
  await expect(density).toHaveValue('1/2');
  await expect(value(mass, '質量')).toHaveText('4 g');
  await page.locator('.pcad-statusbar__unit').click();
  await expect(value(measurement, '結果')).toHaveText('立体の体積: 8000 mm³');
  expect(errors).toEqual([]);
});

test('FIX-02 点検の基準を式で変えて再点検し、結果に使った基準を確認する', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await placeAndSelectBox(page);
  const section = propertySection(page, '3D プリントの点検');
  const thickness = section.getByLabel('肉厚の基準', { exact: true });
  const angle = section.getByLabel('せり出し角度の基準', { exact: true });
  const start = section.getByRole('button', { name: 'この基準で点検する', exact: true });
  await expect(thickness).toHaveValue('0.8');
  await expect(angle).toHaveValue('45');
  await thickness.fill('0');
  await expect(thickness).toHaveAttribute('aria-invalid', 'true');
  await expect(start).toBeDisabled();
  await thickness.fill('20+1');
  await angle.fill('91');
  await expect(angle).toHaveAttribute('aria-invalid', 'true');
  await expect(start).toBeDisabled();
  await angle.fill('30+30');
  await start.click();
  await expect(value(section, '結果に使った肉厚の基準')).toHaveText('21 mm', { timeout: KERNEL_TIMEOUT_MS });
  await expect(value(section, '結果に使った角度の基準')).toHaveText('60 度');
  await expect(value(section, '薄すぎるところ')).toHaveText(/^[1-9][0-9]* か所$/);
  await thickness.fill('1/2');
  await expect(value(section, '結果に使った肉厚の基準')).toHaveText('21 mm');
  await section.getByRole('button', { name: 'この基準で再点検する', exact: true }).click();
  await expect(value(section, '結果に使った肉厚の基準')).toHaveText('0.5 mm', { timeout: KERNEL_TIMEOUT_MS });
  await expect(value(section, '薄すぎるところ')).toHaveText('0 か所');
  await expect(value(section, 'せり出しているところ')).toHaveText('0 か所');
  await section.getByRole('button', { name: '点検を閉じる', exact: true }).click();
  await expect(section).toContainText('まだ点検していません。');
  await expect(thickness).toHaveValue('1/2');
  expect(errors).toEqual([]);
});
