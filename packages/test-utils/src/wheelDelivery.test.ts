import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * 規約: ホイールを送って視点の結果を照らす画面検査は、届いたホイールの量を見る(2026-11-16、統括の決定 案 2)。
 * この機械の Electron(描画の倍率 2)は、Playwright が送ったホイールの量を倍にして届ける。送った量を決め打ちして視点の結果
 * (枠の中の立体・保存した視点・距離)を照らす flow は、届く量の違う機械でだけ落ちる(Electron extrude join の framePreviewForCapture)。
 * ホイールを送り、視点の結果を読む e2e のファイルは、届いた量を見る仕組み(e2e/tests/wheelDelivery.ts の補助か、ホイールの
 * 出来事の記録)を使う事を、ファイルの文で確かめる。例外の表は持たない。
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const e2e = join(root, 'e2e', 'tests');

/** ホイールを送る呼び出し。 */
const SENDS_WHEEL = /\bmouse\.wheel\(/u;
/** 視点の結果を読む所(枠の中の立体・保存した視点・距離)。 */
const READS_VIEW = /rememberCamera\(|pcadViewportFramedBodies|framedBodies\(|cameraDistance\(/u;
/** 届いた量を見る仕組み(共通の補助・ホイールの出来事の記録・入力の記録)。 */
const OBSERVES_DELIVERY = /from '(?:\.\.?\/)+wheelDelivery\.js'|addEventListener\('wheel'|observeControlsInput\(/u;

/** 規約に合わない時の理由。合う時は null。 */
function wheelDeliveryProblem(text: string): string | null {
  if (!SENDS_WHEEL.test(text) || !READS_VIEW.test(text)) return null;
  return OBSERVES_DELIVERY.test(text) ? null : 'ホイールを送って視点の結果を読むのに、届いたホイールの量を見ていない(wheelDelivery.ts を使う)';
}

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('ホイールの届いた量の規約', () => {
  it('ホイールを送って視点の結果を読む e2e のファイルは、届いた量を見る', () => {
    const problems = listFiles(e2e)
      .filter(path => !path.endsWith(join('tests', 'wheelDelivery.ts')))
      .map(path => ({ file: relative(root, path).replaceAll('\\', '/'), problem: wheelDeliveryProblem(readFileSync(path, 'utf8')) }))
      .filter(row => row.problem !== null);
    expect(problems).toEqual([]);
  });

  it('決め打ちのホイールで視点を照らす書き方を見つけ、届いた量を見る書き方は通す', () => {
    const fixed = "await page.mouse.wheel(0, -300);\nexpect(await framedBodies(page)).toEqual(['union-1']);";
    expect(wheelDeliveryProblem(fixed)).not.toBeNull();
    expect(wheelDeliveryProblem(`import { wheelToDeliveredTotal } from '../wheelDelivery.js';\n${fixed}`)).toBeNull();
    expect(wheelDeliveryProblem("element.addEventListener('wheel', record);\n" + fixed)).toBeNull();
    // 視点の結果を読まないホイール(窓の中の送り・応答の入力)は対象にしない。
    expect(wheelDeliveryProblem('await page.mouse.wheel(0, 360);\nawait expect(article).toBeVisible();')).toBeNull();
  });
});
