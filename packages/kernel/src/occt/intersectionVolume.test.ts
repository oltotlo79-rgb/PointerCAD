import { expectWithinBudget } from '@pointercad/test-utils';
import type {
  BRepAlgoAPI_BooleanOperation,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { BoxParameters, PlacementSpec, Vec3Tuple } from '../types.js';
import type { Allocations, OcctDeletable } from './allocations.js';
import * as allocationModule from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { intersectionVolume } from './intersectionVolume.js';
import type { IntersectionVolumeResult, IntersectionVolumeStage } from './intersectionVolume.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { OcctShapeHandle } from './makeBox.js';
import { placeShape } from './placeBodies.js';
import { measureVolume } from './solidMesh.js';

const BIG: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const SMALL: BoxParameters = { dx: 10, dy: 10, dz: 10 };
const IDENTITY_ROTATION = [0, 0, 0, 1] as const;
const SPHERE_COMMON_VOLUME = 1308.9969389957471;

function boxAt(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  position: Vec3Tuple,
  dimensions = BIG,
): OcctShapeHandle {
  const box = keep(makeBox(oc, dimensions));
  return keep(placeShape(oc, box.shape, { position, rotation: IDENTITY_ROTATION }));
}

function sphereAt(oc: OpenCascadeInstance, keep: Allocations['keep'], x: number): TopoDS_Shape {
  const center = keep(new oc.gp_Pnt_3(x, 0, 0));
  const maker = keep(new oc.BRepPrimAPI_MakeSphere_5(center, 10));
  return keep(maker.Shape());
}

function expectVolume(
  result: IntersectionVolumeResult, volume: number, tolerance = 1e-6,
  expectedKind: 'clear' | 'overlap' = volume > 1e-6 ? 'overlap' : 'clear',
): void {
  expect(result.kind).toBe(expectedKind);
  if (result.kind === 'failed') throw new Error(JSON.stringify(result.failure));
  expect(Number.isFinite(result.volume)).toBe(true);
  expect(result.volume).toBeGreaterThanOrEqual(0);
  expect(Math.abs(result.volume - volume)).toBeLessThanOrEqual(tolerance);
  if (result.kind === 'clear') expect(result.shape).toBeNull();
}

function consume(
  result: IntersectionVolumeResult, volume: number, tolerance = 1e-6,
  expectedKind?: 'clear' | 'overlap',
): void {
  try {
    expectVolume(result, volume, tolerance, expectedKind);
  } finally {
    if (result.kind === 'overlap') result.delete();
  }
}

function shapeMetrics(oc: OpenCascadeInstance, shape: TopoDS_Shape) {
  const { keep, release } = allocationModule.createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let faces = 0;
    let edges = 0;
    for (let index = 1; index <= map.Size(); index += 1) {
      const subShape = keep(map.FindKey(index));
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) faces += 1;
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) edges += 1;
    }
    const location = keep(shape.Location_1());
    const transform = keep(location.Transformation());
    const matrix: number[] = [];
    for (let row = 1; row <= 3; row += 1) {
      for (let column = 1; column <= 4; column += 1) matrix.push(transform.Value(row, column));
    }
    return { volume: measureVolume(oc, shape), faces, edges, matrix };
  } finally {
    release();
  }
}

function expectSameMetrics(actual: ReturnType<typeof shapeMetrics>, expected: ReturnType<typeof shapeMetrics>): void {
  expect(Math.abs(actual.volume - expected.volume)).toBeLessThanOrEqual(1e-6);
  expect(actual.faces).toBe(expected.faces);
  expect(actual.edges).toBe(expected.edges);
  expect(actual.matrix).toEqual(expected.matrix);
}

