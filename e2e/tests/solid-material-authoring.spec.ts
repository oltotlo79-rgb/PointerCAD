import { expect, test, type Locator } from '@playwright/test';
import { waitForRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';

test.use({ screenshot: 'off' });

interface Edges { readonly name: string; readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
interface Measured extends Edges { readonly scrollWidth: number; readonly clientWidth: number }

/**
 * Live DOM edges (RUN043958 strength-material-source-screen.png showed the fieldset, select, SHA-256 and URL crossing
 * the window's right edge): the material controls, the source region and its SHA-256/URL lines, every clipping ancestor
 * up to the right panel, the right panel itself and the window. Nothing is assumed about their sizes.
 */
function readMaterialLayout(fields: Locator): Promise<{ readonly limits: readonly Edges[]; readonly clips: readonly Measured[]; readonly parts: readonly Measured[] }> {
  return fields.evaluate((fieldset: HTMLElement) => {
    const measure = (name: string, element: Element | null | undefined): Measured => {
      if (element === null || element === undefined) throw new Error(`材料欄の ${name} がありません`);
      const box = element.getBoundingClientRect();
      return { name, left: box.left, right: box.right, top: box.top, bottom: box.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    };
    const panel = fieldset.closest('.pcad-panel--right');
    if (panel === null) throw new Error('材料欄が右の区画の中にありません');
    const clips: Measured[] = [];
    for (let element = fieldset.parentElement; element !== null; element = element === panel ? null : element.parentElement) {
      const style = getComputedStyle(element);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = element.getBoundingClientRect(), left = box.left + element.clientLeft, top = box.top + element.clientTop;
      clips.push({ name: `clip ${element.tagName.toLowerCase()}.${Array.from(element.classList).join('.')}`, left, top,
        right: left + element.clientWidth, bottom: top + element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
    }
    const source = fieldset.querySelector('section');
    const digest = source === null ? null : Array.from(source.querySelectorAll('p')).find(line => /SHA-256: [0-9a-f]{64}$/u.test(line.textContent ?? ''));
    return {
      limits: [{ name: 'window', left: 0, top: 0, right: innerWidth, bottom: innerHeight }, measure('right panel', panel)],
      clips,
      parts: [measure('fieldset', fieldset), measure('select', fieldset.querySelector('select')), measure('input', fieldset.querySelector('input')),
        measure('source region', source), measure('source SHA-256', digest), measure('source link', source?.querySelector('a'))],
    };
  });
}

/** Fails before photographing when a material part leaves the right panel, a clipping ancestor or the window, or text overflows sideways. */
async function expectMaterialInsidePanel(fields: Locator): Promise<void> {
  // The panel's own scrolling brings the whole wrapped (taller) fieldset into view before it is measured and photographed.
  await fields.evaluate((fieldset: HTMLElement) => { fieldset.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  const { limits, clips, parts } = await readMaterialLayout(fields);
  // clientLeft/clientTop/clientWidth/scrollWidth are whole CSS pixels while the box edges are fractional.
  const rounding = 1;
  for (const part of parts) for (const limit of [...limits, ...clips]) {
    const where = `${part.name} ${JSON.stringify(part)} inside ${limit.name} ${JSON.stringify(limit)}`;
    expect(part.left, where).toBeGreaterThanOrEqual(limit.left - rounding);
    expect(part.right, where).toBeLessThanOrEqual(limit.right + rounding);
    expect(part.top, where).toBeGreaterThanOrEqual(limit.top - rounding);
    expect(part.bottom, where).toBeLessThanOrEqual(limit.bottom + rounding);
  }
  for (const box of [...clips, ...parts.filter(part => ['fieldset', 'source region', 'source SHA-256'].includes(part.name))]) {
    expect(box.scrollWidth, `${box.name} must not overflow sideways ${JSON.stringify(box)}`).toBeLessThanOrEqual(box.clientWidth + rounding);
  }
}

test('立体解析で材料と板厚の適用範囲を選び直す', async ({ page }, info) => {
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
  const link = source.getByRole('link');
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^https:\/\//u);
  await expect(link).toHaveText(href ?? '');
  await expectMaterialInsidePanel(fields);
  await captureManualDetail(page, info, {
    name: 'strength-material-source', dialog: fields,
    fixture: { material: await material.inputValue(), thickness: await thickness.inputValue() }, script: new URL(import.meta.url),
  });

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
