import { createKernelApi, type CurveSpec, type SheetMetalRecognitionRequest, type SolidStepRequest } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { describe, expect, it, vi } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { askSheetRecognition, unavailableSheetReplies, type SheetRecognitionRequestItem } from './sheetRecognition.js';

const plane: SubShapeRef = { bodyFeatureId: 'plate', index: 4,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1500, position: [25, 15, 2], axis: [0, 0, 1], radius: null } };
const edge: SubShapeRef = { bodyFeatureId: 'plate', index: 1,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 50, position: [25, 0, 0], axis: [1, 0, 0], radius: null } };
const item = (id: string, face: SubShapeRef): SheetRecognitionRequestItem => ({ id, bodyKey: `key-${id}`, face });

describe('M-08 板金の認識の照会の詰め替え', () => {
  it('依頼の順に答え、鍵の形が無い 1 件は missingBody、面でない参照は頼まずに ambiguousPair にする', async () => {
    const asked: SheetMetalRecognitionRequest[] = [];
    const replies = await askSheetRecognition([item('a', plane), item('e', edge), item('b', plane)], (request) => {
      asked.push(request);
      return Promise.resolve({ results: [{ id: 'a', recognition: { ok: false, reason: 'variableThickness' } }],
        failures: [{ id: 'b', code: 'missingBody' }] });
    });
    expect(asked).toEqual([{ items: [
      { id: 'a', shapeKey: 'key-a', face: { kind: 'face', index: 4, surfaceKind: 'plane', area: 1500, position: [25, 15, 2], axis: [0, 0, 1], radius: null } },
      { id: 'b', shapeKey: 'key-b', face: { kind: 'face', index: 4, surfaceKind: 'plane', area: 1500, position: [25, 15, 2], axis: [0, 0, 1], radius: null } },
    ] }]);
    expect(replies).toEqual([
      { id: 'a', kind: 'recognized', recognition: { ok: false, reason: 'variableThickness' } },
      { id: 'e', kind: 'recognized', recognition: { ok: false, reason: 'ambiguousPair' } },
      { id: 'b', kind: 'unavailable', code: 'missingBody' },
    ]);
  });

  it('呼び出しが投げたら全件 rpcFailed、答えの無い 1 件も rpcFailed、頼む面が無ければ呼ばない', async () => {
    const thrown = await askSheetRecognition([item('a', plane), item('e', edge)], () => Promise.reject(new Error('rpc')));
    expect(thrown).toEqual(unavailableSheetReplies([item('a', plane), item('e', edge)], 'rpcFailed'));
    expect(thrown.map(reply => reply.kind)).toEqual(['unavailable', 'unavailable']);
    const silent = await askSheetRecognition([item('a', plane)], () => Promise.resolve({ results: [], failures: [] }));
    expect(silent).toEqual([{ id: 'a', kind: 'unavailable', code: 'rpcFailed' }]);
    const call = vi.fn(() => Promise.resolve({ results: [], failures: [] }));
    expect(await askSheetRecognition([item('e', edge)], call)).toEqual([
      { id: 'e', kind: 'recognized', recognition: { ok: false, reason: 'ambiguousPair' } }]);
    expect(await askSheetRecognition([], call)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it('直の橋の口から、計算部の窓口が覚えた L 板を基準の面の参照で読む', async () => {
    const api = createKernelApi(loadOcctForNode);
    const profile: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [50, 0, 0] }, { kind: 'segment', from: [50, 0, 0], to: [50, 30, 0] },
      { kind: 'segment', from: [50, 30, 0], to: [0, 30, 0] }, { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
    ];
    const base: SolidStepRequest = { id: 'base', key: 'bridge-recognize-base', label: '基板', visible: false,
      step: { kind: 'sheetBase', outer: profile, holes: [], thickness: 2, reversed: false } };
    const flange: SolidStepRequest = { id: 'plate', key: 'bridge-recognize-plate', label: 'フランジ', visible: true,
      step: { kind: 'sheetFlange', targetKey: base.key, flanges: [{ kind: 'rectangle', thickness: 2, radius: 3, width: 50, secondLength: 20,
        angle: 90, frame: { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } }] } };
    const built = await api.recomputeSolids({ partId: 'bridge-recognize', generation: 1, steps: [base, flange] });
    expect(built.failures).toEqual([]);
    const body = built.bodies.find(entry => entry.id === 'plate');
    const face = body?.faces.filter(entry => entry.surfaceKind === 'plane').reduce((best, entry) => entry.area > best.area ? entry : best);
    if (face === undefined) throw new Error('L 板の平らな面がありません');
    const reference: SubShapeRef = { bodyFeatureId: 'plate', index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind,
      area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } };
    const bridge = createDirectKernelBridge(api);
    const [reply] = await bridge.recognizeSheetMetal?.([{ id: 'convert', bodyKey: flange.key, face: reference }]) ?? [];
    if (reply?.kind !== 'recognized' || !reply.recognition.ok) throw new Error('L 板を読めませんでした');
    expect(reply.recognition.thickness).toBeCloseTo(2, 9);
    expect(reply.recognition.panels.map(panel => panel.faceIndex)[0]).toBe(face.index);
    expect(reply.recognition.bends.map(bend => bend.radius)).toHaveLength(1);
    expect(reply.recognition.bends[0].radius).toBeCloseTo(3, 9);
  }, 180_000);
});
