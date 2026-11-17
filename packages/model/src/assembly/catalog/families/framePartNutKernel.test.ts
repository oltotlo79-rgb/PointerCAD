/**
 * 1 個のナットの形の拡張(主のめねじの位置・ロック付きの止めねじの穴)を、形を作る処理(kernel)で実際に作って確かめる。
 * 今の中央の行・穴が中央でない行・止めねじの穴を開ける行の 3 行を作り、誤りが無い事と、谷の径の円柱の面がどこにあるかを見る。
 * 期待の位置は、行の値(端の面からの位置 − 長さ / 2。原点は長さの中央)から独立に決める。
 */
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDirectKernelBridge } from '../../../kernelBridge.js';
import { recomputePart } from '../../../part/recomputePart.js';
import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import { T_SLOT_NUT_FAMILY } from './framePartCatalog.js';
import { T_SLOT_NUT_RECORDS } from './framePartRows.js';

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);

function minorRadius(thread: string): number {
  const size = findMetricThread(thread);
  if (size === undefined) throw new Error(`呼びが表に無い: ${thread}`);
  return threadMinorDiameter(size.diameter, metricThreadPitch(size, 'coarse')) / 2;
}

/** 行の鍵で、形を作って最後の体の、半径 r の円柱の面の中心の x の並び(小さい順)を返す。 */
async function holeCentersX(key: string, radius: number): Promise<readonly number[]> {
  const row = T_SLOT_NUT_FAMILY.rows.find((candidate) => candidate.key === key);
  const part = row === undefined ? null : T_SLOT_NUT_FAMILY.build(row, {});
  if (part === null) throw new Error(`形が作れない: ${key}`);
  const result = await recomputePart(part, bridge);
  expect(result.errors, key).toEqual([]);
  const last = part.solids.at(-1)?.id;
  const body = result.bodies.find((entry) => entry.featureId === last);
  if (body === undefined) throw new Error(`最後の体が無い: ${key}`);
  return body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - radius) < 1e-6)
    .map((face) => face.centroid[0]).sort((a, b) => a - b);
}

describe('1 個のナットの形の拡張を kernel で作る', () => {
  it('今の中央の行は、主のめねじが長さの中央(x = 0)', async () => {
    const record = T_SLOT_NUT_RECORDS.find((candidate) => candidate.holeOffset === undefined && candidate.setScrewThread === undefined);
    if (record === undefined) throw new Error('中央の行が無い');
    const centers = await holeCentersX(record.key, minorRadius(record.thread));
    expect(centers.length, record.key).toBeGreaterThan(0);
    centers.forEach((x) => expect(Math.abs(x)).toBeLessThanOrEqual(1e-6));
  }, 120_000);

  it('穴が中央でない行は、主のめねじが端の面から holeOffset(x = holeOffset − 長さ / 2)', async () => {
    const record = T_SLOT_NUT_RECORDS.find((candidate) => candidate.holeOffset !== undefined && candidate.setScrewThread === undefined);
    if (record?.holeOffset === undefined) throw new Error('穴が中央でない行が無い');
    const centers = await holeCentersX(record.key, minorRadius(record.thread));
    expect(centers.length, record.key).toBeGreaterThan(0);
    centers.forEach((x) => expect(Math.abs(x - (record.holeOffset ?? NaN) + record.length / 2)).toBeLessThanOrEqual(1e-6));
  }, 120_000);

  it('止めねじの穴を開ける行は、止めねじの谷の径の円柱の面が端の面から setScrewOffset にあり、主のめねじも残る', async () => {
    const record = T_SLOT_NUT_RECORDS.find((candidate) => candidate.setScrewThread !== undefined && candidate.setScrewOffset !== undefined);
    if (record?.setScrewThread === undefined || record.setScrewOffset === undefined) throw new Error('止めねじの行が無い');
    const screw = await holeCentersX(record.key, minorRadius(record.setScrewThread));
    expect(screw.length, record.key).toBeGreaterThan(0);
    screw.forEach((x) => expect(Math.abs(x - (record.setScrewOffset ?? NaN) + record.length / 2)).toBeLessThanOrEqual(1e-6));
    const main = await holeCentersX(record.key, minorRadius(record.thread));
    expect(main.length, record.key).toBeGreaterThan(0);
  }, 120_000);
});
