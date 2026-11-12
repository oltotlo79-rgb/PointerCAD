import { expect, type ConsoleMessage, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { openTarget } from './electronAppFlow.js';
import { uiMessage } from './uiMessages.js';
import { focusField } from './mathEditorReady.js';
import { mathCoordinateFlow } from './mathCoordinateFlow.js';
import { mathStatisticsFlow } from './mathStatisticsFlow.js';

/** One request this flow itself cancelled while the Worker was calculating it (W22 evidence). */
export interface ActiveCancellation {
  readonly source: string;
  readonly client: number;
  readonly serial: number;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly timeOrigin: number;
  readonly dispatchAt: number;
  readonly finishedAt: number;
  readonly status: string;
}
/** Only the W22 measurement passes this: its page observer emits the client evidence the step waits on. */
export interface MathInputFlowOptions { readonly activeCancellations: ActiveCancellation[] }

type ConsoleRow = Readonly<Record<string, unknown>>;
const consoleRow = (message: ConsoleMessage, prefix: string): ConsoleRow | null => {
  const text = message.text();
  if (!text.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length).trim());
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ConsoleRow : null;
  } catch { return null; }
};
const sameIdentity = (a: unknown, b: unknown): boolean => {
  const left = a !== null && typeof a === 'object' ? a as ConsoleRow : null, right = b !== null && typeof b === 'object' ? b as ConsoleRow : null;
  return left !== null && right !== null
    && ['documentId', 'documentVersion', 'editorId', 'inputRevision'].every(key => left[key] !== undefined && left[key] === right[key]);
};

/**
 * Types `source` into the open text editor and resolves with the client's actual dispatch of exactly that input.
 * The client logs `dispatch` synchronously just before posting the request, whose observed payload carries the
 * source (boundedCalculationClient.ts pump, mathPaceSlowFlow.ts installTransportObserver), so the signal is the
 * dispatch itself, never a fixed wait. Passive console evidence only; no product function is called.
 */
async function typeAndAwaitDispatch(page: Page, dialog: Locator, source: string, clients: ConsoleRow[]): Promise<ConsoleRow> {
  const marker = JSON.stringify(['source', ['string', source]]);
  let dispatch: ConsoleRow | undefined;
  const dispatched = page.waitForEvent('console', { timeout: 30_000, predicate: message => {
    const request = consoleRow(message, '[pcad:w22-transport]');
    if (request?.event !== 'request' || !JSON.stringify(request.payload).includes(marker)) return false;
    dispatch = clients.find(row => row.event === 'dispatch' && row.serial === request.serial
      && row.timeOrigin === request.timeOrigin && sameIdentity(row.identity, request.identity));
    return dispatch !== undefined;
  } });
  await dialog.locator('textarea').fill(source);
  await dispatched;
  if (dispatch === undefined) throw new Error('The actual client dispatch of the typed input was not observed');
  return dispatch;
}

/**
 * The long input the flow cancels. Its exact 1000-term rational sum outlasts the 1 s special-function allowance
 * (erf; createMathBackend.ts) in every environment, so the Worker calculates for about 2 s before it would reply
 * (uncancelled dispatch to complete, 2026-11-12: functional 2,086 ms, Firefox 2,172 ms, Electron 2,182 ms).
 * Shorter candidates leave too little time: 'sum(1/k^2,k,1,1000)+erf(1/2)' replied with a value in 636 ms on Electron,
 * and 'sum(1/k^2,k,1,1000)' alone (200 ms allowance) in about 0.4 s everywhere.
 */
const LONG_CALCULATION_SOURCE = 'sum(1/k^8,k,1,1000)+erf(1/2)';

/**
 * Cancels a calculation the Worker is actually running, as a user does: type a long input, then press Escape once
 * the client has dispatched it, the Worker has reported starting that very request, and it has not completed.
 * Waiting for the Worker's start (an event, not a fixed wait) matters: on Firefox an Escape 26 ms after the dispatch
 * aborted before the Worker started, and that Worker's partial phase log made the W22 evidence unprovable
 * (RUN 20261112-064006). The client must end the request as cancelled with Worker replacement; mathPaceSlowFlow.ts
 * then proves Worker start -> abort -> Worker terminate -> discard, no reply and no adoption for this exact request.
 */
async function cancelWhileCalculating(page: Page, dialog: Locator, source: string, record: ActiveCancellation[]): Promise<void> {
  const clients: ConsoleRow[] = [], phases: ConsoleRow[] = [];
  const listen = (message: ConsoleMessage): void => {
    const client = consoleRow(message, '[pcad:math-client]'), phase = consoleRow(message, '[pcad:math-phase]');
    if (client !== null) clients.push(client);
    if (phase !== null) phases.push(phase);
  };
  page.on('console', listen);
  try {
    const dispatch = await typeAndAwaitDispatch(page, dialog, source, clients);
    const same = (row: ConsoleRow): boolean => row.client === dispatch.client && row.serial === dispatch.serial && row.timeOrigin === dispatch.timeOrigin;
    const started = (): boolean => ['request-received', 'request-start'].every(name => phases.some(row => row.phase === name
      && row.serial === dispatch.serial && sameIdentity(row.identity, dispatch.identity)));
    // `listen` was registered first, so it has recorded each console message before this predicate reads it.
    if (!started()) await page.waitForEvent('console', { timeout: 30_000, predicate: () => started() });
    expect(clients.some(row => same(row) && row.event === 'complete'), 'Escape must reach a request that is still calculating').toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => clients.some(row => same(row) && row.event === 'finished'), { message: 'The client ends the cancelled request' }).toBe(true);
    const finished = clients.find(row => same(row) && row.event === 'finished');
    expect(finished?.status, 'The running request is cancelled, not completed').toBe('cancelled');
    expect(finished?.replaceWorker, 'Cancelling a running request terminates its Worker').toBe(true);
    record.push({ source, client: Number(dispatch.client), serial: Number(dispatch.serial), identity: dispatch.identity as ConsoleRow,
      timeOrigin: Number(dispatch.timeOrigin), dispatchAt: Number(dispatch.at), finishedAt: Number(finished?.at), status: String(finished?.status) });
    console.log(`[実測] 計算中の取消: dispatch から client の終了まで ${String(Math.round(Number(finished?.at) - Number(dispatch.at)))} ms (${String(finished?.status)})`);
  } finally { page.off('console', listen); }
}

