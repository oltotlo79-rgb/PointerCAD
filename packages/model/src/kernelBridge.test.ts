/**
 * Worker 版の橋(`createKernelBridge`)が、**Worker が黙ったまま壊れたとき**に
 * 待っている呼び出しを必ず終わらせることの検査(§2.9、§0.a-0.19、FR-504、NFR-RE-1)。
 *
 * これまで壊れた合図と競っていたのは `recomputeSolids` だけで、面の三角形分割・
 * オフセット・投影・断面・測定の 5 つは Worker が黙るとアプリが無言で固まった
 * (`docs/報告記録.md` 2026-09-06 12:04 の③)。ここでは 6 つすべてについて
 * 「応答が返らないまま壊れた合図が鳴ったら、拒否ではなく**断りの値**で解決する」を固定する。
 *
 * **実物の Worker も OCCT も起こさない。** `createKernelWorker` だけを、依頼を受け取っても
 * 何も返さない偽物へ差し替える(応答待ちの Promise が永遠に解決しない状態の再現)。
 * 壊れは `worker.addEventListener('error', …)` に届く 'error' の出来事で起こす
 * (`createKernelConnection` が実際に見張っているのがこの 2 つの出来事)。
 * 偽物で差し替える流儀は `measure/measureBridge.test.ts` の偽の `KernelApi` と同じ。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createKernelBridge,
  KERNEL_BROKEN_MESSAGE,
  toPrintabilityOutcome,
  type SketchOffsetRequestItem,
  type SketchProjectionRequestItem,
} from './kernelBridge.js';
import type { ResolvedSolidStep } from './part/resolvePart.js';
import { WORK_PLANES } from './sketch/planeMath.js';
import type { ResolvedFace } from './sketch/types.js';

const silentWorkers = vi.hoisted(() => {
  /**
   * 依頼を受け取っても何も返さない偽の Worker。Comlink はここへ依頼を投げるので、
   * 応答待ちの Promise は永遠に解決も拒否もしない(OCCT が abort() した後と同じ)。
   * `EventTarget` を継承しているので、検査から 'error' を出して壊れを起こせる。
   */
  class SilentWorker extends EventTarget {
    postMessage(): void {
      // 何も返さないことがこの偽物の役目。
    }

    terminate(): void {
      // 持ち物が無いので閉じるものは無い。
    }
  }

  const created: SilentWorker[] = [];
  return {
    create(): SilentWorker {
      const worker = new SilentWorker();
      created.push(worker);
      return worker;
    },
    /** いま使われている(最後に作られた)Worker が壊れたことにする。 */
    breakCurrent(): void {
      const worker = created[created.length - 1];
      if (worker === undefined) {
        throw new Error('偽の Worker がまだ 1 つも作られていません。');
      }
      worker.dispatchEvent(new Event('error'));
    },
    clear(): void {
      created.length = 0;
    },
  };
});

vi.mock('@pointercad/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pointercad/kernel')>();
  // 差し替えるのは Worker の起動だけ。詰め替えの純関数(matchFace 等)は本物のまま使う。
  return { ...actual, createKernelWorker: () => silentWorkers.create() };
});

/** 面 1 枚。カーネルへは渡らない(黙ったまま壊れる)ので、型を満たすだけの値。 */
const FACE: ResolvedFace = {
  featureId: 'face-1',
  color: '#8899aa',
  curves: [
    { kind: 'segment', featureId: 'segment-1', from: [0, 0, 0], to: [10, 0, 0] },
    { kind: 'segment', featureId: 'segment-2', from: [10, 0, 0], to: [10, 10, 0] },
    { kind: 'segment', featureId: 'segment-3', from: [10, 10, 0], to: [0, 0, 0] },
  ],
};

const OFFSET_REQUEST: SketchOffsetRequestItem = {
  featureId: 'offset-1',
  curves: [{ kind: 'segment', featureId: 'segment-1', from: [0, 0, 0], to: [10, 0, 0] }],
  distance: 2,
  corner: 'round',
};

const PROJECTION_REQUEST: SketchProjectionRequestItem = {
  featureId: 'projection-1',
  bodyKey: 'key-1',
  source: null,
  plane: WORK_PLANES.xy,
};

/** 基本形状(球)の段 1 つ(`measure/measureBridge.test.ts` の `fakeStep` と同じ作り)。 */
function fakeStep(featureId: string, key: string): ResolvedSolidStep {
  return {
    featureId,
    name: featureId,
    key,
    visible: true,
    plan: {
      kind: 'primitive',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      shape: { kind: 'sphere', radius: 10 },
      originQuery: null,
      targetKey: null,
    },
  };
}

