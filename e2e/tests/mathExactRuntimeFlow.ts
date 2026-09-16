import { expect, type ElectronApplication, type Page, type TestInfo, type Worker } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { uiMessage } from './uiMessages.js';
import { captureManualDetail } from './captureManualDetail.js';

/** The second matrix row is sqrt(2) times the first: its exact rank is one.
 * This exercises the bundled interpreter, including cancellation of old runtimes,
 * independently of a mocked engine response or a floating-point rank estimate. */
export async function mathExactRuntimeFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const workers: Worker[] = [], closed = new Set<Worker>(), requested = new Set<string>();
  const observeWorker = (worker: Worker) => {
    if (!/\/math\.worker[-.]/u.test(worker.url())) return;
    workers.push(worker); worker.on('close', () => { closed.add(worker); });
  };
  const observeRequest = (request: { url(): string }) => {
    if (request.url().includes('/exact-math/runtime/')) requested.add(request.url());
  };
  page.on('worker', observeWorker); page.on('request', observeRequest);
  try {
    await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
    await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
    const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
    const name = row.locator('.pcad-field').first().locator('input');
    await name.fill('厳密な階数と角度'); await name.press('Enter');
    await row.getByRole('button', { name: '数式で入力', exact: true }).click();
    const input = dialog.locator('textarea'), status = dialog.locator('[role="status"]');
    const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
    await expect(angle).toHaveValue('degree');
    await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
    const rank = 'rank([[sqrt(2),1],[2,sqrt(2)]])';
    // Check actual replacement after the 32nd completed request, without lowering the limit.
    for (let index = 0; index < 33; index += 1) {
      await input.fill(`${rank}+${index}`);
      await expect(status).toHaveText(`= ${index + 1}`, { timeout: 225_000 });
    }
    expect(workers).toHaveLength(2); await expect.poll(() => closed.size).toBe(1);
    const source = `${rank}+sin(30)`;
    await input.fill(source); await expect(status).toHaveText('= 1.5', { timeout: 225_000 });
    await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const saved = await savePart(page, info, 'math-exact-runtime.pcad', app);
    expect(saved.parameters.find(parameter => parameter.name === '厳密な階数と角度')?.value).toMatchObject({
      value: 1.5, source, mathDefinition: { source, angleUnit: 'degree' },
    });
    await reopenPart(page, info, 'math-exact-runtime.pcad', app);
    await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
    await row.getByRole('button', { name: '数式で入力', exact: true }).click();
    await expect(input).toHaveValue(source); await expect(angle).toHaveValue('degree');
    await expect(status).toHaveText('= 1.5', { timeout: 225_000 });
    await captureManualDetail(page, info, { name: 'math-exact-rank-degree', dialog,
      fixture: saved, script: new URL('./mathExactRuntimeFlow.ts', import.meta.url) });
    await angle.selectOption('radian');
    await expect.poll(async () => {
      const text = await status.innerText(); return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
    }, { timeout: 225_000 }).toBeCloseTo(1 + Math.sin(30), 12);
    await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const changed = await savePart(page, info, 'math-exact-radian.pcad', app);
    const value = changed.parameters.find(parameter => parameter.name === '厳密な階数と角度')?.value;
    expect(value?.mathDefinition).toMatchObject({ source, angleUnit: 'radian' });
    expect(value?.value).toBeCloseTo(1 + Math.sin(30), 12);
    await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
    const undone = await savePart(page, info, 'math-exact-undo.pcad', app);
    expect(undone.parameters.find(parameter => parameter.name === '厳密な階数と角度')?.value).toMatchObject({ value: 1.5,
      mathDefinition: { source, angleUnit: 'degree' } });
    for (const url of requested) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    await info.attach('bundled-math-runtime', { body: JSON.stringify({ workers: workers.length, closed: closed.size,
      requested: [...requested], source, expectedDegree: 1.5, expectedRadian: 1 + Math.sin(30) }, null, 2), contentType: 'application/json' });
  } finally { page.off('worker', observeWorker); page.off('request', observeRequest); }
}
