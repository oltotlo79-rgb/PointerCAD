import type { BeamAnalysisResult } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { isRecord, isUnknownArray } from '../guards.js';
import { readBeamAnalysisResult, serializeBeamAnalysisResult } from './beamAnalysisResult.js';

/**
 * 片持ち梁(根元 root を固定、長さ 0.5 m の要素 2 つ、先端 tip に +Y の荷重)の結果の形をした手書きの値。
 * この単体が確かめるのは保存の形の読み・確かめ・書き出しなので、解析器は流さない(io は fem に依存しない。
 * 解析器の結果そのものは fem の単体が確かめる)。欄の並びは解析器の結果と同じ(書き出しの決まった並び)。
 */
const actual: BeamAnalysisResult = {
  kind: 'oofem-linear-beam-3d',
  model: 'linear-timoshenko-isotropic',
  analysisId: 'beam-static-1',
  analysisRevision: 3,
  source: { documentId: 'part-document', documentRevision: 7, geometryRevision: 'part-document:12' },
  inputSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  nodes: [
    { nodeId: 'root', solverNode: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0], reactionN: [0, -100, 0],
      reactionNm: [0, 0, -100], constrained: true },
    { nodeId: 'mid', solverNode: 2, displacementM: [0, 0.000125, 0], rotationRad: [0, 0, 0.000375], reactionN: [0, 0, 0],
      reactionNm: [0, 0, 0], constrained: false },
    { nodeId: 'tip', solverNode: 3, displacementM: [0, 0.0004, 0], rotationRad: [0, 0, 0.0005], reactionN: [0, 0, 0],
      reactionNm: [0, 0, 0], constrained: false },
  ],
  elements: [
    { memberId: 'beam-a', componentId: 'beam-part', occurrencePath: ['beam-part'], solverElement: 1, nodeIds: ['root', 'mid'],
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 0.5 }, start: [0, 100, 0, 0, 0, 100], end: [0, -100, 0, 0, 0, -50] },
    { memberId: 'beam-b', componentId: 'beam-part', occurrencePath: ['beam-part'], solverElement: 2, nodeIds: ['mid', 'tip'],
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 0.5 }, start: [0, 100, 0, 0, 0, 50], end: [0, -100, 0, 0, 0, 0] },
  ],
  balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 },
  structuralCertification: false,
};

type Location = readonly (number | string)[];

const records = [
  { at: [], keys: ['kind', 'model', 'analysisId', 'analysisRevision', 'source', 'inputSha256', 'nodes', 'elements', 'balance', 'structuralCertification'] },
  { at: ['source'], keys: ['documentId', 'documentRevision', 'geometryRevision'] },
  { at: ['nodes', 0], keys: ['nodeId', 'solverNode', 'displacementM', 'rotationRad', 'reactionN', 'reactionNm', 'constrained'] },
  { at: ['elements', 0], keys: ['memberId', 'componentId', 'occurrencePath', 'solverElement', 'nodeIds', 'frame', 'start', 'end'] },
  { at: ['elements', 0, 'frame'], keys: ['x', 'y', 'z', 'lengthM'] },
  { at: ['balance'], keys: ['referenceM', 'forceN', 'momentNm', 'maximumFreeResidual'] },
] as const;

const vectors = [
  ['nodes', 0, 'displacementM'], ['nodes', 0, 'rotationRad'], ['nodes', 0, 'reactionN'], ['nodes', 0, 'reactionNm'],
  ['elements', 0, 'frame', 'x'], ['elements', 0, 'frame', 'y'], ['elements', 0, 'frame', 'z'],
  ['elements', 0, 'start'], ['elements', 0, 'end'], ['balance', 'referenceM'], ['balance', 'forceN'], ['balance', 'momentNm'],
] as const;

function pathOf(at: Location): string {
  return at.reduce<string>((path, key) => typeof key === 'number' ? path + '[' + String(key) + ']' : path + '.' + key, 'saved.result');
}

function atPath(value: unknown, at: Location): unknown {
  let current = value;
  for (const key of at) {
    if (typeof key === 'number' && isUnknownArray(current)) current = current[key];
    else if (typeof key === 'string' && isRecord(current)) current = current[key];
    else throw new Error('Missing test fixture field ' + pathOf(at));
  }
  return current;
}

function change(at: Location, key: string | number, edit: 'delete' | 'set', value?: unknown): BeamAnalysisResult {
  const copy = structuredClone(actual);
  const target = atPath(copy, at);
  if (!isRecord(target) && !isUnknownArray(target)) throw new Error('Invalid test fixture path ' + pathOf(at));
  if (edit === 'delete') Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value });
  return copy;
}

function expectProblem(value: unknown, at: Location, reason: 'missing' | 'type' = 'type'): void {
  expect(readBeamAnalysisResult(value, 'saved.result')).toEqual({ ok: false, problem: { path: pathOf(at), reason } });
}

function reverseObjectKeys(value: unknown): void {
  if (isUnknownArray(value)) {
    for (const item of value) reverseObjectKeys(item);
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    for (const [key] of entries) Reflect.deleteProperty(value, key);
    for (const [key, item] of entries.reverse()) {
      reverseObjectKeys(item);
      value[key] = item;
    }
  }
}