/** Shared real MathLive + calculation Worker + file persistence flow in Chromium, Firefox, and Electron. */
export async function mathInputFlow(page: Page, info: TestInfo, app?: ElectronApplication, options?: MathInputFlowOptions): Promise<void> {
  await expect(page.getByRole('tab', { name: 'パラメータ', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  const row = (index: number) => page.locator('.pcad-parameter').nth(index);
  const name = (index: number) => row(index).locator('.pcad-field').nth(0).locator('input');
  const source = (index: number) => row(index).locator('.pcad-field').nth(1).locator('input');
  const result = (index: number) => row(index).locator('.pcad-field').nth(1).locator('.pcad-field__message');
  const add = () => page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  await add(); await name(0).fill('幅'); await name(0).press('Enter');
  await expect(name(0)).toHaveValue('幅'); await source(0).fill('3'); await source(0).press('Enter');
  await expect(result(0)).toHaveText('= 3'); await add(); await name(1).fill('計算値'); await name(1).press('Enter');
  await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
  const dialog = page.locator('.pcad-math-dialog');
  await expect(dialog.locator('textarea')).toBeVisible();
  await dialog.locator('textarea').fill('coef("幅")*2+sin(30)');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('係数と数学記号を区別する');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-help')).toHaveCount(0);
  await expect(dialog.locator('textarea')).toHaveValue('coef("幅")*2+sin(30)');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, Symbol.for('io.cortexjs.compute-engine')) === undefined)).toBe(true);
  expect(await dialog.locator('math-field').evaluate(field => Reflect.get(field.constructor, 'computeEngine') === null)).toBe(true);
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  await page.screenshot({ path: info.outputPath('math-coefficients.png'), fullPage: true });
  await dialog.getByRole('button', { name: '数式入力のヘルプ', exact: true }).click();
  await expect(page.locator('.pcad-help__article')).toContainText('係数と数学記号を区別する');
  await page.locator('.pcad-help').getByRole('button', { name: uiMessage('help', 'help.close'), exact: true }).click();
  // OPS-11b: math-fieldへの直接の.press()はMathLiveの焦点処理と競合するため、focusFieldで焦点の
  // 処理が終わるのを待ってからキーを送る(rules/06 §10.329、mathEditorReady.ts)。
  await focusField(dialog.locator('math-field'));
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0); await expect(result(1)).toHaveText('= 6.5');
  const adopted = await savePart(page, info, 'math-adopted.pcad', app);
  expect(adopted.parameters[1].value.mathDefinition).toMatchObject({ inputNotation: 'latex', angleUnit: 'degree' });
  expect(adopted.parameters.every(parameter => parameter.mathId !== undefined)).toBe(true);
  expect(adopted.parameters[1].value.value).toBe(6.5);
  await source(0).fill('4'); await source(0).press('Enter');
  await expect(result(1)).toHaveText('= 8.5');
  await name(0).fill('板幅'); await name(0).press('Enter');
  await expect(source(1)).toHaveValue(/板幅/u);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z');
  await expect(name(0)).toHaveValue('幅'); await expect(result(1)).toHaveText('= 8.5');
  const saved = await savePart(page, info, 'math-reopen.pcad', app);
  await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeVisible();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(dialog.locator('textarea')).toBeVisible(); await dialog.locator('textarea').fill('999');
  await dialog.locator('textarea').press('Escape');
  await expect(dialog).toHaveCount(0); await expect(result(1)).toHaveText('= 8.5');
  expect(await savePart(page, info, 'math-cancelled.pcad', app)).toEqual(saved);
  if (options !== undefined) {
    // Before the reload, which rebuilds every Worker anyway, so no later deadline pays for the replaced Worker.
    await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
    await expect(dialog.locator('math-field')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
    await expect(dialog.locator('textarea')).toBeVisible();
    await expect(dialog.locator('.pcad-math-editor__result[role="status"]')).toHaveText('= 8.5');
    await cancelWhileCalculating(page, dialog, LONG_CALCULATION_SOURCE, options.activeCancellations);
    await expect(result(1)).toHaveText('= 8.5');
    expect(await savePart(page, info, 'math-active-cancelled.pcad', app)).toEqual(saved);
  }
  await page.reload();
  if (app !== undefined) {
    await openTarget(app, info.outputPath('math-reopen.pcad'));
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  } else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
    await (await chooser).setFiles(info.outputPath('math-reopen.pcad'));
  }
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(result(1)).toHaveText('= 8.5');
  await row(1).getByRole('button', { name: '数式で入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await mathCoordinateFlow(page, info, app);
  await mathStatisticsFlow(page, info, app);
}
