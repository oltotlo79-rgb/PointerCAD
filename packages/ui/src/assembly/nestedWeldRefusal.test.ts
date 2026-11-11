import type { OccurrenceWeldPreview, SubShapeRef } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { filletWeldStatus } from '../shell/statusText.js';
import { createFilletWeldDraft } from './filletWeldDraft.js';
import { appendNestedWeldPick, createNestedWeldDraft, nestedWeldDisplayPreview, type NestedWeldDraft } from './nestedWeldDraft.js';

function ref(kind: 'face' | 'edge'): SubShapeRef {
  return { bodyFeatureId: 'extrude-1', index: 0, fingerprint: kind === 'face'
    ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null }
    : { kind: 'edge', curveKind: 'line', length: 10, position: [5, 0, 0], axis: [1, 0, 0], radius: null } };
}

function threePicks(): NestedWeldDraft {
  let draft = createNestedWeldDraft('doc');
  for (const pick of [{ path: ['組,A', 'plate'] as const, ref: ref('face') }, { path: ['組,A', 'plate'] as const, ref: ref('edge') },
    { path: ['root-plate'] as const, ref: ref('face') }]) {
    draft = appendNestedWeldPick(draft, pick) ?? draft;
  }
  return draft;
}

const WELD = { ...createFilletWeldDraft('doc'), legOnSecondSource: '6', legOnFirstSource: '6', materialId: 'steel' };

describe('入れ子の溶接の命令の断りを、本当の理由の日本語で見せる', () => {
  it('持ち主の合致・ジョイントによる断りは「形が古い」ではなく、その理由を窓と状態欄が読む課題に写す', () => {
    const refused: OccurrenceWeldPreview = { ok: false, reason: 'owner-constrained', rejections: [] };
    const draft = threePicks();
    const shown = nestedWeldDisplayPreview({ kind: 'plan', result: refused }, draft, WELD);
    expect(shown).toEqual({ kind: 'issue', issue: { kind: 'occurrence', reason: 'owner-constrained' } });
    expect(filletWeldStatus(WELD, shown, draft)).toEqual({ failed: true,
      text: 'すみ肉溶接: 一番上の部品が合致・ジョイントで動きを決められているため、この溶接はまだ置けません。' });
  });

  it.each([
    ['same-owner-unsupported', 'すみ肉溶接: 同じサブアセンブリの中の部品どうしの溶接にはまだ対応していません。'],
    ['owner-pose-not-stored', 'すみ肉溶接: 一番上の部品の、合致で解いた位置と保存した位置が違うため溶接できません。合致を見直してください。'],
    ['preview-changed', 'すみ肉溶接: 予告の後に部品の内容か位置が変わりました。選び直してください。'],
  ] as const)('%s は専用の文で出る', (reason, text) => {
    const draft = threePicks();
    const shown = nestedWeldDisplayPreview({ kind: 'plan', result: { ok: false, reason, rejections: [] } }, draft, WELD);
    expect(filletWeldStatus(WELD, shown, draft)).toEqual({ failed: true, text });
  });

});
