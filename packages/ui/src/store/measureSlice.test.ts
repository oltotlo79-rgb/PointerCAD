/** 測定。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  appearanceFromPreset,
  appearanceOf,
  appendSolid,
  assignBodyAppearance,
  createEmptyPartDocument,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type {
  PartMeasurer,
} from '../solid/measureCommands.js';
import type {
  MeasurementState,
} from '../viewport/createMeasureLayer.js';
import {
  attachPartMeasure,
} from './attachKernel.js';
import {
  createInitialDocumentState,
} from './initialDocumentState.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  partWithPoint,
  extrudeFeature,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('測定の結果の消え方(FR-1102、P5 タスク31)', () => {
  /** 40×30×10 の板の向かい合う面の距離(タスク30 の計算そのまま)。 */
  const MEASUREMENT: MeasurementState = {
    result: {
      kind: 'faceDistance',
      value: 10,
      unit: 'mm',
      segment: [
        [20, 15, 0],
        [20, 15, 10],
      ],
    },
    text: '10.000 mm',
    angle: null,
    anchor: null,
  };

  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('起動直後は何も測っていない', () => {
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('形が変わると消える', () => {
    useAppStore.setState({ measurement: MEASUREMENT });
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('外観だけを変えても残る(形は 1 ミリも動いていない)', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore.setState({ measurement: MEASUREMENT });

    const painted = assignBodyAppearance(
      useAppStore.getState().document,
      'extrude-1',
      appearanceFromPreset('steel'),
    );
    useAppStore.getState().applyDocument(painted);

    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(1);
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);
  });

  it('取り消しで形が戻ると消える', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore.setState({ measurement: MEASUREMENT });

    useAppStore.getState().undo();
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('外観だけの取り消し・やり直しでは残る(FR-505、FR-1110)', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore
      .getState()
      .applyDocument(
        assignBodyAppearance(
          useAppStore.getState().document,
          'extrude-1',
          appearanceFromPreset('steel'),
        ),
      );
    useAppStore.setState({ measurement: MEASUREMENT });

    useAppStore.getState().undo();
    expect(appearanceOf(useAppStore.getState().document).entries).toHaveLength(0);
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);

    useAppStore.getState().redo();
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);
  });

  it('新しい部品にすると消える(前の部品の値は当てはまらない)', () => {
    useAppStore.setState({ measurement: MEASUREMENT });
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().measurement).toBeNull();
  });
});

/*
 * 測る・消すの操作(FR-1101、FR-1102。P5 タスク32)。判断と組み立ては
 * `solid/measureCommands.ts` にあるので、ここが固定するのは**ストアの口の振る舞い**だけ
 * (置く・消す・断りを出す・形を測る手立てを差し出す)。
 */

describe('測る・消すの操作(FR-1101、FR-1102、P5 タスク32)', () => {
  const MEASUREMENT: MeasurementState = {
    result: { kind: 'bodyVolume', value: 12000, unit: 'mm3', segment: null },
    text: '12000.000 mm³',
    angle: null,
    anchor: [20, 15, 5],
  };

  const MASS = {
    bodyFeatureId: 'extrude-1',
    volume: 12000,
    area: 3400,
    centreOfMass: [20, 15, 5] as const,
    principalMoments: [1, 2, 3] as const,
  };

  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('測った値を置くと、前の断りは消える(押したら必ず何かが起きる)', () => {
    useAppStore.getState().setMeasureError('measureError.nothingSelected');
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    expect(useAppStore.getState().measurement).toBe(MEASUREMENT);
    expect(useAppStore.getState().massProperties).toBe(MASS);
    expect(useAppStore.getState().measureErrorKey).toBeNull();
  });

  it('質量特性を渡さない置き方では、前の質量特性を持ち越さない', () => {
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore.getState().setMeasurement(MEASUREMENT);
    expect(useAppStore.getState().massProperties).toBeNull();
  });

  it('Esc で消す口は、測定と質量特性の両方を落とす(§0.a-0.68)', () => {
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore.getState().clearMeasurement();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(useAppStore.getState().massProperties).toBeNull();
  });

  it('何も測っていなければ消す口は何もしない(Esc の他の働きへ譲るため)', () => {
    const before = useAppStore.getState();
    useAppStore.getState().clearMeasurement();
    // 状態そのものが差し替わっていない(set を呼んでいない)ことまで見る。
    expect(useAppStore.getState()).toBe(before);
  });

  it('質量特性も形が変わると消える(体積・重心は形そのものの値)', () => {
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    expect(useAppStore.getState().massProperties).toBeNull();
  });

  it('外観だけを変えても質量特性は残る(材料を変えても形は動かない)', () => {
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    useAppStore.getState().setMeasurement(MEASUREMENT, MASS);
    useAppStore
      .getState()
      .applyDocument(
        assignBodyAppearance(
          useAppStore.getState().document,
          'extrude-1',
          appearanceFromPreset('aluminum'),
        ),
      );
    expect(useAppStore.getState().massProperties).toBe(MASS);
  });

  it('測れなかった理由は文書が変われば用済み(FR-504)', () => {
    useAppStore.getState().setMeasureError('measureError.tooMany');
    expect(useAppStore.getState().measureErrorKey).toBe('measureError.tooMany');
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
    expect(useAppStore.getState().measureErrorKey).toBeNull();
  });

  it('形を測る手立てを差し出す・取り下げる(attachPartMeasure)', () => {
    const measurer: PartMeasurer = () =>
      Promise.resolve({ kind: 'failed', message: '測れませんでした。' });
    const detach = attachPartMeasure(measurer);
    expect(useAppStore.getState().partMeasurer).toBe(measurer);
    detach();
    expect(useAppStore.getState().partMeasurer).toBeNull();
  });

  it('別の手立てに差し替わった後の片付けは、新しい手立てを消さない', () => {
    const first: PartMeasurer = () => Promise.resolve({ kind: 'failed', message: '1' });
    const second: PartMeasurer = () => Promise.resolve({ kind: 'failed', message: '2' });
    const detachFirst = attachPartMeasure(first);
    attachPartMeasure(second);
    detachFirst();
    expect(useAppStore.getState().partMeasurer).toBe(second);
  });

  it('選んでいるものが測れなければ、理由を置いて何も出さない(NFR-UX-5)', async () => {
    useAppStore.getState().measureSelection();
    // 一覧から出せる判定なので、次のマイクロタスクで結果が入る。
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(useAppStore.getState().measureErrorKey).toBe('measureError.nothingSelected');
  });
});