/** 実物の控えとネイティブdeleteを使い、入力の貸し借りと各ラッパーの寿命を観測する。 */
function observeAllocations(oc: OpenCascadeInstance) {
  const entries: { item: OcctDeletable; deleted: number }[] = [];
  const deletionOrder: OcctDeletable[] = [];
  const buildModes: boolean[] = [];
  const buildOrder: string[] = [];
  const stageMs = new Map<string, number>();
  function timed<T>(stage: string, action: () => T): T {
    const start = performance.now();
    try {
      return action();
    } finally {
      stageMs.set(stage, (stageMs.get(stage) ?? 0) + performance.now() - start);
    }
  }
  function track<T extends OcctDeletable>(item: T): T {
    expect(entries.some((entry) => entry.item === item)).toBe(false);
    const entry = { item, deleted: 0 };
    const originalDelete = item.delete.bind(item);
    item.delete = (): void => {
      entry.deleted += 1;
      deletionOrder.push(item);
      timed('release', originalDelete);
    };
    entries.push(entry);
    if (item instanceof oc.BRepAlgoAPI_BooleanOperation) {
      const maker: BRepAlgoAPI_BooleanOperation = item;
      const setArguments = maker.SetArguments.bind(maker);
      const setTools = maker.SetTools.bind(maker);
      const setNonDestructive = maker.SetNonDestructive.bind(maker);
      const build = maker.Build.bind(maker);
      maker.SetArguments = (value): void => { buildOrder.push('arguments'); setArguments(value); };
      maker.SetTools = (value): void => { buildOrder.push('tools'); setTools(value); };
      maker.SetNonDestructive = (value): void => { buildOrder.push('nonDestructive'); setNonDestructive(value); };
      maker.Build = (range): void => {
        buildOrder.push('build');
        buildModes.push(maker.NonDestructive());
        timed('build', () => build(range));
      };
    }
    return item;
  }
  const createAllocations = allocationModule.createAllocations;
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const allocations = createAllocations();
    return {
      keep<T extends OcctDeletable>(item: T): T { return allocations.keep(track(item)); },
      release: allocations.release,
    };
  });
  const Properties = oc.GProp_GProps_1;
  vi.spyOn(oc, 'GProp_GProps_1').mockImplementation(function () { return track(new Properties()); });
  const Analyzer = oc.BRepCheck_Analyzer;
  vi.spyOn(oc, 'BRepCheck_Analyzer').mockImplementation(function (...args: ConstructorParameters<typeof Analyzer>) {
    return timed('validate', () => track(new Analyzer(...args)));
  });
  const mapShapes = oc.TopExp.MapShapes_2.bind(oc.TopExp);
  vi.spyOn(oc.TopExp, 'MapShapes_2').mockImplementation((...args) => timed('map', () => mapShapes(...args)));
  const volumeProperties = oc.BRepGProp.VolumeProperties_1.bind(oc.BRepGProp);
  vi.spyOn(oc.BRepGProp, 'VolumeProperties_1').mockImplementation((...args) => timed('measure', () => volumeProperties(...args)));
  return { entries, deletionOrder, buildModes, buildOrder, stageMs, analyzerPrototype: Analyzer.prototype };
}

function expectReleased(observed: ReturnType<typeof observeAllocations>, label: string): void {
  for (const entry of observed.entries) expect(entry.deleted, label).toBe(1);
  console.log(`${label}: 確保=${observed.entries.length} 解放=${observed.deletionOrder.length} 残数=${observed.entries.filter((entry) => entry.deleted === 0).length}`);
}

function expectFailed(result: IntersectionVolumeResult, code: string, stage: IntersectionVolumeStage): void {
  try {
    expect(result.kind).toBe('failed');
    expect(result.shape).toBeNull();
    expect(result.volume).toBeNull();
    if (result.kind === 'failed') {
      expect(result.failure.code).toBe(code);
      expect(result.failure.stage).toBe(stage);
      expect(result.failure.message.length).toBeGreaterThan(0);
    }
  } finally {
    if (result.kind === 'overlap') result.delete();
  }
}

type ExceptionPoint =
  | 'inputIsNull' | 'mapConstructor' | 'MapShapes_2' | 'Size' | 'FindKey' | 'ShapeType'
  | 'rangeConstructor' | 'commonConstructor' | 'listConstructor' | 'Append_1'
  | 'SetArguments' | 'SetTools' | 'SetNonDestructive' | 'Build' | 'HasErrors' | 'IsDone'
  | 'Shape' | 'resultIsNull' | 'propertiesConstructor' | 'VolumeProperties_1' | 'Mass'
  | 'analyzerConstructor' | 'IsValid_2';

interface ExceptionCase {
  readonly name: string;
  readonly point: ExceptionPoint;
  readonly nth: number;
  readonly stage: IntersectionVolumeStage;
}

