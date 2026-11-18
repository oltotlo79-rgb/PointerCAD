/**
 * ボルト締結の窓の「同じ穴を全部足す」(J-02c。統括の決定 2026-11-18 17:0x)。当たりの穴(同じ穴フィーチャーのほかの穴)を全部、
 * 2 組目からの穴として足す。組は予告の自動の対応付け(J-02b)が決め、1 つに決まらない(相手が 0 か 2 つ以上・取り合い・余り)時と、
 * 頭側・相手側の数が合わない時は、足さずに理由と数を返す(当て推量で組を決めない)。文書は変えない(確定は今までどおり 1 回)。
 */
import { boltedJointAllSameHoles, boltedJointHoleHints } from '../assembly/boltedJointHoleHints.js';
import { boltedJointPreviewFor } from './boltedJointActions.js';
import { useAppStore } from './useAppStore.js';

/** 足した・足さなかった理由(当たりが無い・数が合わない・組が 1 つに決まらない・表示が古い)と、足した後の数(頭側・相手側)。 */
export type BoltedJointSameHolesResult =
  | { readonly ok: true; readonly first: number; readonly second: number }
  | { readonly ok: false; readonly reason: 'none' | 'countMismatch' | 'pairing' | 'stale'; readonly first: number; readonly second: number };

export function addAllBoltedJointSameHoles(): BoltedJointSameHolesResult {
  const state = useAppStore.getState();
  const draft = state.assemblyBoltedJointDraft, view = state.assemblyView;
  if (draft === null || state.assembly === null || view === null || view.sourceDocument !== state.assembly) {
    return { ok: false, reason: 'stale', first: 0, second: 0 };
  }
  const all = boltedJointAllSameHoles(draft, boltedJointHoleHints(state.assembly, view, draft));
  if (all === null) return { ok: false, reason: 'none', first: 0, second: 0 };
  const counts = { first: all.first, second: all.second };
  if (all.first !== all.second) return { ok: false, reason: 'countMismatch', ...counts };
  const preview = boltedJointPreviewFor(state, all.draft);
  const unpaired = preview.kind === 'set' && !preview.result.ok
    && preview.result.holes.some((hole) => hole.entryRejections.some((rejection) => rejection.code === 'holePairMissing'));
  if (unpaired) return { ok: false, reason: 'pairing', ...counts };
  useAppStore.setState({ assemblyBoltedJointDraft: all.draft, assemblyBoltedJointPreview: preview });
  return { ok: true, ...counts };
}
