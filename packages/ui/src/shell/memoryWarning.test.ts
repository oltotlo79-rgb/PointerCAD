/**
 * 形状計算部のメモリが上限に近いときの帯の警告(NFR-PF-6「WASM の実質上限(〜4GB)内で動作。
 * 上限接近時に警告する」、計画書 P12-28)。
 *
 * 上限近くの量を実際に確保するのは難しいので、量は模擬の値で渡す(実物の計算部が返信に量を
 * 添えることは kernel の `kernelMemory.test.ts` が確かめる)。ここでは、上限の前後で出る・
 * 出ないこと、既存の中止の口がそのまま使えること、繰り返した後に量が下がれば(開き直した後の
 * 計算)消えることを、純関数とストアの両方で確かめる。描画(`StatusBar.tsx`)は E2E と目視に任せる。
 */
import {
  absoluteCoordinate,
  addComponent,
  appendFeature,
  createAssemblyDocument,
  createComponentFor,
  createEmptyPartDocument,
  createPointFeature,
  createStandardPartSource,
  type AssemblyKernelBridge,
  type SketchDocument,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachAssembly } from '../assembly/attachAssembly.js';
import { t } from '../i18n/t.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import type { KernelMemoryState } from '../store/recomputeSlice.js';
import {
  createFakeRecompute,
  documentWithPoint,
  resetTestStore,
  resultFor,
  tick,
} from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  describeStatus,
  isKernelMemoryNearLimit,
  kernelMemoryWarningText,
  MEMORY_WARNING_RATIO,
  type StatusInput,
  type StatusLine,
} from './statusText.js';

/** 同梱の計算部の上限(kernel の `OCCT_HEAP_LIMIT_BYTES`。4GiB から 64KiB を引いた値)。 */
const LIMIT = 4_294_901_760;
const GIB = 1024 ** 3;
/** WebAssembly のメモリの 1 ページ。確保量はこの単位で増える。 */
const PAGE = 65_536;

function memory(usedBytes: number): KernelMemoryState {
  return { usedBytes, limitBytes: LIMIT };
}

/** 上限の 4 分の 3 を 1 ページだけ超えた量(警告が出る最初のページ)。 */
const JUST_OVER = Math.ceil((LIMIT * MEMORY_WARNING_RATIO) / PAGE) * PAGE;

/** 3.5GB の警告の 1 文(利用者が帯で読む全文)。 */
const WARNING_AT_3_5_GB =
  '形の計算に使うメモリが上限に近づいています(3.5 GB / 上限 4.0 GB)。作業を保存し、画面を開き直してください。' +
  '開き直すとメモリが空きます。';

/** 何も起きていない状態(statusText.test.ts の quiet と同じ既定)。 */
function quiet(): StatusInput {
  return {
    fileMessage: null,
    faceErrorKey: null,
    solidErrorKey: null,
    errorMessage: null,
    partErrors: [],
    sketchErrors: [],
    cancelled: false,
    progress: null,
    isComputing: false,
    kernelLoaded: true,
    snapKind: null,
    activeTool: 'select',
    selectedBodyCount: 0,
    selectedSubShapeCount: 0,
    selectionKind: 'body',
    springOriginSelected: false,
    springStep: null,
  };
}

/** ストアの今の値から、帯の 1 文を `StatusBar.tsx` と同じ欄で組み立てる。 */
function lineFromStore(): StatusLine {
  const state = useAppStore.getState();
  return describeStatus({
    ...quiet(),
    fileMessage: state.fileMessage,
    errorMessage: state.errorMessage,
    partErrors: state.partErrors,
    sketchErrors: state.sketchErrors,
    cancelled: state.recomputeCancelled,
    progress: state.recomputeProgress,
    isComputing: state.isComputing,
    kernelLoaded: state.kernelLoaded,
    kernelMemory: state.kernelMemory,
  });
}

/** 前の文書に点を 1 つ足した次の文書(文書が変わるたびに再計算が予約される)。 */
function nextSketch(previous: SketchDocument, x: number): SketchDocument {
  return appendFeature(previous, createPointFeature(previous, absoluteCoordinate(x, 0, 0)));
}

/** アセンブリの部品ごとの再計算に使う偽の橋。ソリッドの結果にメモリの量を添えて返す。 */
function assemblyBridge(kernelMemory: KernelMemoryState): AssemblyKernelBridge {
  return {
    releasePart: () => Promise.resolve(),
    checkShapeAvailability: (partId) => Promise.resolve({ partId, missingKeys: [] }),
    recomputeSolids: () =>
      Promise.resolve({ bodies: [], failures: [], cacheHits: 0, cancelled: false, kernelMemory }),
    tessellateSketchFaces: () => Promise.resolve({ mesh: { faces: [] }, failures: [] }),
    offsetSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    projectSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    sectionSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    measure: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    exportShapes: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    importShape: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    inspectPrintability: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    dispose: () => undefined,
  };
}

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({
    kernelMemory: null,
    requestedGeneration: 0,
    completedGeneration: 0,
    lastOutcome: 'idle',
  });
});