describe('createKernelBridge: Worker が黙ったまま壊れたとき(§2.9)', () => {
  beforeEach(() => {
    silentWorkers.clear();
  });

  it('tessellateSketchFaces は頼んだ面ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.tessellateSketchFaces([FACE]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      mesh: { faces: [] },
      failures: [{ featureId: 'face-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('recomputeSolids は画面に出る段ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.recomputeSolids([fakeStep('body-1', 'key-1')]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      bodies: [],
      failures: [{ featureId: 'body-1', message: KERNEL_BROKEN_MESSAGE }],
      cacheHits: 0,
      cancelled: false,
      appearanceMatches: [],
    });
    bridge.dispose();
  });

  it('offsetSketchCurves は頼んだ件ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.offsetSketchCurves([OFFSET_REQUEST]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      results: [],
      failures: [{ featureId: 'offset-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('projectSketchCurves は頼んだ件ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.projectSketchCurves([PROJECTION_REQUEST]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      results: [],
      failures: [{ featureId: 'projection-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('sectionSketchCurves は頼んだ件ぶんの断りで解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.sectionSketchCurves([PROJECTION_REQUEST]);
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      results: [],
      failures: [{ featureId: 'projection-1', message: KERNEL_BROKEN_MESSAGE }],
    });
    bridge.dispose();
  });

  it('measure は「測れなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.measure(
      [fakeStep('body-1', 'key-1')],
      [{ bodyFeatureId: 'body-1', subShape: null }],
      'massProperties',
    );
    silentWorkers.breakCurrent();

    // 測定の結果には「壊れた」を表す種類が無いので、呼び手が既に扱っている
    // `kind: 'failed'` で断る(理由の文はそのまま画面へ出る)。
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });

  it('exportShapes は「書き出せなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.exportShapes([fakeStep('body-1', 'key-1')], {
      format: 'step',
      bodies: [{ featureId: 'body-1', name: '球1', color: null }],
      meshQuality: null,
      withColors: true,
      ascii: false,
      baseName: 'model',
    });
    silentWorkers.breakCurrent();

    // 書き出しにも「壊れた」の種類は無いので、測定と同じ `kind: 'failed'` で断る。
    // ここで拒否(throw)にすると、書き出しのパネルが理由の出ないまま固まる。
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });

  it('inspectPrintability は「点検できなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.inspectPrintability([fakeStep('body-1', 'key-1')], {
      bodies: ['body-1'],
    });
    silentWorkers.breakCurrent();

    // 点検にも「壊れた」の種類は無いので、測定・書き出しと同じ `kind: 'failed'` で断る。
    // ここで拒否(throw)にすると、点検を押した画面が理由の出ないまま固まる(§0.a-0.19)。
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });

  it('importShape は「読み込めなかった」(kind: failed)で解決する', async () => {
    const bridge = createKernelBridge();
    const pending = bridge.importShape({
      format: 'step',
      fileName: 'box.step',
      bytes: new Uint8Array([1, 2, 3]),
    });
    silentWorkers.breakCurrent();

    await expect(pending).resolves.toEqual({
      kind: 'failed',
      message: KERNEL_BROKEN_MESSAGE,
    });
    bridge.dispose();
  });
});

describe('点検結果の表示メッシュ同一性', () => {
  it('bodyKey・meshRevision・triangleCount を model の結果へそのまま写す', () => {
    const outcome = toPrintabilityOutcome({
      triangleCount: 1,
      thinTriangles: new Uint8Array([0]),
      overhangTriangles: new Uint8Array([0]),
      openEdgeTriangles: new Uint8Array([0]),
      meshes: [{ bodyKey: 'key-1', meshRevision: 7, triangleCount: 1 }],
      summary: {
        triangleCount: 1,
        degenerateCount: 0,
        inspectedTriangleCount: 1,
        thinCount: 0,
        overhangCount: 0,
        openEdgeCount: 0,
        openEdgeTriangleCount: 0,
        watertight: true,
        minThicknessFoundMm: 10,
        minThicknessMm: 0.8,
        overhangAngleDeg: 45,
        cellSizeMm: 1.6,
      },
      cancelled: false,
    });

    expect(outcome.kind).toBe('inspected');
    if (outcome.kind !== 'inspected') {
      return;
    }
    expect(outcome.report.meshes).toEqual([
      { bodyKey: 'key-1', meshRevision: 7, triangleCount: 1 },
    ]);
  });
});
