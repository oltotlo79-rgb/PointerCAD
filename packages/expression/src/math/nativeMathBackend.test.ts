import { describe, expect, it } from 'vitest';
import { NUMERIC_HEAD_ALLOWANCE, nativeMathDeadlineKind } from './nativeMathBackend.js';

/**
 * Every operation head `nativeMathBackend.ts` dispatches to a dedicated, potentially slow numeric
 * routine (Bessel/Gamma/Beta/Zeta/LambertW/elliptic integrals/distributions/Airy/quantiles/…) is
 * listed in `NUMERIC_HEAD_ALLOWANCE`. This is the single table `nativeMathDeadlineKind` reads to grant
 * the 1s ("distribution") or 3s ("elliptic") calculation allowance instead of the 200ms given to an
 * ordinary expression (`createMathBackend.ts`).
 *
 * AiryAi/AiryBi/AiryAiPrime/AiryBiPrime had a dedicated dispatch entry (`AIRY_HEADS`, used to actually
 * compute the value) but were missing from the separate, hand-kept classification list that fed
 * `nativeMathDeadlineKind` — so Airy alone got only 200ms. On a cold calculation Worker (e.g. right
 * after reopening a document) under load this was not always enough, and the CAS computation was
 * cut short with `status:'stopped', reason:'deadline'` (CI run 36346675432, job 108697069543,
 * `math-input.spec.ts` ADD-18 Airyの四種類と原点と入力条件と保存再編集・Undo・F1を通す).
 *
 * This test does not re-declare the set of heads by hand (that hand-kept list was exactly the bug):
 * it walks `NUMERIC_HEAD_ALLOWANCE`, which `nativeMathBackend.ts` builds directly from the same
 * lookup tables (and the small head-name constants) `visit()` dispatches from. A head added only to a
 * dispatch table and never classified can no longer happen silently; a head deliberately left at the
 * ordinary 200ms must carry a `reason` explaining why, which this test enforces is present.
 */
describe('nativeMathDeadlineKindの分類漏れを防ぐ網羅の検査', () => {
  it('登録されたどの頭も、1秒/3秒に分類されているか、理由付きで200msのままと明示されている', () => {
    expect(NUMERIC_HEAD_ALLOWANCE.size).toBeGreaterThan(0);
    for (const [head, entry] of NUMERIC_HEAD_ALLOWANCE) {
      if (entry.kind === 'light') {
        expect(entry.reason, `${head}: 200msのままにする理由が必要`).toBeTruthy();
        expect(nativeMathDeadlineKind(head), head).toBeNull();
      } else {
        expect(nativeMathDeadlineKind(head), head).toBe(entry.kind);
      }
    }
  });
  it('登録されていない通常の演算(Add等)は分類しない', () => {
    for (const head of ['Add', 'Multiply', 'Subtract', 'Divide', 'Power', 'Sin', 'Cos']) {
      expect(NUMERIC_HEAD_ALLOWANCE.has(head), head).toBe(false);
      expect(nativeMathDeadlineKind(head), head).toBeNull();
    }
  });
  it('Airyの4つの頭はBessel等と同じdistributionに分類される(再発防止)', () => {
    for (const head of ['AiryAi', 'AiryBi', 'AiryAiPrime', 'AiryBiPrime']) {
      expect(nativeMathDeadlineKind(head), head).toBe('distribution');
    }
  });
  it('現状light(200msのまま)の頭を一覧できる(実測(2026-09-28)で判断済み)', () => {
    const light = [...NUMERIC_HEAD_ALLOWANCE].filter(([, entry]) => entry.kind === 'light').map(([head]) => head).sort();
    // NormalQuantile/PoissonQuantileは実測でcold/warmの最大が50msを超え(52.069ms/86.100ms)、
    // CIのWindowsの遅さを5倍と見積もっても200msに近づくためdistributionへ変更済み。
    expect(light).toEqual(['BinomialQuantile', 'NormalCdf', 'NormalPdf']);
  });
  it('実測でdistributionへ変更した頭(NormalQuantile/PoissonQuantile)が反映されている', () => {
    expect(nativeMathDeadlineKind('NormalQuantile')).toBe('distribution');
    expect(nativeMathDeadlineKind('PoissonQuantile')).toBe('distribution');
  });
  // 2026-11-16 RUN 20261116-193506(z-math-input ADD-20 特異値分解): 開き直した後の冷えた Worker で
  // tensorelement(svds([[3,0],[4,0]]),[1,1]) の初回が 798ms(pace 1.405)かかり、通常の式の 200ms で止まった。
  it('特異値分解の 3 つの頭(同じ exactSvdDecomposition を使う)は 1 秒の枠に分類される(再発防止)', () => {
    for (const head of ['SvdS', 'SvdU', 'SvdV']) {
      expect(nativeMathDeadlineKind(head), head).toBe('distribution');
      expect(NUMERIC_HEAD_ALLOWANCE.get(head)?.reason, `${head}: 分類の根拠が必要`).toBeTruthy();
    }
  });
  it('特異値分解と同じ計算を使う頭は根拠つきで 1 秒の枠、測った値が通常の枠に入る頭は 200ms のまま', () => {
    for (const head of ['SingularValues', 'Eigenspace']) {
      expect(nativeMathDeadlineKind(head), head).toBe('distribution');
      expect(NUMERIC_HEAD_ALLOWANCE.get(head)?.reason, `${head}: 分類の根拠が必要`).toBeTruthy();
    }
    // 実測(2026-11-16)の最大 38〜103ms は通常の枠(200ms×pace)に入り、落ちた証拠が無いので 1 秒の枠にしない(統括の決定)。
    for (const head of ['QrQ', 'QrR', 'Legendre', 'NextPrime', 'Eigenvalues', 'CharacteristicCoefficients', 'LuP', 'LuL', 'LuU',
      'RowReduce', 'LinearSolve', 'Divisors', 'Sum', 'Product']) {
      expect(nativeMathDeadlineKind(head), head).toBeNull();
    }
  });
});
