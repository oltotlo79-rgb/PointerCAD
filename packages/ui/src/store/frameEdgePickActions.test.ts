/**
 * フレームの一括配置(J-01 包み 4b)の「辺を選ぶ途中」: 読み込んだ部品の辺だけをチェックでき(一覧の順に揃える)、
 * チェックはビューの選択として強調され、やめると強調も消え、取り消し・やり直しでも残らない事。
 */
import { addComponent, createAssemblyDocument, createComponentFor, EMPTY_PART_LIBRARY } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAssemblyInitialState } from './assemblySlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

const EDGES = ['plate::e1', 'plate::e2', 'plate::e3', 'plate::e4'];

beforeEach(resetTestStore);

describe('フレームの辺を選ぶ途中', () => {
  it('初めは選ぶ途中でなく、チェックもやめるも何もしない', () => {
    expect(createAssemblyInitialState().frameEdgePick).toBeNull();
    useAppStore.setState({ selection: ['other'] });
    expect(useAppStore.getState().toggleFrameEdgePick(EDGES[0] ?? '')).toBe(false);
    useAppStore.getState().endFrameEdgePick();
    expect(useAppStore.getState()).toMatchObject({ frameEdgePick: null, selection: ['other'] });
  });

  it('読み込むと選択を空にして始まり、チェックは一覧の順に揃えてビューの選択にする。読み込んだ部品の辺でない物は断る', () => {
    useAppStore.setState({ selection: ['plate'] });
    useAppStore.getState().beginFrameEdgePick('plate', EDGES);
    expect(useAppStore.getState()).toMatchObject({ frameEdgePick: { componentId: 'plate', edgeIds: EDGES, checked: [] }, selection: [] });
    for (const id of ['plate::e3', 'plate::e1']) expect(useAppStore.getState().toggleFrameEdgePick(id)).toBe(true);
    expect(useAppStore.getState().frameEdgePick?.checked).toEqual(['plate::e1', 'plate::e3']);
    expect(useAppStore.getState().selection).toEqual(['plate::e1', 'plate::e3']);
    expect(useAppStore.getState().toggleFrameEdgePick('other::e1')).toBe(false);
    expect(useAppStore.getState().frameEdgePick?.checked).toEqual(['plate::e1', 'plate::e3']);
    expect(useAppStore.getState().toggleFrameEdgePick('plate::e1')).toBe(true);
    expect(useAppStore.getState()).toMatchObject({ frameEdgePick: { checked: ['plate::e3'] }, selection: ['plate::e3'] });
  });

  it('やめると選ぶ途中を消し、選択からは読み込んだ部品の辺だけを外す', () => {
    useAppStore.getState().beginFrameEdgePick('plate', EDGES);
    useAppStore.getState().toggleFrameEdgePick('plate::e2');
    useAppStore.setState({ selection: ['plate::e2', 'other'] });
    useAppStore.getState().endFrameEdgePick();
    expect(useAppStore.getState()).toMatchObject({ frameEdgePick: null, selection: ['other'] });
  });

  it('B-10: 読み込まずに空で始められ、一覧に無い辺は部品を渡さない時と表示が無い時は入れ替えず、理由の印も立てない', () => {
    // 空で始めても、選んである部品は残す(続けてその部品の辺を読み込む流れ。包み 4a)。
    useAppStore.setState({ selection: ['plate'] });
    useAppStore.getState().beginFrameEdgePick(null, []);
    expect(useAppStore.getState().frameEdgePick).toEqual({ componentId: null, edgeIds: [], checked: [], added: [], notice: null });
    expect(useAppStore.getState().selection).toEqual(['plate']);
    expect(useAppStore.getState().toggleFrameEdgePick('plate::e1')).toBe(false);
    // 表示(assemblyView)が無いので部品の辺が読めず、まっすぐかどうかも決められないので、印は立てない(まっすぐでない時の印は画面検査)。
    expect(useAppStore.getState().toggleFrameEdgePick('plate::e1', 'plate')).toBe(false);
    expect(useAppStore.getState().frameEdgePick).toMatchObject({ checked: [], notice: null });
    // 一覧にある辺を入れ替えると印は消える。
    useAppStore.getState().beginFrameEdgePick('plate', EDGES);
    expect(useAppStore.getState().toggleFrameEdgePick('plate::e2', 'plate')).toBe(true);
    expect(useAppStore.getState().frameEdgePick).toMatchObject({ checked: ['plate::e2'], notice: null });
  });

  it('取り消し・やり直しで文書を戻すと、選ぶ途中は残らない', () => {
    let document = createAssemblyDocument('枠');
    useAppStore.getState().openAssembly(document, EMPTY_PART_LIBRARY);
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part' }));
    useAppStore.getState().applyAssembly(document);
    useAppStore.getState().beginFrameEdgePick('plate', EDGES);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().frameEdgePick).toBeNull();
    useAppStore.getState().beginFrameEdgePick('plate', EDGES);
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().frameEdgePick).toBeNull();
  });
});
