/**
 * 部品を 3D の画面で押して欄へ入れる頼み(配置の補助 P-A の残り): 頼む道具が開いている時だけ頼め、候補の部品は欄へ入れて閉じ、
 * 候補でない部品は印を立てて開いたままにし、道具を閉じると頼みも閉じる事。3D の画面の押下からの流れは attachAssemblyInteraction.test.ts。
 */
import { createAssemblyDocument, createEmptyPartDocument, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { standardPlacedTarget } from '../assembly/catalogSearch.js';
import { createDimensionMoveDraft } from '../assembly/dimensionMoveDraft.js';
import { DEFAULT_STANDARD_PART_PICKER } from '../assembly/standardPartPicker.js';
import { createAssemblyInitialState } from './assemblySlice.js';
import { activeComponentPick, componentPickAccepts } from './componentPickActions.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

beforeEach(resetTestStore);

/** 寸法で動かすの打ちかけを開いた状態(部品 comp-b を動かす。基準は原点の面)。 */
function openDimensionMove(): void {
  useAppStore.setState({ assemblyDimensionMoveDraft: createDimensionMoveDraft(useAppStore.getState().activeDocumentId, 'comp-b') });
}

describe('部品を押して欄へ入れる頼み', () => {
  it('初めは頼みが無く、押した部品を渡しても何もしない。頼む道具が開いていない時は頼まない', () => {
    expect(createAssemblyInitialState().assemblyComponentPick).toBeNull();
    expect(useAppStore.getState().answerComponentPick('comp-a')).toBe(false);
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
  });

  it('候補の部品は寸法で動かすの基準へ入れて頼みを閉じる。釦の押し直しと候補が空の時は頼みを閉じる', () => {
    openDimensionMove();
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a', 'comp-c']);
    expect(useAppStore.getState().assemblyComponentPick).toEqual({ documentId: useAppStore.getState().activeDocumentId,
      purpose: 'dimensionMoveReference', candidates: ['comp-a', 'comp-c'], placement: null, notice: null });
    expect(useAppStore.getState().answerComponentPick('comp-c')).toBe(true);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    expect(useAppStore.getState().assemblyDimensionMoveDraft?.reference).toBe('comp-c');
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', []);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
  });

  it('候補でない部品(動かす部品・同じ組)は印を立てて断り、欄を変えず頼みを開いたままにする', () => {
    openDimensionMove();
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    expect(useAppStore.getState().answerComponentPick('comp-b')).toBe(false);
    expect(useAppStore.getState().assemblyComponentPick?.notice).toBe('notCandidate');
    expect(useAppStore.getState().assemblyDimensionMoveDraft?.reference).toBe('origin');
    expect(useAppStore.getState().answerComponentPick('comp-a')).toBe(true);
    expect(useAppStore.getState().assemblyDimensionMoveDraft?.reference).toBe('comp-a');
  });

  it('道具を閉じると頼みも閉じ、閉じた道具・別の文書の頼みは無いものとして扱う', () => {
    openDimensionMove();
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    useAppStore.getState().cancelDimensionMove();
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    // ほかの道具が寸法で動かすを閉じた(頼みの欄は残った)。
    openDimensionMove();
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    useAppStore.setState({ assemblyDimensionMoveDraft: null });
    expect(activeComponentPick(useAppStore.getState())).toBeNull();
    expect(useAppStore.getState().answerComponentPick('comp-a')).toBe(false);
    // 別の文書へ移った。
    resetTestStore();
    openDimensionMove();
    useAppStore.getState().toggleComponentPick('dimensionMoveReference', ['comp-a']);
    expect(activeComponentPick(useAppStore.getState())).not.toBeNull();
    useAppStore.setState({ activeDocumentId: 'another-document' });
    expect(activeComponentPick(useAppStore.getState())).toBeNull();
  });

  it('向き(面・辺を受ける頼み)は斜め(成分で)の時だけ頼め、軸へ戻すと無いものになる。向きの取れない物は印を立てて残す', () => {
    openDimensionMove();
    useAppStore.getState().toggleComponentPick('dimensionMoveDirection', []);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    useAppStore.getState().updateDimensionMoveDraft({ direction: 'vector' });
    useAppStore.getState().toggleComponentPick('dimensionMoveDirection', []);
    expect(componentPickAccepts(useAppStore.getState())).toBe('faceOrEdge');
    // 部品を渡しても、面・辺を受ける頼みは受けない。面・辺が拾えなかった(null)時も断りの印。
    expect(useAppStore.getState().answerComponentPick('comp-a')).toBe(false);
    expect(useAppStore.getState().answerComponentPickTarget(null)).toBe(false);
    expect(useAppStore.getState().assemblyComponentPick?.notice).toBe('notDirection');
    expect(useAppStore.getState().assemblyDimensionMoveDraft?.vector).toEqual(['1', '0', '0']);
    useAppStore.getState().updateDimensionMoveDraft({ direction: 1 });
    expect(activeComponentPick(useAppStore.getState())).toBeNull();
    expect(componentPickAccepts(useAppStore.getState())).toBeNull();
    // 寸法で動かすを閉じると、どちらの頼みも閉じる。
    useAppStore.getState().updateDimensionMoveDraft({ direction: 'vector' });
    useAppStore.getState().cancelDimensionMove();
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
  });

  it('置く点(G1): 選ぶ窓が開いている時だけ頼め、押した点に部品の原点が来るように置いて頼みを閉じる。置く物が無い時は頼まない', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'), EMPTY_PART_LIBRARY);
    const { category, choiceKey, dimensionSeries, threadSeries } = DEFAULT_STANDARD_PART_PICKER;
    const lengthSource = '2*23';
    const bolt = { kind: 'standardPart' as const, category: 'hexBolt' as const, choiceKey, lengthSource, dimensionSeries, threadSeries,
      accessory: undefined, recent: standardPlacedTarget('hexBolt', choiceKey, dimensionSeries, { material: 'SS400', shape: null }, lengthSource) };
    expect(category).toBe('hexBolt');
    useAppStore.getState().toggleComponentPick('placementPoint', [], bolt);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    useAppStore.setState({ standardPartPickerOpen: true });
    useAppStore.getState().toggleComponentPick('placementPoint', []);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    useAppStore.getState().toggleComponentPick('placementPoint', [], bolt);
    expect(componentPickAccepts(useAppStore.getState())).toBe('point');
    expect(useAppStore.getState().answerComponentPickPoint([20, -40, 0])).toBe(true);
    expect(useAppStore.getState().assemblyComponentPick).toBeNull();
    const placed = useAppStore.getState().assembly?.components ?? [];
    expect(placed).toHaveLength(1);
    expect(placed[0]?.source).toMatchObject({ kind: 'standardPart', catalog: 'hexBolt', options: { length: lengthSource } });
    expect(placed[0]?.placement.position.map((value) => value.value)).toEqual([20, -40, 0]);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
  });

  it('置く点(G1): 置けない指定は印を立てて頼みを残す。部品のファイルは押した点の座標を X・Y・Z の欄へ入れる(確定は今の釦)', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'), EMPTY_PART_LIBRARY);
    useAppStore.setState({ standardPartPickerOpen: true });
    const { choiceKey, dimensionSeries, threadSeries } = DEFAULT_STANDARD_PART_PICKER;
    const broken = { kind: 'standardPart' as const, category: 'hexBolt' as const, choiceKey: '表に無い呼び', lengthSource: '30', dimensionSeries,
      threadSeries, accessory: undefined, recent: standardPlacedTarget('hexBolt', choiceKey, dimensionSeries, { material: 'SS400', shape: null }, '30') };
    useAppStore.getState().toggleComponentPick('placementPoint', [], broken);
    expect(useAppStore.getState().answerComponentPickPoint([0, 0, 0])).toBe(false);
    expect(useAppStore.getState().assemblyComponentPick?.notice).toBe('notPlaced');
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
    useAppStore.getState().cancelComponentPick();
    useAppStore.setState({ standardPartPickerOpen: false, assemblyPlacement: { kind: 'ready', requestId: 'request-1',
      documentId: useAppStore.getState().activeDocumentId, fileName: '箱.pcad', document: createEmptyPartDocument(),
      attachments: emptyEmbeddedPartAttachments(), sources: ['幅', '0', '0'] } });
    useAppStore.getState().toggleComponentPick('placementPoint', [], { kind: 'partFile' });
    expect(useAppStore.getState().answerComponentPickPoint([12.5, -3, 0])).toBe(true);
    expect(useAppStore.getState().assemblyPlacement).toMatchObject({ kind: 'ready', sources: ['12.5', '-3', '0'] });
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
  });
});
