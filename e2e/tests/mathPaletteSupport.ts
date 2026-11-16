import type { Locator, TestInfo } from '@playwright/test';

/*
 * 数式の窓の「記号と演算を探す」(制御していない details)を開く補助(外部検査 run 43803122461 の調べ)。
 * Playwright の click は押下の宛先だけを確かめるので、押下と離しの間に summary が動くと click は details に届かず、
 * 開かないまま成功として先へ進む。押した後に開いた事を確かめ、開いていなければ、押す前と後の窓の送りの位置と大きさ・
 * 結果の欄の状態・summary の位置と、押している間の送りと結果の欄の大きさの変化の記録を添付に出して、その場で失敗にする。
 * 開くまで押し直す形にはしない(原因を隠さない)。
 */

const PALETTE = 'details.pcad-math-editor__palette';

/** 押している間の、窓の送りと結果の欄の大きさの変化を記録し始める(window に置き、paletteWatchResult で取り出して外す)。 */
async function startPaletteWatch(dialog: Locator): Promise<void> {
  await dialog.evaluate(element => {
    const events: { readonly kind: string; readonly at: number; readonly value: number }[] = [];
    const result = element.querySelector('.pcad-math-editor__result');
    const onScroll = (): void => { events.push({ kind: 'scroll', at: performance.now(), value: element.scrollTop }); };
    element.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) events.push({ kind: 'result-height', at: performance.now(), value: entry.contentRect.height });
    });
    if (result !== null) observer.observe(result);
    Reflect.set(window, '__pcadPaletteWatch', { events, stop: () => { element.removeEventListener('scroll', onScroll); observer.disconnect(); } });
  });
}

async function paletteWatchResult(dialog: Locator): Promise<unknown> {
  return dialog.evaluate(() => {
    const watch: unknown = Reflect.get(window, '__pcadPaletteWatch');
    Reflect.deleteProperty(window, '__pcadPaletteWatch');
    if (typeof watch !== 'object' || watch === null) return null;
    const stop: unknown = Reflect.get(watch, 'stop');
    if (typeof stop === 'function') stop();
    return Reflect.get(watch, 'events');
  });
}

/** 窓と palette の今の状態(添付に出す材料)。 */
async function paletteState(dialog: Locator): Promise<{ readonly open: boolean | null } & Record<string, unknown>> {
  return dialog.evaluate((element, selector) => {
    const box = (node: Element | null) => {
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const details = element.querySelector(selector), summary = details?.querySelector('summary') ?? null;
    const result = element.querySelector('.pcad-math-editor__result');
    return {
      open: details instanceof HTMLDetailsElement ? details.open : null,
      at: performance.now(), viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: { ...box(element), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight },
      summary: box(summary), result: { ...box(result), text: result?.textContent ?? null,
        busy: element.querySelector('.pcad-math-editor__expression')?.getAttribute('aria-busy') ?? null },
      active: document.activeElement === null ? null : document.activeElement.tagName.toLowerCase(),
    };
  }, PALETTE);
}

/**
 * 「記号と演算を探す」を押して開き、その summary を返す(閉じる時も同じ summary を押す)。押した後に開いていなければ、
 * 押す前と後の状態と押している間の記録を添付 math-palette-not-open に出して失敗にする。
 */
export async function openMathPalette(dialog: Locator, info: TestInfo): Promise<Locator> {
  const summary = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  const before = await paletteState(dialog);
  await startPaletteWatch(dialog);
  await summary.click();
  const after = await paletteState(dialog), during = await paletteWatchResult(dialog);
  if (after.open !== true) {
    const body = JSON.stringify({ before, after, during }, null, 2);
    await info.attach('math-palette-not-open', { body, contentType: 'application/json' });
    throw new Error(`「記号と演算を探す」を押しても開かなかった(押し直さずに失敗にする): ${body}`);
  }
  return summary;
}
