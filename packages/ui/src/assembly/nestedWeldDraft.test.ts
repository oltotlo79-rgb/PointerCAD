import { createAssemblyDocument, EMPTY_PART_LIBRARY, type OccurrenceWeldChoices, type SubShapeRef } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { AssemblyView } from '../store/assemblySlice.js';
import type { JointOccurrencePick } from '../viewport/pickJointOccurrence.js';
import {
  appendNestedWeldPick, createNestedWeldDraft, nestedJointCommandContext, nestedWeldPickKind, previewNestedWeld,
} from './nestedWeldDraft.js';

function ref(kind: 'face' | 'edge', index: number): SubShapeRef {
  return { bodyFeatureId: 'extrude-1', index, fingerprint: kind === 'face'
    ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null }
    : { kind: 'edge', curveKind: 'line', length: 10, position: [5, 0, 0], axis: [1, 0, 0], radius: null } };
}

function pick(path: readonly [string, ...string[]], kind: 'face' | 'edge', index = 0): JointOccurrencePick {
  return { kind: 'jointOccurrence', path, partKey: 'plate-part', ref: ref(kind, index) };
}

const CHOICES: OccurrenceWeldChoices = { legOnSecond: 6, legOnFirst: 6, segments: [{ start: 0, length: 10 }], materialId: 'steel' };

describe('入れ子の葉の部品どうしの溶接の下書き', () => {
  it('面・同じ配置の辺・別の配置の面の順だけを受け、配置は経路の全体で比べる', () => {
    let draft = createNestedWeldDraft('doc');
    expect(nestedWeldPickKind(draft)).toBe('face');
    expect(appendNestedWeldPick(draft, pick(['組,A', 'plate'], 'edge'))).toBeNull();
    draft = appendNestedWeldPick(draft, pick(['組,A', 'plate'], 'face')) ?? draft;
    expect(nestedWeldPickKind(draft)).toBe('edge');
    // 同じ子の組の別の配置の、同じ id の葉の辺は「同じ配置の辺」ではない。
    expect(appendNestedWeldPick(draft, pick(['B', 'plate'], 'edge'))).toBeNull();
    draft = appendNestedWeldPick(draft, pick(['組,A', 'plate'], 'edge')) ?? draft;
    // 3 つ目は別の配置の面だけ。同じ配置の面は断る。
    expect(appendNestedWeldPick(draft, pick(['組,A', 'plate'], 'face', 1))).toBeNull();
    draft = appendNestedWeldPick(draft, pick(['B', 'plate'], 'face')) ?? draft;
    expect(draft.picks.map((item) => item.path)).toEqual([['組,A', 'plate'], ['組,A', 'plate'], ['B', 'plate']]);
    expect(draft.picks.map((item) => item.ref.fingerprint.kind)).toEqual(['face', 'edge', 'face']);
    expect(appendNestedWeldPick(draft, pick(['C', 'plate'], 'face'))).toBeNull();
  });

  it('選び終わるまでは選んだ数を、表示に解いた時の入力が無ければ古いとして、命令を呼ばずに返す', () => {
    const document = createAssemblyDocument('根');
    const view: AssemblyView = { sourceDocument: document, resolved: { parts: new Map(), placements: new Map(), partKeys: new Map(), errors: [] },
      bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
    const context = nestedJointCommandContext(document, EMPTY_PART_LIBRARY, view);
    expect(context).toBeNull();
    let draft = createNestedWeldDraft('doc');
    expect(previewNestedWeld(context, draft, CHOICES)).toEqual({ kind: 'needPicks', count: 0 });
    for (const next of [pick(['A', 'p'], 'face'), pick(['A', 'p'], 'edge'), pick(['B', 'p'], 'face')]) {
      draft = appendNestedWeldPick(draft, next) ?? draft;
    }
    expect(previewNestedWeld(context, draft, CHOICES)).toEqual({ kind: 'stale' });
  });
});
