import { expect, test, type Locator, type Page } from '@playwright/test';
import { EXACT_MATH_ENGINE_LIMITS } from '../../packages/expression/src/math/exactMathEngineClient.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * A scenario limit adds up the waits a flow makes one after another. It never extends a product
 * deadline or an individual wait (results 225 s, recomputation 150 s, editor preparation 225 s).
 * Firefox on 2026-09-23 (ARM64 Windows, 2 workers): the first request of every new calculation part,
 * which includes preparing the exact runtime, took 53.4-64.3 s alone and 61.1-71.8 s while two
 * parts prepared together. Editors never share a part, and the recomputation part is released after
 * 30 s idle, so each flow waits for these preparations several times.
 */
export const EXACT_RUNTIME_PREPARATION_ALLOWANCE_MS = 90_000;
/** A heavy exact calculation cannot run longer than the product's own calculation limit. */
export const EXACT_CALCULATION_ALLOWANCE_MS = EXACT_MATH_ENGINE_LIMITS.calculationMs;
/** Other editor steps, F1, saves, reopening and context teardown took 22-48 s in the same traces. */
export const MATH_SCENARIO_OVERHEAD_MS = 60_000;

/** Total limit of a flow from the exact-runtime preparations and heavy calculations it waits for in sequence. */
export function exactMathScenarioTimeout(preparations: number, heavyCalculations = 0): number {
  if (!Number.isSafeInteger(preparations) || preparations < 1 || !Number.isSafeInteger(heavyCalculations) || heavyCalculations < 0) {
    throw new RangeError('準備は1回以上、重い計算は0回以上の整数で指定してください。');
  }
  return preparations * EXACT_RUNTIME_PREPARATION_ALLOWANCE_MS + heavyCalculations * EXACT_CALCULATION_ALLOWANCE_MS
    + MATH_SCENARIO_OVERHEAD_MS;
}

/**
 * Coefficient editor, first coordinate editor beside the first recomputation, second coordinate editor,
 * reopened recomputation, re-edit editor and the edited recomputation settled before Undo: at most six
 * preparations in sequence. Undo then reuses the settled calculation part.
 */
export const EXACT_COORDINATE_SCENARIO_TIMEOUT_MS = exactMathScenarioTimeout(6);
/**
 * The same six preparations plus five Wallis-product calculations (second coordinate editor, reopening,
 * applying the edit, the edited recomputation and Undo), each measured at 26.3-36.7 s.
 */
export const INFINITE_RANGES_SCENARIO_TIMEOUT_MS = exactMathScenarioTimeout(6, 5);

/** Preparing coefficients may load the exact runtime before the text field exists. */
export async function waitForMathEditorText(dialog: Locator): Promise<void> {
  const started = performance.now();
  const input = dialog.locator('textarea'), retry = dialog.getByRole('button', { name: uiMessage('math', 'math.retry'), exact: true });
  await expect(input.or(retry), '係数の準備を終え、数式の入力欄または準備失敗の理由を表示すること')
    .toBeVisible({ timeout: 225_000 });
  if (await retry.isVisible()) throw new Error('数式の入力準備に失敗: ' + await dialog.getByRole('alert').innerText());
  await expect(input).toBeVisible();
  console.log(`[実測] 数式入力の準備 ${String(Math.round(performance.now() - started))} ms`);
}

/**
 * 構造入力の欄へ焦点を戻し、MathLive が焦点の処理を終えるまで待つ。MathLive 0.110.0 は欄へ焦点が入ると
 * 約60ms後(mathlive.mjs の onFocus の setTimeout)に内部の入力先へ焦点を移し直し、その間に焦点が外へ移っても
 * 欄へ戻してしまう。人の操作では起きない速さだが、自動操作は速いので、処理中の印が消えてからキーを押す。
 * 印は MathLive の内部の値のため、読めなければ 'unknown' を返して検査を失敗させる(版を上げたときに気づける)。
 * math-keyboard.spec.ts から共通化した(rules/06 §10.329)。math-field への直接の `.press()`/`.focus()` は
 * eslint.config.js の no-restricted-syntax が拒否するため、新しい画面検査はこの関数を経由すること。
 */
export async function focusField(field: Locator): Promise<void> {
  await field.focus();
  await expect(field).toBeFocused();
  await expect.poll(() => field.evaluate(element => {
    const editor: unknown = Reflect.get(element, '_mathfield');
    return typeof editor === 'object' && editor !== null ? Reflect.get(editor, 'focusBlurInProgress') : 'unknown';
  }), 'MathLive が欄へ焦点を移す処理を終えている').toBe(false);
}

/**
 * Settle the preceding edit, then verify the generation caused by Undo before inspecting its display or
 * saving. Undo pressed while the edit's recomputation still prepared cancelled that generation, and a
 * cancelled calculation part is never reused (rules/06 §10.149), so Firefox prepared the exact runtime
 * again and three flows ran out of their totals on 2026-09-23. Settling also verifies the edited document.
 */
export async function undoMathEdit(page: Page): Promise<void> {
  const settleStarted = performance.now();
  await waitForRecompute(page);
  const settledMs = performance.now() - settleStarted;
  const before = await beginRecompute(page);
  const undoStarted = performance.now();
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, before);
  const { project, title } = test.info();
  console.log(`[実測] Undo前の編集の再計算 ${String(Math.round(settledMs))} ms / Undo後の再計算 `
    + `${String(Math.round(performance.now() - undoStarted))} ms（${project.name} › ${title}）`);
}