const exceptionCases: ExceptionCase[] = [
  { name: '入力A.IsNull', point: 'inputIsNull', nth: 1, stage: 'input' },
  { name: '入力B.IsNull', point: 'inputIsNull', nth: 2, stage: 'input' },
  ...(['input', 'input', 'inspectResult'] as const).flatMap((stage, index) =>
    (['mapConstructor', 'MapShapes_2', 'Size', 'FindKey', 'ShapeType'] as const).map((point) => ({
      name: `${['入力A', '入力B', '結果'][index]}.${point}`, point, nth: index + 1, stage,
    }))),
  ...([
    ['rangeConstructor', 'createBuilder'], ['commonConstructor', 'createBuilder'],
    ['SetArguments', 'setInputs'], ['SetTools', 'setInputs'], ['SetNonDestructive', 'setNonDestructive'],
    ['Build', 'build'], ['HasErrors', 'checkBuild'], ['IsDone', 'checkBuild'], ['Shape', 'readShape'],
    ['resultIsNull', 'readShape'], ['propertiesConstructor', 'measure'], ['VolumeProperties_1', 'measure'],
    ['Mass', 'measure'], ['analyzerConstructor', 'validateResult'], ['IsValid_2', 'validateResult'],
  ] as const).map(([point, stage]) => ({ name: point, point, nth: 1, stage })),
  ...([1, 2] as const).flatMap((nth) => (['listConstructor', 'Append_1'] as const).map((point) => ({
    name: `${point}.${nth}`, point, nth, stage: 'setInputs' as const,
  }))),
];

/** n回目だけ投げる。実物のOCCTメソッドのthisと引数をそのまま保つ。 */
function onNth<This, Args extends unknown[], Result>(
  original: (this: This, ...args: Args) => Result, nth: number, failure: Error,
): (this: This, ...args: Args) => Result {
  let calls = 0;
  return function (this: This, ...args: Args): Result {
    calls += 1;
    if (calls === nth) throw failure;
    return original.apply(this, args);
  };
}

/** prototypeの差し替え前に控え、呼出時の実体をthisへ必ず渡す。 */
function captureMethod<Key extends string, Args extends unknown[], Result>(
  prototype: Record<Key, (...args: Args) => Result>, key: Key,
): (this: Record<Key, (...args: Args) => Result>, ...args: Args) => Result {
  const method = prototype[key];
  return function (this: Record<Key, (...args: Args) => Result>, ...args: Args): Result {
    return method.apply(this, args);
  };
}

function injectException(
  oc: OpenCascadeInstance, testCase: ExceptionCase, failure: Error,
  observed: ReturnType<typeof observeAllocations>,
): void {
  const { point, nth } = testCase;
  function fail(): never { throw failure; }
  switch (point) {
    case 'inputIsNull':
    case 'resultIsNull': {
      const original = captureMethod<'IsNull', [], boolean>(oc.TopoDS_Shape.prototype, 'IsNull');
      vi.spyOn(oc.TopoDS_Shape.prototype, 'IsNull').mockImplementation(onNth(original, point === 'resultIsNull' ? 3 : nth, failure));
      return;
    }
    case 'mapConstructor': {
      const Original = oc.TopTools_IndexedMapOfShape_1;
      vi.spyOn(oc, 'TopTools_IndexedMapOfShape_1').mockImplementation(onNth(function () { return new Original(); }, nth, failure));
      return;
    }
    case 'MapShapes_2': {
      // 観測用mockの実装を控える。mock自身を再帰的に呼ばない。
      const mock = vi.spyOn(oc.TopExp, 'MapShapes_2');
      const original = mock.getMockImplementation();
      if (!original) throw new Error('走査の観測が設定されていません。');
      mock.mockImplementation(onNth(original, nth, failure));
      return;
    }
    case 'Size': {
      const original = captureMethod<'Size', [], number>(oc.TopTools_IndexedMapOfShape.prototype, 'Size');
      vi.spyOn(oc.TopTools_IndexedMapOfShape.prototype, point).mockImplementation(onNth(original, nth, failure));
      return;
    }
    case 'FindKey': {
      const original = captureMethod<'FindKey', [number], TopoDS_Shape>(oc.TopTools_IndexedMapOfShape.prototype, 'FindKey');
      vi.spyOn(oc.TopTools_IndexedMapOfShape.prototype, point).mockImplementation(onNth(original, nth, failure));
      return;
    }
    case 'ShapeType': {
      const original = captureMethod<'ShapeType', [], ReturnType<TopoDS_Shape['ShapeType']>>(oc.TopoDS_Shape.prototype, 'ShapeType');
      vi.spyOn(oc.TopoDS_Shape.prototype, point).mockImplementation(onNth(original, nth, failure));
      return;
    }
    case 'rangeConstructor': vi.spyOn(oc, 'Message_ProgressRange_1').mockImplementation(fail); return;
    case 'commonConstructor': vi.spyOn(oc, 'BRepAlgoAPI_Common_1').mockImplementation(fail); return;
    case 'listConstructor': {
      const Original = oc.TopTools_ListOfShape_1;
      vi.spyOn(oc, 'TopTools_ListOfShape_1').mockImplementation(onNth(function () { return new Original(); }, nth, failure));
      return;
    }
    case 'Append_1': {
      const original = captureMethod<'Append_1', [TopoDS_Shape], TopoDS_Shape>(oc.TopTools_ListOfShape.prototype, 'Append_1');
      vi.spyOn(oc.TopTools_ListOfShape.prototype, point).mockImplementation(onNth(original, nth, failure));
      return;
    }
    case 'SetArguments':
    case 'SetNonDestructive': vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, point).mockImplementation(fail); return;
    case 'SetTools':
    case 'Build': vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, point).mockImplementation(fail); return;
    case 'HasErrors':
    case 'Shape': vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, point).mockImplementation(fail); return;
    case 'IsDone': vi.spyOn(oc.BRepBuilderAPI_Command.prototype, point).mockImplementation(fail); return;
    case 'propertiesConstructor': vi.mocked(oc.GProp_GProps_1).mockImplementationOnce(fail); return;
    case 'VolumeProperties_1': vi.spyOn(oc.BRepGProp, 'VolumeProperties_1').mockImplementation(fail); return;
    case 'Mass': vi.spyOn(oc.GProp_GProps.prototype, point).mockImplementation(fail); return;
    case 'analyzerConstructor': vi.mocked(oc.BRepCheck_Analyzer).mockImplementationOnce(fail); return;
    case 'IsValid_2': vi.spyOn(observed.analyzerPrototype, point).mockImplementation(fail); return;
  }
}