afterEach(() => {
  // 量は文書を作り直しても残る欄なので、次の検査へ持ち越さない。
  useAppStore.setState({ kernelMemory: null });
});

describe('上限の前後(模擬の量)', () => {
  it('割合の定数は 1 か所で 4 分の 3。ちょうどでは出さず、1 ページ超えたら出す', () => {
    expect(MEMORY_WARNING_RATIO).toBe(0.75);
    expect(isKernelMemoryNearLimit(memory(LIMIT * MEMORY_WARNING_RATIO))).toBe(false);
    expect(isKernelMemoryNearLimit(memory(JUST_OVER - PAGE))).toBe(false);
    expect(isKernelMemoryNearLimit(memory(JUST_OVER))).toBe(true);
    expect(isKernelMemoryNearLimit(memory(LIMIT))).toBe(true);
  });

  it('上限に遠いときは帯を変えない(ふだんの画面のまま)', () => {
    const plain = describeStatus(quiet());
    for (const used of [100 * 1024 * 1024, 1 * GIB, JUST_OVER - PAGE]) {
      expect(describeStatus({ ...quiet(), kernelMemory: memory(used) })).toEqual(plain);
    }
    expect(plain.kind).toBe('guide');
    expect(plain.text).toBe(t('statusBar.ready'));
  });

  it('上限に近いときは理由(量と上限)と対処(保存して開き直す)を赤い帯の 1 文で出す', () => {
    const line = describeStatus({ ...quiet(), kernelMemory: memory(3.5 * GIB) });
    expect(line.kind).toBe('failure');
    expect(line.text).toBe(WARNING_AT_3_5_GB);
    expect(line.text.startsWith(t('statusBar.memoryNearLimit'))).toBe(true);
    expect(line.text).not.toMatch(/[{}]/u);
    expect(kernelMemoryWarningText(memory(JUST_OVER))).toBe(
      '形の計算に使うメモリが上限に近づいています(3.0 GB / 上限 4.0 GB)。作業を保存し、画面を開き直してください。' +
        '開き直すとメモリが空きます。',
    );
  });

  it('量がまだ届いていない・おかしいときは出さない', () => {
    const odd: readonly (KernelMemoryState | null | undefined)[] = [
      null,
      undefined,
      memory(Number.NaN),
      memory(-GIB),
      memory(Number.POSITIVE_INFINITY),
      { usedBytes: 3.5 * GIB, limitBytes: 0 },
      { usedBytes: 3.5 * GIB, limitBytes: Number.NaN },
    ];
    for (const value of odd) {
      expect(isKernelMemoryNearLimit(value), String(value?.usedBytes)).toBe(false);
      expect(kernelMemoryWarningText(value)).toBeNull();
    }
  });
});

describe('既存の中止の口と、ほかの知らせとの順番', () => {
  it('進み具合と中止のボタン・中止の知らせ・保存の知らせ・計算の失敗は警告で押しのけない', () => {
    const near = memory(3.5 * GIB);
    const progress = { featureId: 'extrude-1', index: 1, total: 4, label: '押し出し1' };
    const computing = describeStatus({ ...quiet(), kernelMemory: near, isComputing: true, progress });
    expect(computing.kind).toBe('progress');
    // 帯の「中止」は進み具合があるときに出る(StatusBar.tsx)。警告があっても押せる。
    expect(computing.progress).not.toBeNull();
    expect(describeStatus({ ...quiet(), kernelMemory: near, cancelled: true }).kind).toBe('cancelled');
    expect(
      describeStatus({ ...quiet(), kernelMemory: near, fileMessage: { key: 'file.saved', failed: false } }),
    ).toMatchObject({ kind: 'saved', text: t('file.saved') });
    expect(describeStatus({ ...quiet(), kernelMemory: near, errorMessage: '通信が切れました' }).text).toBe(
      `${t('statusBar.error')} 通信が切れました`,
    );
  });

  it('上限に近い計算を既存の中止で止めても、量を控えたまま中止の知らせの後に警告へ戻る', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    try {
      fake.calls[0].settle({ ...resultFor(fake.calls[0].document), kernelMemory: memory(3.2 * GIB) });
      await tick();
      expect(lineFromStore().kind).toBe('failure');

      const first = documentWithPoint();
      useAppStore.getState().setSketch(first);
      expect(fake.calls).toHaveLength(2);
      const shouldCancel = fake.calls[1].options.shouldCancel;
      expect(shouldCancel?.()).toBe(false);
      // 既存の中止の口(帯の「中止」が呼ぶもの)。警告のために別の口は作らない。
      useAppStore.getState().cancelRecompute();
      expect(shouldCancel?.()).toBe(true);
      fake.calls[1].settle({
        ...resultFor(fake.calls[1].document),
        cancelled: true,
        kernelMemory: memory(3.5 * GIB),
      });
      await tick();
      const cancelled = useAppStore.getState();
      expect(cancelled.recomputeCancelled).toBe(true);
      expect(cancelled.lastOutcome).toBe('cancelled');
      expect(cancelled.kernelMemory).toEqual(memory(3.5 * GIB));
      expect(lineFromStore().kind).toBe('cancelled');

      // 文書が変わると中止の知らせは消え、控えた量の警告が出る(計算中も出し続ける)。
      useAppStore.getState().setSketch(nextSketch(first, 1));
      expect(useAppStore.getState().recomputeCancelled).toBe(false);
      expect(lineFromStore()).toMatchObject({ kind: 'failure', text: WARNING_AT_3_5_GB });
      fake.calls[2].settle({ ...resultFor(fake.calls[2].document), kernelMemory: memory(3.5 * GIB) });
      await tick();
      expect(lineFromStore()).toMatchObject({ kind: 'failure', text: WARNING_AT_3_5_GB });
    } finally {
      detach();
    }
  });
});

