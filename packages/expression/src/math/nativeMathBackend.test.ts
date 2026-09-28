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
  it('現状light(200msのまま)の頭を一覧できる(実測(w87a 2026-09-28)で判断済み)', () => {
    const light = [...NUMERIC_HEAD_ALLOWANCE].filter(([, entry]) => entry.kind === 'light').map(([head]) => head).sort();
    // NormalQuantile/PoissonQuantileは実測でcold/warmの最大が50msを超え(52.069ms/86.100ms)、
    // CIのWindowsの遅さを5倍と見積もっても200msに近づくためdistributionへ変更済み。
    expect(light).toEqual(['BinomialQuantile', 'NormalCdf', 'NormalPdf']);
  });
  it('実測でdistributionへ変更した頭(NormalQuantile/PoissonQuantile)が反映されている', () => {
    expect(nativeMathDeadlineKind('NormalQuantile')).toBe('distribution');
    expect(nativeMathDeadlineKind('PoissonQuantile')).toBe('distribution');
  });
});