describe('非破壊の共通体積', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    const start = performance.now();
    oc = await loadOcctForNode();
    console.log(`共通体積 WASM初期化: ${(performance.now() - start).toFixed(3)} ms`);
  });

  const boxCases: readonly {
    name: string;
    offset: Vec3Tuple;
    dimensions?: BoxParameters;
    volume: number;
    tolerance?: number;
  }[] = [
    { name: '5mm侵入', offset: [15, 0, 0], volume: 2000 },
    { name: '10mm侵入', offset: [10, 0, 0], volume: 4000 },
    { name: '3軸で半分', offset: [10, 10, 10], volume: 1000 },
    { name: '離隔', offset: [100, 0, 0], volume: 0 },
    { name: '面接触', offset: [20, 0, 0], volume: 0 },
    { name: '辺接触', offset: [20, 20, 0], volume: 0 },
    { name: '頂点接触', offset: [20, 20, 20], volume: 0 },
    { name: '完全包含', offset: [5, 5, 5], dimensions: SMALL, volume: 1000 },
    { name: '別々に作った同位置の箱', offset: [0, 0, 0], volume: 8000 },
    { name: '表示偏差より薄い0.001mm侵入', offset: [19.999, 0, 0], volume: 0.4, tolerance: 1e-8 },
  ];
  it.each(boxCases)('$name: 解析体積 $volume mm³ と一致し入力を保持する', (testCase) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, testCase.offset, testCase.dimensions);
      const before = measureVolume(oc, b.shape);
      consume(intersectionVolume(oc, a.shape, b.shape), testCase.volume, testCase.tolerance);
      expect(Math.abs(measureVolume(oc, a.shape) - 8000)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(measureVolume(oc, b.shape) - before)).toBeLessThanOrEqual(1e-12);
    } finally {
      release();
    }
  });

  it('同一ラッパーを2回借りても体積8000で入力を解放しない', () => {
    const a = makeBox(oc, BIG);
    try {
      consume(intersectionVolume(oc, a.shape, a.shape), 8000);
      expect(Math.abs(measureVolume(oc, a.shape) - 8000)).toBeLessThanOrEqual(1e-6);
    } finally {
      a.delete();
    }
  });

  it('compound内の離れた2solidの体積を両方足す', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const first = keep(makeBox(oc, SMALL));
      const second = boxAt(oc, keep, [20, 0, 0], SMALL);
      const compound = keep(new oc.TopoDS_Compound());
      const builder = keep(new oc.BRep_Builder());
      builder.MakeCompound(compound);
      builder.Add(compound, first.shape);
      builder.Add(compound, second.shape);
      const outer = boxAt(oc, keep, [-5, -5, -5], { dx: 40, dy: 20, dz: 20 });
      consume(intersectionVolume(oc, compound, outer.shape), 2000);
    } finally {
      release();
    }
  });

  it('半径10・中心距離10の球冠2つを解析式の精度で測る', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      consume(intersectionVolume(oc, sphereAt(oc, keep, 0), sphereAt(oc, keep, 10)), SPHERE_COMMON_VOLUME);
    } finally {
      release();
    }
  });

  it('両入力に同じ90度回転と並進を掛けても体積2000で配置を二重適用しない', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [15, 0, 0]);
      const placement: PlacementSpec = {
        position: [57, -23, 11], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
      };
      const placedA = keep(placeShape(oc, a.shape, placement));
      const placedB = keep(placeShape(oc, b.shape, placement));
      consume(intersectionVolume(oc, placedA.shape, placedB.shape), 2000);
    } finally {
      release();
    }
  });

  it.each([
    { penetration: 0.0005, volume: 5e-7, expectedKind: 'clear' },
    { penetration: 0.002, volume: 2e-6, expectedKind: 'overlap' },
  ] as const)('小断面の実形状: 侵入$penetrationの体積$volumeを丸めず分類する', ({ penetration, volume, expectedKind }) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const dimensions = { dx: 0.01, dy: 0.02, dz: 0.05 };
      const a = keep(makeBox(oc, dimensions));
      const b = boxAt(oc, keep, [0.01 - penetration, 0, 0], dimensions);
      const result = intersectionVolume(oc, a.shape, b.shape);
      try {
        expectVolume(result, volume, 1e-12, expectedKind);
        if (result.kind === 'clear') expect(result.reason).toBe('belowThreshold');
      } finally {
        if (result.kind === 'overlap') result.delete();
      }
    } finally {
      release();
    }
  });
});

