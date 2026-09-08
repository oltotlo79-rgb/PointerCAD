/**
 * アセンブリの解決の検査(計画書 docs/plans/P7-アセンブリ.md タスク6 の検証表)。
 *
 * 期待値はすべて閉じた式で手計算できるものにしてある(部品の形は作らない——`resolveAssembly`
 * はカーネルを呼ばない純関数で、返すのは「依頼」と「配置」だけである)。
 */

import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Parameter } from '../parameters/types.js';
import { appendSolid, createEmptyPartDocument } from '../part/createPartDocument.js';
import { resolvePart } from '../part/resolvePart.js';
import type { PartDocument, PrimitiveFeature } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { embedPart, EMPTY_PART_LIBRARY, type PartLibrary } from './partLibrary.js';
import {
  IDENTITY_PLACEMENT,
  quaternionFromAxisAngle,
  type Quaternion,
  type RigidPlacement,
} from './placementMath.js';
import {
  assemblyVariables,
  INVALID_PLACEMENT_MESSAGE,
  MISSING_PART_MESSAGE,
  MISSING_STANDARD_SIZE_MESSAGE,
  partKeyOf,
  resolveAssembly,
} from './resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Placement } from './types.js';

/** 取り込みの時刻を固定して、抱き込みの結果を決定的にする。 */
const IMPORTED_AT = '2026-09-06T00:00:00.000Z';

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`検査の式が評価できない: ${source}`);
  }
  return result.value;
}

/**
 * 名前を含む式。**この場では評価できない**(変数表が要る)ので、保存されている評価値を
 * 添えて作る——保存された文書の中の式は、まさにこの形で入っている。
 */
function pending(source: string, value: number): ExpressionValue {
  return { source, value, display: String(value) };
}

/** 一辺 `size` の箱を 1 段だけ持つ部品文書。段の欄が数まで解けているかを見るのに使う。 */
function boxPart(size: ExpressionValue, parameters: readonly Parameter[] = []): PartDocument {
  const feature: PrimitiveFeature = {
    id: 'solid-1',
    name: '箱1',
    suppressed: false,
    kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size },
  };
  const document = appendSolid(createEmptyPartDocument(), feature);
  return parameters.length === 0 ? document : { ...document, parameters };
}

/** 部品文書を順に抱き込んだ一式。`ref` は `part-1`、`part-2`、… になる。 */
async function libraryWith(...documents: readonly PartDocument[]): Promise<PartLibrary> {
  let library = EMPTY_PART_LIBRARY;
  for (const [index, document] of documents.entries()) {
    const result = await embedPart(
      library,
      document,
      `部品${index + 1}.pcad`,
      `../parts/部品${index + 1}.pcad`,
      { importedAt: IMPORTED_AT },
    );
    library = result.library;
  }
  return library;
}

/** 位置だけを指定した保存形の配置(向きは回さない)。 */
function placementAt(x: number, y: number, z: number): Placement {
  return {
    position: [
      expressionValueFromNumber(x),
      expressionValueFromNumber(y),
      expressionValueFromNumber(z),
    ],
    rotation: [0, 0, 0, 1],
  };
}

function componentOf(
  id: string,
  source: ComponentSource,
  overrides: Partial<AssemblyComponent> = {},
): AssemblyComponent {
  return {
    id,
    name: id,
    source,
    placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false,
    visible: true,
    suppressed: false,
    ...overrides,
  };
}

function assemblyWith(
  components: readonly AssemblyComponent[],
  parameters: readonly Parameter[] = [],
): AssemblyDocument {
  return { ...createAssemblyDocument('組立1'), components, parameters };
}

/** `partRef` を指すインスタンス。 */
function partSource(partRef: string): ComponentSource {
  return { kind: 'part', partRef };
}

/** 段 1 つぶんの箱の一辺(mm)。段まで数が届いているかを見る。 */
function boxSizeOf(library: PartLibrary, partRef: string, assembly: AssemblyDocument): number {
  const resolved = resolveAssembly(assembly, { library });
  const part = resolved.parts.get(partRef);
  const plan = part?.steps[0]?.plan;
  if (plan === undefined || plan.kind !== 'primitive' || plan.shape.kind !== 'box') {
    throw new Error('箱の段が組み立たなかった');
  }
  return plan.shape.sizeX;
}

let library3: PartLibrary;

beforeAll(async () => {
  library3 = await libraryWith(boxPart(expr('10')), boxPart(expr('20')), boxPart(expr('30')));
});

