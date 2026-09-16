import { MAX_SPLINE_POINTS, MIN_CLOSED_SPLINE_POINTS, MIN_SPLINE_POINTS, type CoordinateInput } from '@pointercad/model';

/* ---- P4 タスク11: スプラインの下書き(FR-317、計画書タスク11 の splineDraft) ---- */

/**
 * 置いた点をためておく下書き。
 *
 * スプラインだけは「クリックのたびに点を積み、最後にまとめて 1 本の曲線にする」進行なので、
 * 「1 段 = 1 要素」の `NumericInputState` では表せない。どこへ置くか(ストアの欄)は
 * タスク12 が決め、ここでは形と規則(足せるか・曲線にできるか)だけを純関数で持つ。
 */
export interface SplineDraft {
  /** 置いた順がそのまま曲線の向きになる。 */
  readonly points: readonly CoordinateInput[];
  readonly mode: 'interpolate' | 'control';
  readonly closed: boolean;
}

/** 道具を選んだ直後の下書き(点なし・通過点・開いた曲線)。 */
export const EMPTY_SPLINE_DRAFT: SplineDraft = {
  points: [],
  mode: 'interpolate',
  closed: false,
};

export type SplineDraftOutcome =
  | { readonly ok: true; readonly draft: SplineDraft }
  /** 断った理由。文言は限界値を差し込むのでここで組み立てる(`describeRange` と同じ事情)。 */
  | { readonly ok: false; readonly reason: string };

/** 点を 1 つ置く。上限(model の MAX_SPLINE_POINTS)を超えるときは断って下書きを変えない。 */
export function appendSplinePoint(draft: SplineDraft, point: CoordinateInput): SplineDraftOutcome {
  if (draft.points.length >= MAX_SPLINE_POINTS) {
    return {
      ok: false,
      reason: `スプラインの点は ${String(MAX_SPLINE_POINTS)} 個までです。`,
    };
  }
  return { ok: true, draft: { ...draft, points: [...draft.points, point] } };
}

/** 最後に置いた点を取り消す。点が無ければ同じ下書きをそのまま返す。 */
export function removeLastSplinePoint(draft: SplineDraft): SplineDraft {
  return draft.points.length === 0 ? draft : { ...draft, points: draft.points.slice(0, -1) };
}

export type SplineDraftCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 下書きを 1 本の曲線にできるか(FR-317)。下限・上限は model の `splineMath.ts` と同じ値を
 * 使い、UI 側で数を持たない(開いた曲線は 2 点以上、閉じた曲線は 3 点以上、上限 100 点)。
 */
export function checkSplineDraft(draft: SplineDraft): SplineDraftCheck {
  const count = draft.points.length;
  if (draft.closed && count < MIN_CLOSED_SPLINE_POINTS) {
    return {
      ok: false,
      reason: `閉じたスプラインには点が ${String(MIN_CLOSED_SPLINE_POINTS)} 個以上必要です。`,
    };
  }
  if (!draft.closed && count < MIN_SPLINE_POINTS) {
    return {
      ok: false,
      reason: `スプラインには点が ${String(MIN_SPLINE_POINTS)} 個以上必要です。`,
    };
  }
  if (count > MAX_SPLINE_POINTS) {
    return { ok: false, reason: `スプラインの点は ${String(MAX_SPLINE_POINTS)} 個までです。` };
  }
  return { ok: true };
}
