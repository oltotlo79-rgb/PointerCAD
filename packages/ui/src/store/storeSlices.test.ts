/**
 * 機能ごとに分けたストア(P6 タスク52)が、分ける前と同じ 1 本のままであることの検査。
 *
 * `create()` は `createInitialDocumentState()` と 12 本のスライスを `...` で重ねる。
 * **重ねる順に後ろが勝つ**ので、2 か所が同じ欄を作ると片方が黙って消える(型の上では
 * `Omit` で防いであるが、`Omit` の相手(`*InitialState`)を書き忘れたときは通ってしまう)。
 * ここで実際に作らせて、欄が重なっていないこと・合わせるとちょうど全部になることを見る。
 *
 * もう 1 つ、**スライス同士を import しない**ことも見る。スライスをまたぐ読み書きは
 * `get()` 経由に統一してあり(`viewSlice.ts` 冒頭)、直に import すると読み込みの輪ができる。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createAssemblySlice } from './assemblySlice.js';
import { createCanvasSlice } from './canvasSlice.js';
import { createConstraintSlice } from './constraintSlice.js';
import { createDocumentSlice } from './documentSlice.js';
import { createDrawingSlice } from './drawingSlice.js';
import { createExchangeSlice } from './exchangeSlice.js';
import { createFileSlice } from './fileSlice.js';
import { createInitialDocumentState } from './initialDocumentState.js';
import { createMeasureSlice } from './measureSlice.js';
import { createRecomputeSlice } from './recomputeSlice.js';
import { createSelectionSlice } from './selectionSlice.js';
import { createSketchSlice } from './sketchSlice.js';
import { createTimelineSlice } from './timelineSlice.js';
import { useAppStore } from './useAppStore.js';
import { createViewSlice } from './viewSlice.js';

const SLICES = [
  ['viewSlice', createViewSlice],
  ['canvasSlice', createCanvasSlice],
  ['exchangeSlice', createExchangeSlice],
  ['documentSlice', createDocumentSlice],
  ['drawingSlice', createDrawingSlice],
  ['timelineSlice', createTimelineSlice],
  ['recomputeSlice', createRecomputeSlice],
  ['sketchSlice', createSketchSlice],
  ['constraintSlice', createConstraintSlice],
  ['selectionSlice', createSelectionSlice],
  ['measureSlice', createMeasureSlice],
  ['fileSlice', createFileSlice],
  ['assemblySlice', createAssemblySlice],
] as const;

/**
 * スライスの作り手をそのまま呼んで、作る欄の名前だけを見る。
 * 作り手は関数を並べた表を返すだけで `set` を呼ばないので、ストアは 1 ミリも動かない。
 */
function keysOf(creator: (typeof SLICES)[number][1]): readonly string[] {
  return Object.keys(creator(useAppStore.setState, useAppStore.getState, useAppStore));
}

const storeDirectory = dirname(fileURLToPath(import.meta.url));

describe('機能ごとに分けたストア(P6 タスク52)', () => {
  it('スライス同士と、作り直しの初期値とで、作る欄が重なっていない', () => {
    const owner = new Map<string, string>();
    for (const key of Object.keys(createInitialDocumentState())) {
      owner.set(key, 'createInitialDocumentState');
    }
    const collisions: string[] = [];
    for (const [name, creator] of SLICES) {
      for (const key of keysOf(creator)) {
        const previous = owner.get(key);
        if (previous !== undefined) {
          collisions.push(`${key}(${previous} と ${name})`);
          continue;
        }
        owner.set(key, name);
      }
    }
    expect(collisions, '同じ欄を 2 か所が作ると、後で重ねたほうが黙って勝つ').toEqual([]);
  });

  it('全部を合わせると、ストアの欄とちょうど一致する', () => {
    const built = new Set<string>([
      ...Object.keys(createInitialDocumentState()),
      ...SLICES.flatMap(([, creator]) => keysOf(creator)),
    ]);
    expect([...built].sort()).toEqual(Object.keys(useAppStore.getState()).sort());
  });

  it('スライスは互いを import しない(読み込みの輪を作らない)', () => {
    const sliceFiles = readdirSync(storeDirectory).filter(
      (name) => name.endsWith('Slice.ts') && !name.endsWith('.test.ts'),
    );
    const offenders: string[] = [];
    for (const name of sliceFiles) {
      const source = readFileSync(join(storeDirectory, name), 'utf8');
      for (const match of source.matchAll(/from '\.\/([A-Za-z]+Slice)\.js'/g)) {
        // 型だけの参照(`AppState` を組み立てる appState.ts)は実体を持たないので輪にならない。
        if (!/import type/.test(source.slice(Math.max(0, match.index - 200), match.index))) {
          offenders.push(`${name} → ${match[1]}`);
        }
      }
    }
    expect(offenders, 'スライスをまたぐ読み書きは get() 経由にする').toEqual([]);
  });
});