describe('部品ごとに 1 回だけ解決する(§0.a-0.4)', () => {
  it('resolvedPartsを省くと従来どおりlibraryの文書を解決する', () => {
    const assembly = assemblyWith([componentOf('component-1', partSource('part-1'))]);
    const result = resolveAssembly(assembly, { library: library3 });
    expect(result.parts.get('part-1')).toEqual(resolvePart(boxPart(expr('10'))));
  });

  it('resolvedPartsにある鍵はlibraryを引かず、同じ結果を2個で共有する', () => {
    const part = resolvePart(boxPart(expr('42')));
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1')),
      componentOf('component-2', partSource('part-1')),
    ]);
    const result = resolveAssembly(assembly, { resolvedParts: new Map([['part-1', part]]) });
    expect(result.parts.get('part-1')).toBe(part);
    expect(result.parts.size).toBe(1);
    expect([...result.partKeys.values()]).toEqual(['part-1', 'part-1']);
    expect(result.errors).toEqual([]);
  });

  it('resolvedPartsに無い鍵だけ従来どおりlibraryから解決する', () => {
    const part = resolvePart(boxPart(expr('42')));
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1')),
      componentOf('component-2', partSource('part-2')),
    ]);
    const result = resolveAssembly(assembly, {
      library: library3, resolvedParts: new Map([['part-1', part]]),
    });
    expect(result.parts.get('part-1')).toBe(part);
    expect(result.parts.get('part-2')).toEqual(resolvePart(boxPart(expr('20'))));
    expect(result.errors).toEqual([]);
  });

  it('同じ部品を 5 個置いても解決は 1 回', async () => {
    const library = await libraryWith(boxPart(expr('10')));
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1')),
      componentOf('component-2', partSource('part-1')),
      componentOf('component-3', partSource('part-1')),
      componentOf('component-4', partSource('part-1')),
      componentOf('component-5', partSource('part-1')),
    ]);

    const resolved = resolveAssembly(assembly, { library });

    expect(resolved.parts.size).toBe(1);
    expect(resolved.placements.size).toBe(5);
    expect(resolved.errors).toEqual([]);
  });

  it('異なる部品 3 種・合計 10 個', () => {
    const components = [
      componentOf('component-1', partSource('part-1')),
      componentOf('component-2', partSource('part-2')),
      componentOf('component-3', partSource('part-3')),
      componentOf('component-4', partSource('part-1')),
      componentOf('component-5', partSource('part-2')),
      componentOf('component-6', partSource('part-3')),
      componentOf('component-7', partSource('part-1')),
      componentOf('component-8', partSource('part-1')),
      componentOf('component-9', partSource('part-2')),
      componentOf('component-10', partSource('part-3')),
    ];

    const resolved = resolveAssembly(assemblyWith(components), { library: library3 });

    expect(resolved.parts.size).toBe(3);
    expect(resolved.placements.size).toBe(10);
    expect(resolved.errors).toEqual([]);
  });

  it('インスタンスは部品の鍵で形を引ける', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-2')),
      componentOf('component-2', partSource('part-2')),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.partKeys.get('component-1')).toBe('part-2');
    expect(resolved.partKeys.get('component-2')).toBe('part-2');
    // 2 つのインスタンスが同じ鍵を指し、その鍵の解決結果は 1 つしか無い(作り直していない)。
    expect([...resolved.parts.keys()]).toEqual(['part-2']);
    expect(resolved.parts.get('part-2')?.steps).toHaveLength(1);
  });
});

describe('抑制と、引けない部品(FR-503、FR-504、NFR-RE-1)', () => {
  it('抑制した部品は placements に入らず、errors も増えない', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1')),
      componentOf('component-2', partSource('part-2'), { suppressed: true }),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect([...resolved.placements.keys()]).toEqual(['component-1']);
    expect(resolved.parts.size).toBe(1);
    expect(resolved.errors).toEqual([]);
  });

  it('partRef が一式に無いときは投げずに理由を積む', () => {
    const assembly = assemblyWith([componentOf('component-1', partSource('part-9'))]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.errors).toEqual([
      { componentId: 'component-1', code: 'missingPart', message: MISSING_PART_MESSAGE },
    ]);
    // 置き場所は分かっているので配置は返る。中身が無いことは partKeys の欠けで分かる。
    expect(resolved.placements.has('component-1')).toBe(true);
    expect(resolved.partKeys.has('component-1')).toBe(false);
  });

  it('引けない部品があっても、ほかの部品は解決される', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-9')),
      componentOf('component-2', partSource('part-1')),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.parts.size).toBe(1);
    expect(resolved.errors).toHaveLength(1);
  });

  it('一式を渡さなければ、置いた部品はすべて理由つきで引けない', () => {
    const assembly = assemblyWith([componentOf('component-1', partSource('part-1'))]);

    const resolved = resolveAssembly(assembly);

    expect(resolved.parts.size).toBe(0);
    expect(resolved.errors.map((error) => error.message)).toEqual([MISSING_PART_MESSAGE]);
  });

  it('サブアセンブリはいまは引けない(タスク36 で再帰を入れる)', () => {
    const source: ComponentSource = { kind: 'subAssembly', assemblyRef: 'part-1' };
    const assembly = assemblyWith([componentOf('component-1', source)]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.errors).toHaveLength(1);
    expect(resolved.placements.size).toBe(1);
  });
});

