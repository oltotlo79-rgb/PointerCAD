import { expect, type JSHandle, type Locator, type Page } from '@playwright/test';

/*
 * ホイールの量の補助(1 か所)。画面の側(Electron の高精細の窓など)は、Playwright が送ったホイールの量を倍にして届ける事がある
 * (この機械の Electron は描画の倍率 2 で、100 を送ると 200 が届いた)。送った量を決め打ちして視点の結果を照らすと、届く量の
 * 違う機械でだけ結果がずれる(2026-11-16、Electron extrude join の framePreviewForCapture)。視点の結果を照らす検査は、
 * ここで届いた量を見て、届いた量から期待を出すか、届いた量の合計が決めた量になるように送る。
 * 規約の検査 packages/test-utils/src/wheelDelivery.test.ts が、ホイールを送って視点を照らす flow がこの補助(か届いた量の記録)を
 * 使う事を確かめる。
 */

/** 届いたホイールの出来事(画面の受け手が見る値)。 */
export interface DeliveredWheel {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly isTrusted: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** 行・頁で届いた量を画素相当へ(製品の cameraControlBindings.ts の 16・100 と同じ)。 */
export function deliveredWheelPixels(event: Pick<DeliveredWheel, 'deltaY' | 'deltaMode'>): number {
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
}

/**
 * target(既定は文書の根の要素)の捕捉の段で、届いたホイールを記録し始める。製品の受け手より先に、値を変えずに見る。
 * 返す物の stop で外す。
 */
export async function observeWheel(page: Page, target?: Locator): Promise<JSHandle<{ events: DeliveredWheel[]; stop: () => void }>> {
  return (target ?? page.locator('html')).evaluateHandle(node => {
    const events: DeliveredWheel[] = [];
    const record = (event: Event) => {
      if (!(event instanceof WheelEvent)) return;
      events.push({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, isTrusted: event.isTrusted,
        ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey });
    };
    node.addEventListener('wheel', record, { capture: true, passive: true });
    return { events, stop: () => node.removeEventListener('wheel', record, { capture: true }) };
  });
}

/**
 * 届いた縦の量(画素相当)の合計が totalDeltaY になるように、ホイールを送る。まず小さく 1 回送って届く倍率を測り、残りを
 * その倍率で割って送る(倍率 1 の機械でも 2 の機械でも、視点は同じだけ動く)。afterEach は 1 回送るごとに呼ぶ(描画を待つ等)。
 * 届いた量を返す(呼び手が記録・添付に使う)。
 */
export async function wheelToDeliveredTotal(page: Page, totalDeltaY: number, afterEach: () => Promise<void> = async () => {},
  probeDeltaY = Math.sign(totalDeltaY) * Math.min(100, Math.abs(totalDeltaY))): Promise<{ readonly requested: readonly number[];
    readonly delivered: readonly number[]; readonly ratio: number }> {
  const observation = await observeWheel(page);
  const requested: number[] = [];
  try {
    const send = async (deltaY: number): Promise<number> => {
      const before = await observation.evaluate(value => value.events.length);
      requested.push(deltaY);
      await page.mouse.wheel(0, deltaY);
      await expect.poll(() => observation.evaluate(value => value.events.length), { message: 'ホイールが届く' }).toBe(before + 1);
      await afterEach();
      const events = await observation.evaluate(value => value.events);
      const last = events[events.length - 1];
      if (last === undefined) throw new Error('届いたホイールが記録されていない');
      return deliveredWheelPixels(last);
    };
    const first = await send(probeDeltaY), ratio = first / probeDeltaY;
    expect(Number.isFinite(ratio) && ratio > 0, `届く倍率が正の数: ${String(ratio)}`).toBe(true);
    const remaining = totalDeltaY - first;
    const delivered = [first];
    if (Math.abs(remaining) >= 0.5) delivered.push(await send(remaining / ratio));
    return { requested, delivered, ratio };
  } finally {
    await observation.evaluate(value => value.stop());
    await observation.dispose();
  }
}
