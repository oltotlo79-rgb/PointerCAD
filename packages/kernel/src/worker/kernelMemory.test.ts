/**
 * 形状計算部のメモリの量(NFR-PF-6「WASM の実質上限(〜4GB)内で動作。上限接近時に警告する」、
 * 計画書 P12-28)。
 *
 * 読み方と返信への足し方は模擬の値(3GB を実際には確保しない)で確かめ、実物の計算部でも
 * 返信に量が付くこと・取り消した計算でも付くこと・同じ計算を繰り返しても確保量が増えないことを
 * 確かめる。上限の値は同梱のグルーコードと照合し、同梱物の差し替えで食い違えば落とす。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type {
  CurveSpec,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  SolidStepRequest,
} from '../types.js';
import { createKernelApi } from './kernelApi.js';
import { OCCT_HEAP_LIMIT_BYTES, readKernelMemory, withKernelMemory } from './kernelMemory.js';

const GIB = 1024 ** 3;

/** WebAssembly のメモリの 1 ページ(64KiB)。確保量は必ずこの倍数になる。 */
const WASM_PAGE_BYTES = 65_536;

/** 計算部の実体の代わり。`HEAPU8.buffer.byteLength` だけを持つ。 */
function fakeInstance(byteLength: unknown): object {
  return { HEAPU8: { buffer: { byteLength } } };
}

/** XY 平面の 40×30 の長方形。 */
const RECTANGLE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];

/** 長方形を Z へ distance だけ押し出す 1 段。鍵は検査ごとに変える。 */
function extrude(key: string, distance: number): SolidStepRequest {
  return {
    key,
    id: 'extrude-1',
    label: 'extrude-1',
    visible: true,
    step: { kind: 'extrude', profile: RECTANGLE, direction: [0, 0, 1], distance },
  };
}

function request(partId: string, generation: number, distance: number): SolidRecomputeRequest {
  return { partId, generation, steps: [extrude(`${partId}:extrude`, distance)] };
}

const EMPTY_RESULT: SolidRecomputeResult = {
  bodies: [],
  failures: [],
  cacheHits: 0,
  cancelled: false,
  appearanceMatches: [],
};

describe('形状計算部のメモリの量を読む(模擬の値)', () => {
  it('確保済みのバイト数と上限を読む(上限近くの 3.5GB を模擬)', () => {
    expect(readKernelMemory(fakeInstance(3.5 * GIB))).toEqual({
      wasmHeapBytes: 3.5 * GIB,
      wasmHeapLimitBytes: OCCT_HEAP_LIMIT_BYTES,
    });
  });

  it('読めない・おかしい値は量なし(undefined)にして、警告の材料にしない', () => {
    const unreadable: readonly object[] = [
      {},
      { HEAPU8: null },
      { HEAPU8: {} },
      { HEAPU8: { buffer: null } },
      { HEAPU8: { buffer: {} } },
      fakeInstance('1073741824'),
      fakeInstance(0),
      fakeInstance(-WASM_PAGE_BYTES),
      fakeInstance(Number.NaN),
      fakeInstance(1.5),
      fakeInstance(Number.POSITIVE_INFINITY),
    ];
    for (const instance of unreadable) {
      expect(readKernelMemory(instance), JSON.stringify(instance)).toBeUndefined();
    }
  });

  it('返信へは足すだけで既存の欄を変えない。読めなければ同じ物をそのまま返す', () => {
    const bytes = 512 * 1024 * 1024;
    expect(withKernelMemory(EMPTY_RESULT, fakeInstance(bytes))).toEqual({
      ...EMPTY_RESULT,
      memory: { wasmHeapBytes: bytes, wasmHeapLimitBytes: OCCT_HEAP_LIMIT_BYTES },
    });
    expect(withKernelMemory(EMPTY_RESULT, {})).toBe(EMPTY_RESULT);
  });

  it('上限は同梱の計算部のグルーコードの getHeapMax と同じ(4GiB から 1 ページ引いた値)', () => {
    const gluePath = createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.full.js');
    const glue = readFileSync(gluePath, 'utf8');
    const found = /function getHeapMax\(\)\{return (\d+)\}/u.exec(glue);
    expect(found?.[1]).toBe(String(OCCT_HEAP_LIMIT_BYTES));
    expect(OCCT_HEAP_LIMIT_BYTES).toBe(4 * GIB - WASM_PAGE_BYTES);
  });
});

describe('再計算の返信に実物の計算部のメモリの量が付く(NFR-PF-6)', () => {
  it('計算ごとの返信に確保量と上限が付き、既存の欄はそのまま返る', async () => {
    const api = createKernelApi(loadOcctForNode);
    try {
      const result = await api.recomputeSolids(request('memory:plain', 1, 10));
      expect(result.cancelled).toBe(false);
      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expect(result.cacheHits).toBe(0);
      expect(result.appearanceMatches).toEqual([]);
      expect(result.memory?.wasmHeapLimitBytes).toBe(OCCT_HEAP_LIMIT_BYTES);
      const bytes = result.memory?.wasmHeapBytes ?? 0;
      expect(bytes).toBeGreaterThan(0);
      expect(bytes % WASM_PAGE_BYTES).toBe(0);
      expect(bytes).toBeLessThanOrEqual(OCCT_HEAP_LIMIT_BYTES);
      // 返信の値は、計算を終えた時点の計算部そのものの確保量と一致する。
      expect(readKernelMemory(await loadOcctForNode())?.wasmHeapBytes).toBe(bytes);
    } finally {
      await api.releasePart('memory:plain');
    }
  });

  it('取り消した計算の返信にも付く(既存の中止の口のまま。形は返さない)', async () => {
    const api = createKernelApi(loadOcctForNode);
    try {
      const result = await api.recomputeSolids(
        request('memory:cancel', 1, 10),
        {},
        undefined,
        () => true,
      );
      expect(result.cancelled).toBe(true);
      expect(result.bodies).toEqual([]);
      expect(result.memory?.wasmHeapLimitBytes).toBe(OCCT_HEAP_LIMIT_BYTES);
      expect(result.memory?.wasmHeapBytes ?? 0).toBeGreaterThan(0);
    } finally {
      await api.releasePart('memory:cancel');
    }
  });

  it('同じ計算を繰り返しても確保量は増えない(覚えた形を使い回す)', async () => {
    const api = createKernelApi(loadOcctForNode);
    try {
      const first = await api.recomputeSolids(request('memory:repeat', 1, 12));
      const firstBytes = first.memory?.wasmHeapBytes;
      expect(firstBytes).toBeDefined();
      const readings: (number | undefined)[] = [];
      for (let round = 0; round < 5; round += 1) {
        const again = await api.recomputeSolids(request('memory:repeat', round + 2, 12));
        expect(again.cacheHits).toBe(1);
        expect(again.bodies).toHaveLength(1);
        readings.push(again.memory?.wasmHeapBytes);
      }
      expect(readings).toEqual(Array.from({ length: 5 }, () => firstBytes));
    } finally {
      await api.releasePart('memory:repeat');
    }
  });
});