describe('共通体積の分類・例外安全・所有・性能', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  const classifications = [
    { name: 'HasErrors', code: 'buildFailed', stage: 'checkBuild' },
    { name: 'IsDone', code: 'buildFailed', stage: 'checkBuild' },
    { name: 'nullResult', code: 'invalidResult', stage: 'readShape' },
    { name: 'invalidShape', code: 'invalidResult', stage: 'validateResult' },
    { name: 'NaN', code: 'measurementFailed', stage: 'measure' },
    { name: 'Infinity', code: 'measurementFailed', stage: 'measure' },
    { name: 'negative', code: 'measurementFailed', stage: 'measure' },
  ] as const;
  it.each(classifications)('$nameは正常な空でなく$codeを返す', ({ name, code, stage }) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [15, 0, 0]);
      const observed = observeAllocations(oc);
      switch (name) {
        case 'HasErrors': vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, 'HasErrors').mockReturnValue(true); break;
        case 'IsDone': vi.spyOn(oc.BRepBuilderAPI_Command.prototype, 'IsDone').mockReturnValue(false); break;
        case 'nullResult': {
          let calls = 0;
          const original = captureMethod<'IsNull', [], boolean>(oc.TopoDS_Shape.prototype, 'IsNull');
          vi.spyOn(oc.TopoDS_Shape.prototype, 'IsNull').mockImplementation(function (this: TopoDS_Shape) {
            calls += 1;
            return calls === 3 ? true : original.call(this);
          });
          break;
        }
        case 'invalidShape':
          vi.spyOn(observed.analyzerPrototype, 'IsValid_2').mockReturnValue(false);
          // しきい値以下でも妥当性検査を飛ばしてclearにしてはいけない。
          vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(5e-7);
          break;
        case 'NaN': vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(NaN); break;
        case 'Infinity': vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(Infinity); break;
        case 'negative': vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(-1); break;
      }
      expectFailed(intersectionVolume(oc, a.shape, b.shape), code, stage);
      if (name === 'Infinity') {
        vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(-Infinity);
        expectFailed(intersectionVolume(oc, a.shape, b.shape), code, stage);
      }
      expectReleased(observed, name);
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it.each(['nullA', 'nullB', 'emptyCompound', 'faceOnly'] as const)('%sをinvalidInputとしてbuilder開始前に断る', (name) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const solid = keep(makeBox(oc, BIG));
      let invalid: TopoDS_Shape;
      if (name === 'emptyCompound') {
        const compound = keep(new oc.TopoDS_Compound());
        keep(new oc.BRep_Builder()).MakeCompound(compound);
        invalid = compound;
      } else if (name === 'faceOnly') {
        const map = keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(solid.shape, map, true, true);
        const faces: TopoDS_Shape[] = [];
        for (let index = 1; index <= map.Size(); index += 1) {
          const shape = keep(map.FindKey(index));
          if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) faces.push(shape);
        }
        expect(faces).toHaveLength(6);
        invalid = faces[0];
      } else {
        invalid = keep(new oc.TopoDS_Shape());
      }
      const observed = observeAllocations(oc);
      const a = name === 'nullB' ? solid.shape : invalid;
      const b = name === 'nullB' ? invalid : solid.shape;
      expectFailed(intersectionVolume(oc, a, b), 'invalidInput', 'input');
      expect(observed.buildOrder).toEqual([]);
      expect(observed.entries.some((entry) => entry.item instanceof oc.BRepAlgoAPI_BooleanOperation)).toBe(false);
      if (name === 'nullA' || name === 'nullB') expect(observed.entries).toHaveLength(0);
      expectReleased(observed, name);
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it.each([
    { volume: 5e-7, expectedKind: 'clear' },
    { volume: 1e-6, expectedKind: 'clear' },
    { volume: 2e-6, expectedKind: 'overlap' },
  ] as const)('測定値$volumeの厳密なしきい値境界を比較し、測定は1回だけ', ({ volume, expectedKind }) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [15, 0, 0]);
      const observed = observeAllocations(oc);
      const mass = vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(volume);
      const valid = vi.spyOn(observed.analyzerPrototype, 'IsValid_2');
      consume(intersectionVolume(oc, a.shape, b.shape), volume, 0, expectedKind);
      expect(mass).toHaveBeenCalledTimes(1);
      expect(valid).toHaveBeenCalledTimes(1);
      expectReleased(observed, `threshold/${volume}`);
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it.each(exceptionCases)('$nameの例外でも全所有物を解放し、同じ入力を再加工できる', (testCase) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      // 入力A/Bはそれぞれ先頭がSOLID。結果COMPOUNDの走査は3回目のmapで独立に狙う。
      const b = keep(makeBox(oc, SMALL));
      const beforeA = shapeMetrics(oc, a.shape);
      const beforeB = shapeMetrics(oc, b.shape);
      const observed = observeAllocations(oc);
      const failure = new Error(`注入:${testCase.name}`);
      injectException(oc, testCase, failure, observed);
      const result = intersectionVolume(oc, a.shape, b.shape);
      expectFailed(result, 'occtException', testCase.stage);
      if (result.kind === 'failed') expect(result.failure.detail).toBe(failure.message);
      expectReleased(observed, testCase.name);
      vi.restoreAllMocks();
      expectSameMetrics(shapeMetrics(oc, a.shape), beforeA);
      expectSameMetrics(shapeMetrics(oc, b.shape), beforeB);
      const next = keep(booleanOp(oc, 'subtract', a.shape, b.shape));
      expect(Math.abs(next.volume - 7000)).toBeLessThanOrEqual(1e-6);
      consume(intersectionVolume(oc, a.shape, b.shape), 1000);
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('非破壊指定はBuild前で、返却時の所有3個をshape→maker→rangeの順に1回ずつ解放する', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [15, 0, 0]);
      const observed = observeAllocations(oc);
      const result = intersectionVolume(oc, a.shape, b.shape);
      try {
        expectVolume(result, 2000);
        expect(observed.buildModes).toEqual([true]);
        expect(observed.buildOrder).toEqual(['arguments', 'tools', 'nonDestructive', 'build']);
        const retained = observed.entries.filter((entry) => entry.deleted === 0).map((entry) => entry.item);
        expect(retained).toHaveLength(3);
        expect(retained).toEqual([expect.any(oc.Message_ProgressRange), expect.any(oc.BRepAlgoAPI_BooleanOperation), result.shape]);
        expect(observed.entries.some((entry) => entry.item === a.shape || entry.item === b.shape)).toBe(false);
      } finally {
        if (result.kind === 'overlap') result.delete();
      }
      if (result.kind === 'overlap') {
        expect(observed.deletionOrder.slice(-3)).toEqual([result.shape, expect.any(oc.BRepAlgoAPI_BooleanOperation), expect.any(oc.Message_ProgressRange)]);
        result.delete();
      }
      expectReleased(observed, 'overlap ownership');
      console.log(`観測の内訳（厳密性能とは別）: ${JSON.stringify(Object.fromEntries(observed.stageMs))}`);
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('非nullの空COMPOUNDを正常emptyとして返し、所有を残さない', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [100, 0, 0]);
      const observed = observeAllocations(oc);
      let resultNull: boolean | undefined;
      let resultTypeMatches: boolean | undefined;
      const shape = captureMethod<'Shape', [], TopoDS_Shape>(oc.BRepAlgoAPI_Algo.prototype, 'Shape');
      vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, 'Shape').mockImplementation(function (this: BRepAlgoAPI_BooleanOperation) {
        const value = shape.call(this);
        resultNull = value.IsNull();
        resultTypeMatches = value.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND;
        return value;
      });
      expect(intersectionVolume(oc, a.shape, b.shape)).toEqual({ kind: 'clear', reason: 'empty', shape: null, volume: 0 });
      expect(resultNull).toBe(false);
      expect(resultTypeMatches).toBe(true);
      expectReleased(observed, 'empty ownership');
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('しきい値以下の非空shapeを返却前に全て解放する', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const dimensions = { dx: 0.01, dy: 0.02, dz: 0.05 };
      const a = keep(makeBox(oc, dimensions));
      const b = boxAt(oc, keep, [0.0095, 0, 0], dimensions);
      const observed = observeAllocations(oc);
      const result = intersectionVolume(oc, a.shape, b.shape);
      consume(result, 5e-7, 1e-12, 'clear');
      if (result.kind === 'clear') expect(result.reason).toBe('belowThreshold');
      expectReleased(observed, 'belowThreshold ownership');
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('同じTShapeの配置2個を借りた後も基底とLocationが不変で、続く差・積は新しい基底と一致する', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const base = keep(makeBox(oc, BIG));
      const a = keep(placeShape(oc, base.shape, { position: [0, 0, 0], rotation: IDENTITY_ROTATION }));
      const b = keep(placeShape(oc, base.shape, { position: [15, 0, 0], rotation: IDENTITY_ROTATION }));
      const before = [base, a, b].map((handle) => shapeMetrics(oc, handle.shape));
      consume(intersectionVolume(oc, a.shape, b.shape), 2000);
      const c = boxAt(oc, keep, [5, 5, 5], SMALL);
      const d = boxAt(oc, keep, [-10, 0, 0]);
      for (const [operation, tool] of [['subtract', c], ['intersect', d]] as const) {
        const fresh = keep(makeBox(oc, BIG));
        const result = keep(booleanOp(oc, operation, base.shape, tool.shape));
        const reference = keep(booleanOp(oc, operation, fresh.shape, tool.shape));
        expectSameMetrics(shapeMetrics(oc, result.shape), shapeMetrics(oc, reference.shape));
      }
      [base, a, b].forEach((handle, index) => expectSameMetrics(shapeMetrics(oc, handle.shape), before[index]));
    } finally {
      release();
    }
  });

  it('Buildが投げてfailedになった後も同じ入力を測定・差に使える', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [15, 0, 0]);
      const before = [a, b].map((handle) => shapeMetrics(oc, handle.shape));
      const original = captureMethod<'Build', Parameters<BRepAlgoAPI_BooleanOperation['Build']>, void>(oc.BRepAlgoAPI_BooleanOperation.prototype, 'Build');
      vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, 'Build').mockImplementation(function (this: BRepAlgoAPI_BooleanOperation, range) {
        original.call(this, range);
        throw new Error('実Build完了後の例外');
      });
      expectFailed(intersectionVolume(oc, a.shape, b.shape), 'occtException', 'build');
      vi.restoreAllMocks();
      const fresh = keep(makeBox(oc, BIG));
      const actual = keep(booleanOp(oc, 'subtract', a.shape, b.shape));
      const reference = keep(booleanOp(oc, 'subtract', fresh.shape, b.shape));
      expectSameMetrics(shapeMetrics(oc, actual.shape), shapeMetrics(oc, reference.shape));
      [a, b].forEach((handle, index) => expectSameMetrics(shapeMetrics(oc, handle.shape), before[index]));
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('入力リストのdeleteが投げても全所有群を解放し、一次Build失敗とcleanup失敗を両方残す', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = keep(makeBox(oc, SMALL));
      for (const failBuild of [false, true]) {
        const observed = observeAllocations(oc);
        const Original = oc.TopTools_ListOfShape_1;
        vi.spyOn(oc, 'TopTools_ListOfShape_1').mockImplementation(function () {
          const list = new Original();
          const originalDelete = list.delete.bind(list);
          list.delete = (): void => { originalDelete(); throw new Error('リスト解放後'); };
          return list;
        });
        if (failBuild) vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, 'Build').mockImplementation(() => { throw new Error('一次Build失敗'); });
        const result = intersectionVolume(oc, a.shape, b.shape);
        expectFailed(result, failBuild ? 'occtException' : 'cleanupFailed', failBuild ? 'build' : 'release');
        if (result.kind === 'failed') {
          expect(result.failure.cleanupMessages).toContain('リスト解放後');
          if (failBuild) expect(result.failure.detail).toBe('一次Build失敗');
        }
        expectReleased(observed, `list cleanup/${failBuild}`);
        vi.restoreAllMocks();
      }
      consume(intersectionVolume(oc, a.shape, b.shape), 1000);
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('返却shapeのdeleteが投げてもmaker/rangeを解放し、二度目は何もしない', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = keep(makeBox(oc, SMALL));
      const observed = observeAllocations(oc);
      const result = intersectionVolume(oc, a.shape, b.shape);
      expect(result.kind).toBe('overlap');
      if (result.kind !== 'overlap') throw new Error('重なりの所有を検査できません。');
      const originalDelete = result.shape.delete.bind(result.shape);
      result.shape.delete = (): void => { originalDelete(); throw new Error('結果shape解放後'); };
      expect(() => result.delete()).toThrow('結果shape解放後');
      expect(() => result.delete()).not.toThrow();
      expectReleased(observed, 'returned delete failure');
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it('同一入力でoverlap/empty/failedを20回反復しても所有が増えず、交換・反復結果が再現する', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG));
      const b = boxAt(oc, keep, [15, 0, 0]);
      const far = boxAt(oc, keep, [100, 0, 0]);
      const inputBefore = [a, b, far].map((handle) => shapeMetrics(oc, handle.shape));
      let reference: ReturnType<typeof shapeMetrics> | undefined;
      for (let repeat = 0; repeat < 20; repeat += 1) {
        const observed = observeAllocations(oc);
        for (const [left, right] of [[a, b], [b, a]]) {
          const result = intersectionVolume(oc, left.shape, right.shape);
          try {
            expectVolume(result, 2000);
            expect(observed.entries.filter((entry) => entry.deleted === 0)).toHaveLength(3);
            if (result.kind === 'overlap') {
              const metrics = shapeMetrics(oc, result.shape);
              if (!reference) reference = metrics;
              expectSameMetrics(metrics, reference);
              if (left === a) expect(Math.abs(metrics.volume - reference.volume)).toBeLessThanOrEqual(1e-12);
            }
          } finally {
            if (result.kind === 'overlap') result.delete();
          }
        }
        consume(intersectionVolume(oc, a.shape, far.shape), 0);
        vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, 'Build').mockImplementationOnce(() => { throw new Error('反復のBuild失敗'); });
        expectFailed(intersectionVolume(oc, a.shape, b.shape), 'occtException', 'build');
        expectReleased(observed, `repeat/${repeat + 1}`);
        vi.restoreAllMocks();
      }
      [a, b, far].forEach((handle, index) => expectSameMetrics(shapeMetrics(oc, handle.shape), inputBefore[index]));
    } finally {
      vi.restoreAllMocks();
      release();
    }
  });

  it.each(['box', 'sphere'] as const)('%sの単pairを入口から結果消費・解放まで最大500ms未満で処理する', (kind) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const fixtureStart = performance.now();
      const a = kind === 'box' ? keep(makeBox(oc, BIG)).shape : sphereAt(oc, keep, 0);
      const b = kind === 'box' ? boxAt(oc, keep, [15, 0, 0]).shape : sphereAt(oc, keep, 10);
      const fixtureMs = performance.now() - fixtureStart;
      const volume = kind === 'box' ? 2000 : SPHERE_COMMON_VOLUME;
      function sample(): number {
        const start = performance.now();
        consume(intersectionVolume(oc, a, b), volume);
        return performance.now() - start;
      }
      const cold = sample();
      const warmup = sample();
      const values = Array.from({ length: 5 }, sample);
      const median = [...values].sort((left, right) => left - right)[2];
      const maximum = Math.max(...values);
      console.log(`共通体積/${kind}: fixture=${fixtureMs.toFixed(3)} cold=${cold.toFixed(3)} warmup=${warmup.toFixed(3)} samples=${values.map((value) => value.toFixed(3)).join('/')} median=${median.toFixed(3)} max=${maximum.toFixed(3)} / 500 ms`);
      expectWithinBudget(maximum, 500, `共通体積/${kind}の最大値`);
    } finally {
      release();
    }
  });
});