describe('static beam result codec', () => {
  it('round-trips the complete native result byte for byte, including the association and balance tables', () => {
    expect(actual.nodes).toHaveLength(3);
    expect(actual.elements).toHaveLength(2);
    expect(actual.nodes.find(node => node.nodeId === 'tip')?.displacementM[1]).toBeGreaterThan(0);
    const original = JSON.stringify(actual);
    const cold: unknown = JSON.parse(original);
    const checked = readBeamAnalysisResult(cold, 'saved.result');
    if (!checked.ok) throw new Error(checked.problem.path);
    expect(JSON.stringify(checked.value)).toBe(original);
    expect(JSON.stringify(serializeBeamAnalysisResult(checked.value))).toBe(original);
  });

  it('writes in the fixed field order even when every input object was constructed in reverse order', () => {
    const reversed = structuredClone(actual);
    reverseObjectKeys(reversed);
    const before = JSON.stringify(reversed);
    expect(before).not.toBe(JSON.stringify(actual));
    const output = serializeBeamAnalysisResult(reversed);
    for (const { at, keys } of records) {
      const row = atPath(output, at);
      if (!isRecord(row)) throw new Error(pathOf(at));
      expect(Object.keys(row)).toEqual(keys);
    }
    expect(JSON.stringify(output)).toBe(JSON.stringify(actual));
    expect(JSON.stringify(reversed)).toBe(before);
    const checked = readBeamAnalysisResult(reversed, '');
    if (!checked.ok) throw new Error(checked.problem.path);
    expect(JSON.stringify(checked.value)).toBe(JSON.stringify(actual));
  });

  it('preserves ordered arrays and owns all nested values on both read and write', () => {
    const reordered = { ...actual, nodes: [...actual.nodes].reverse(), elements: [...actual.elements].reverse() };
    const checked = readBeamAnalysisResult(reordered, '');
    if (!checked.ok) throw new Error(checked.problem.path);
    for (const copy of [checked.value, serializeBeamAnalysisResult(reordered)]) {
      expect(JSON.stringify(copy)).toBe(JSON.stringify(reordered));
      for (const at of [
        ...records.map(row => row.at), ...vectors, ['nodes'], ['elements'], ['elements', 0, 'nodeIds'], ['elements', 0, 'occurrencePath'],
      ]) expect(atPath(copy, at)).not.toBe(atPath(reordered, at));
    }
  });

  for (const { at, keys } of records) {
    it('rejects absent, mistyped and additional fields at ' + pathOf(at), () => {
      for (const key of keys) {
        expectProblem(change(at, key, 'delete'), [...at, key], 'missing');
        expectProblem(change(at, key, 'set', null), [...at, key]);
      }
      for (const key of ['unexpected', '__proto__', 'constructor']) {
        expectProblem(change(at, key, 'set', 123), [...at, key]);
      }
    });
  }

  for (const at of vectors) {
    it('requires the exact length and every finite component at ' + pathOf(at), () => {
      const key = at[at.length - 1], parent = at.slice(0, -1);
      const array = atPath(actual, at);
      if (!isUnknownArray(array)) throw new Error(pathOf(at));
      expectProblem(change(parent, key, 'set', array.slice(1)), at);
      expectProblem(change(parent, key, 'set', [...array, 0]), at);
      for (let index = 0; index < array.length; index++) {
        for (const bad of [NaN, Infinity, -Infinity, null, '1']) expectProblem(change(at, index, 'set', bad), at);
        expectProblem(change(at, index, 'delete'), at);
      }
    });
  }

  it('checks scalar values, literal discriminants, revisions and the actual digest syntax', () => {
    for (const [at, key] of [
      [[], 'analysisRevision'], [['source'], 'documentRevision'], [['nodes', 0], 'solverNode'],
      [['elements', 0], 'solverElement'], [['balance'], 'maximumFreeResidual'], [['elements', 0, 'frame'], 'lengthM'],
    ] as const) {
      for (const bad of [NaN, Infinity, -Infinity, -1]) expectProblem(change(at, key, 'set', bad), [...at, key]);
    }
    for (const [at, key] of [
      [[], 'analysisRevision'], [['source'], 'documentRevision'], [['nodes', 0], 'solverNode'], [['elements', 0], 'solverElement'],
    ] as const) {
      for (const bad of [0.5, Number.MAX_SAFE_INTEGER + 1]) expectProblem(change(at, key, 'set', bad), [...at, key]);
    }
    for (const [at, key] of [
      [['nodes', 0], 'solverNode'], [['elements', 0], 'solverElement'], [['elements', 0, 'frame'], 'lengthM'],
    ] as const) expectProblem(change(at, key, 'set', 0), [...at, key]);
    expectProblem({ ...actual, kind: 'future-beam' }, ['kind']);
    expectProblem({ ...actual, model: 'future-model' }, ['model']);
    expectProblem({ ...actual, structuralCertification: true }, ['structuralCertification']);
    for (const digest of ['a'.repeat(63), 'b'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), actual.inputSha256 + '\n']) {
      expectProblem({ ...actual, inputSha256: digest }, ['inputSha256']);
    }
  });

  it('keeps the input model’s identifier rules and accepts a minimal beam with slash-bearing IDs', () => {
    for (const [at, key] of [
      [[], 'analysisId'], [['source'], 'documentId'], [['source'], 'geometryRevision'],
      [['nodes', 0], 'nodeId'], [['elements', 0], 'memberId'], [['elements', 0], 'componentId'],
    ] as const) {
      for (const id of ['', ' leading', 'trailing ', 'a\nb', 'a'.repeat(257)]) {
        expectProblem(change(at, key, 'set', id), [...at, key]);
      }
    }
    const nodeIds = ['assembly/a', '__proto__'] as const;
    const nodes = nodeIds.map((nodeId, i) => ({ ...actual.nodes[i], nodeId }));
    const componentId = 'nested/tip';
    const element = { ...actual.elements[0], nodeIds, componentId, occurrencePath: [componentId] };
    const minimum = { ...actual, analysisId: 'a'.repeat(256), nodes, elements: [element] };
    const checked = readBeamAnalysisResult(minimum, '');
    if (!checked.ok) throw new Error(checked.problem.path);
    expect(JSON.stringify(serializeBeamAnalysisResult(checked.value))).toBe(JSON.stringify(minimum));
  });

  it('rejects duplicate document IDs and solver numbers in their respective tables', () => {
    for (const key of ['nodeId', 'solverNode'] as const) {
      expectProblem(change(['nodes', 1], key, 'set', actual.nodes[0][key]), ['nodes', 1, key]);
    }
    for (const key of ['memberId', 'solverElement'] as const) {
      expectProblem(change(['elements', 1], key, 'set', actual.elements[0][key]), ['elements', 1, key]);
    }
  });

  it('requires two distinct existing endpoint IDs and preserves explicit occurrence segments', () => {
    const element = actual.elements[0];
    const at = ['elements', 0] as const;
    for (const wrong of [[], [element.nodeIds[0]], [...element.nodeIds, 'third']]) {
      expectProblem(change(at, 'nodeIds', 'set', wrong), [...at, 'nodeIds']);
    }
    for (const index of [0, 1]) {
      for (const bad of ['absent-node', null]) {
        expectProblem(change([...at, 'nodeIds'], index, 'set', bad), [...at, 'nodeIds', index]);
      }
    }
    expectProblem(change([...at, 'nodeIds'], 1, 'set', element.nodeIds[0]), [...at, 'nodeIds', 1]);
    expectProblem(change([...at, 'occurrencePath'], 0, 'set', 1), [...at, 'occurrencePath', 0]);
    expectProblem(change(at, 'occurrencePath', 'set', ['unrelated']), [...at, 'occurrencePath']);
    const opaque = { ...element, occurrencePath: ['nested/instance', element.componentId] };
    const checked = readBeamAnalysisResult({ ...actual, elements: [opaque] }, '');
    if (!checked.ok) throw new Error(checked.problem.path);
    expect(checked.value.elements[0].occurrencePath).toEqual(opaque.occurrencePath);
  });

  it('checks collection sizes before visiting the first row and accepts the inclusive maxima', () => {
    for (const nodes of [[], actual.nodes.slice(0, 1), new Array<unknown>(257)]) expectProblem({ ...actual, nodes }, ['nodes']);
    for (const elements of [[], new Array<unknown>(513)]) expectProblem({ ...actual, elements }, ['elements']);
    for (const items of [[], new Array<unknown>(33)]) {
      expectProblem(change(['elements', 0], 'occurrencePath', 'set', items), ['elements', 0, 'occurrencePath']);
    }
    const nodes = Array.from({ length: 256 }, (_, i) => ({ ...actual.nodes[0], nodeId: 'n' + String(i),
      solverNode: i + 1, constrained: i === 0 }));
    const elements = Array.from({ length: 512 }, (_, i) => {
      const componentId = 'c' + String(i);
      const start = i % (nodes.length - 1);
      return { ...actual.elements[0], memberId: 'm' + String(i), solverElement: i + 1, componentId,
        occurrencePath: [...Array.from({ length: 31 }, (_, part) => String(part)), componentId], nodeIds: [nodes[start].nodeId, nodes[start + 1].nodeId] };
    });
    expect(readBeamAnalysisResult({ ...actual, nodes, elements }, '').ok).toBe(true);
  });

  it('refuses non-records, missing array rows and exceptional non-JSON values without throwing', () => {
    for (const value of [null, undefined, [], false, 0, '']) expectProblem(value, []);
    expectProblem(change(['nodes'], 0, 'delete'), ['nodes', 0]);
    expectProblem(change(['elements'], 0, 'delete'), ['elements', 0]);
    const getter = structuredClone(actual);
    Object.defineProperty(getter, 'balance', { get() { throw new Error('unreadable'); } });
    expectProblem(getter, []);
    expect(readBeamAnalysisResult({}, '')).toEqual({ ok: false, problem: { path: 'kind', reason: 'missing' } });
  });
});