describe('規格部品(FR-612、FR-616、§0.a-0.35)', () => {
  const bolt: ComponentSource = {
    kind: 'standardPart',
    catalog: 'hexBolt',
    size: 'M8',
    options: { length: '30' },
    catalogRevision: 'test-catalog',
    generatorRevision: 'test-generator',
  };

  it('台本が無ければ「この呼び寸法は用意されていません。」', () => {
    const resolved = resolveAssembly(assemblyWith([componentOf('component-1', bolt)]));

    expect(resolved.errors.map((error) => error.message)).toEqual([MISSING_STANDARD_SIZE_MESSAGE]);
  });

  it('同じ呼び寸法は台本を 1 回しか呼ばない', () => {
    const calls: string[] = [];
    const assembly = assemblyWith([
      componentOf('component-1', bolt),
      componentOf('component-2', bolt),
      componentOf('component-3', { ...bolt, size: 'M10' }),
    ]);

    const resolved = resolveAssembly(assembly, {
      standardPart: (source) => {
        calls.push(source.size);
        return boxPart(expr('8'));
      },
    });

    expect(calls).toEqual(['M8', 'M10']);
    expect(resolved.parts.size).toBe(2);
    expect(resolved.placements.size).toBe(3);
  });

  it('鍵は指定の書いた順に依らない(§0.a-0.54)', () => {
    const forward: ComponentSource = {
      kind: 'standardPart',
      catalog: 'equalAngle',
      size: 'L50x50x6',
      options: { length: '1000', material: 'steel' },
      catalogRevision: 'test-catalog',
      generatorRevision: 'test-generator',
    };
    const backward: ComponentSource = {
      ...forward,
      options: { material: 'steel', length: '1000' },
    };

    expect(partKeyOf(forward)).toBe(partKeyOf(backward));
    expect(partKeyOf(forward)).toBe(
      'equalAngle@test-catalog/test-generator:L50x50x6|length=1000|material=steel',
    );
  });
});