describe('繰り返した後の解放', () => {
  it('計算を繰り返しても警告は 1 文のまま最新の量を出し、量が下がった計算の後で消える', async () => {
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    try {
      fake.calls[0].settle(resultFor(fake.calls[0].document));
      await tick();
      expect(lineFromStore().text).toBe(t('statusBar.ready'));

      let sketch = documentWithPoint();
      useAppStore.getState().setSketch(sketch);
      const readings = [3.1, 3.3, 3.5, 3.7, 3.9];
      for (const [round, gigabytes] of readings.entries()) {
        const call = fake.calls[round + 1];
        call.settle({ ...resultFor(call.document), kernelMemory: memory(gigabytes * GIB) });
        await tick();
        const line = lineFromStore();
        expect(line.kind).toBe('failure');
        expect(line.text).toContain(`(${gigabytes.toFixed(1)} GB / 上限 4.0 GB)`);
        expect(line.text.split(t('statusBar.memoryNearLimit'))).toHaveLength(2);
        sketch = nextSketch(sketch, round + 1);
        useAppStore.getState().setSketch(sketch);
      }

      // 量を添えない結果(ソリッドの段まで進まなかった等)では前の量を持ち続ける。
      const withoutReading = fake.calls[readings.length + 1];
      withoutReading.settle(resultFor(withoutReading.document));
      await tick();
      expect(useAppStore.getState().kernelMemory).toEqual(memory(3.9 * GIB));
      expect(lineFromStore().kind).toBe('failure');

      // 開き直した後の計算部は確保量が小さい。その量が届いた計算の後で警告は消える。
      useAppStore.getState().setSketch(nextSketch(sketch, 99));
      const afterReopen = fake.calls[readings.length + 2];
      afterReopen.settle({ ...resultFor(afterReopen.document), kernelMemory: memory(0.2 * GIB) });
      await tick();
      expect(useAppStore.getState().kernelMemory).toEqual(memory(0.2 * GIB));
      expect(lineFromStore()).toMatchObject({ kind: 'guide', text: t('statusBar.ready') });
      expect(fake.calls).toHaveLength(readings.length + 3);
    } finally {
      detach();
    }
  });

  it('量は計算部の事実なので、文書を作り直しても消えない(開き直すまで残る)', () => {
    const document = useAppStore.getState().document;
    useAppStore.getState().applyRecompute(document, {
      ...resultFor(document),
      kernelMemory: memory(3.5 * GIB),
    });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().kernelMemory).toEqual(memory(3.5 * GIB));
    expect(lineFromStore().text).toBe(WARNING_AT_3_5_GB);
  });

  it('部品ごとに結果を反映する経路の口も同じ控えへ入れ、量が無ければ前の量を残す', () => {
    const state = useAppStore.getState();
    state.recordKernelMemory(memory(3.5 * GIB));
    expect(lineFromStore().text).toBe(WARNING_AT_3_5_GB);
    state.recordKernelMemory(undefined);
    expect(useAppStore.getState().kernelMemory).toEqual(memory(3.5 * GIB));
    state.recordKernelMemory(memory(1 * GIB));
    expect(lineFromStore().text).toBe(t('statusBar.ready'));
  });
});

describe('アセンブリの部品ごとの再計算', () => {
  it('部品の計算でカーネルが添えた量を、model の再計算を通して控え、帯の警告に使う', async () => {
    let document = createAssemblyDocument('規格部品');
    const source = createStandardPartSource('hexBolt', 'M8', { length: '30' });
    document = addComponent(document, createComponentFor(document, source));
    useAppStore.getState().openAssembly(document);
    const detach = attachAssembly(assemblyBridge(memory(3.5 * GIB)));
    try {
      await vi.waitFor(() => {
        const state = useAppStore.getState();
        expect(state.isComputing).toBe(false);
        expect(state.completedGeneration).toBe(state.requestedGeneration);
        expect(state.kernelMemory).not.toBeNull();
      });
      expect(useAppStore.getState().kernelMemory).toEqual(memory(3.5 * GIB));
      expect(kernelMemoryWarningText(useAppStore.getState().kernelMemory)).toBe(WARNING_AT_3_5_GB);
    } finally {
      detach();
    }
  });
});