describe('配置(§2.4、§0.a-0.54)', () => {
  it('位置の式をアセンブリのパラメータ表で解く(§0.a-0.9)', () => {
    const parameters: readonly Parameter[] = [
      { name: 'ピッチ', value: expr('25'), unit: 'mm', description: '' },
    ];
    const placement: Placement = {
      position: [pending('ピッチ * 2', 0), expr('0'), expr('0')],
      rotation: [0, 0, 0, 1],
    };
    const assembly = assemblyWith(
      [componentOf('component-1', partSource('part-1'), { placement })],
      parameters,
    );

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.placements.get('component-1')?.position).toEqual([50, 0, 0]);
    expect(assemblyVariables(assembly).get('ピッチ')).toBe(25);
  });

  it('読めない式は保存された評価値のまま置く(投げない)', () => {
    const placement: Placement = {
      // 名前を定義していないので評価できない。値は保存されたものが残る(FR-504)。
      position: [{ source: '未知の名前', value: 7, display: '7' }, expr('0'), expr('0')],
      rotation: [0, 0, 0, 1],
    };
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1'), { placement }),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.placements.get('component-1')?.position).toEqual([7, 0, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('数でない値は 0mm に落として理由を積む', () => {
    const placement: Placement = {
      position: [{ source: '', value: Number.NaN, display: '' }, expr('4'), expr('0')],
      rotation: [0, 0, 0, 1],
    };
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1'), { placement }),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect(resolved.placements.get('component-1')?.position).toEqual([0, 4, 0]);
    expect(resolved.errors).toEqual([
      { componentId: 'component-1', code: 'invalidValue', message: INVALID_PLACEMENT_MESSAGE },
    ]);
  });

  it('向きは長さ 1・w >= 0 へ揃う(§0.a-0.54)', () => {
    // −(0,0,sin45°,cos45°) は同じ回転。長さも 1 でない値を渡して、揃うことを見る。
    const rotation: Quaternion = [0, 0, -1.4142135623730951, -1.4142135623730951];
    const placement: Placement = { ...placementAt(0, 0, 0), rotation };
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1'), { placement }),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    const solved = resolved.placements.get('component-1')?.rotation;
    expect(solved?.[3]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(solved?.[2]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(Math.hypot(...(solved ?? [0, 0, 0, 0]))).toBeCloseTo(1, 15);
  });
});

describe('入れ子の順序(§2.11、サブアセンブリの土台)', () => {
  it('親 ∘ 子 の順で合成する(子の位置が親の向きで回る)', () => {
    // 親: Z まわり 90° 回してから (1, 2, 3) へ。子: (10, 0, 0)。
    // R(親)·(10,0,0) = (0,10,0) なので、合成は (1, 12, 3)。
    // 逆順(子 ∘ 親)なら (11, 2, 3) になるので、順序を取り違えたら落ちる。
    const parent: RigidPlacement = {
      position: [1, 2, 3],
      rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2),
    };
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1'), { placement: placementAt(10, 0, 0) }),
    ]);

    const solved = resolveAssembly(assembly, { library: library3, parent }).placements.get(
      'component-1',
    );

    expect(solved?.position[0]).toBeCloseTo(1, 12);
    expect(solved?.position[1]).toBeCloseTo(12, 12);
    expect(solved?.position[2]).toBeCloseTo(3, 12);
  });

  it('親を渡さなければ恒等(置いた配置がそのまま出る)', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1'), { placement: placementAt(10, 0, 0) }),
    ]);

    const withoutParent = resolveAssembly(assembly, { library: library3 });
    const withIdentity = resolveAssembly(assembly, {
      library: library3,
      parent: IDENTITY_PLACEMENT,
    });

    expect(withoutParent.placements.get('component-1')?.position).toEqual([10, 0, 0]);
    expect(withIdentity.placements.get('component-1')).toEqual(
      withoutParent.placements.get('component-1'),
    );
  });
});

describe('部品の側の解決', () => {
  it('部品自身のパラメータ表が段の数に効く(FR-207、FR-502)', async () => {
    const parameters: readonly Parameter[] = [
      { name: '幅', value: expr('42'), unit: 'mm', description: '' },
    ];
    const library = await libraryWith(boxPart(pending('幅', 0), parameters));
    const assembly = assemblyWith([componentOf('component-1', partSource('part-1'))]);

    expect(boxSizeOf(library, 'part-1', assembly)).toBe(42);
  });

  it('部品ごとに違う形が返る', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-1')),
      componentOf('component-2', partSource('part-3')),
    ]);

    expect(boxSizeOf(library3, 'part-1', assembly)).toBe(10);
    expect(boxSizeOf(library3, 'part-3', assembly)).toBe(30);
  });
});

describe('決定性(§0.a-0.54)', () => {
  it('2 回解いて同じ結果になり、Map の反復順も同じ', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-2'), { placement: placementAt(5, 0, 0) }),
      componentOf('component-2', partSource('part-1')),
      componentOf('component-3', partSource('part-2')),
    ]);

    const first = resolveAssembly(assembly, { library: library3 });
    const second = resolveAssembly(assembly, { library: library3 });

    expect([...second.parts.keys()]).toEqual([...first.parts.keys()]);
    expect([...second.placements.keys()]).toEqual([...first.placements.keys()]);
    expect([...second.placements.values()]).toEqual([...first.placements.values()]);
    expect([...second.parts.values()]).toEqual([...first.parts.values()]);
    expect(second.errors).toEqual(first.errors);
  });

  it('並びは文書の components の順(部品の鍵は初めて出た順)', () => {
    const assembly = assemblyWith([
      componentOf('component-1', partSource('part-3')),
      componentOf('component-2', partSource('part-1')),
      componentOf('component-3', partSource('part-3')),
    ]);

    const resolved = resolveAssembly(assembly, { library: library3 });

    expect([...resolved.parts.keys()]).toEqual(['part-3', 'part-1']);
    expect([...resolved.placements.keys()]).toEqual([
      'component-1',
      'component-2',
      'component-3',
    ]);
  });
});
