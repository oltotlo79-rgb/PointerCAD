/**
 * ねじの簡略表示の印(§0.a-0.15)の線分を組み立てる純関数の検査
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク23)。
 *
 * `createSolidLayer()` 本体は three.js の入れ物を作るだけで DOM(canvas・WebGL)には
 * 触れないが、実際に描く判定(材質・renderOrder・当たり判定)は目視と E2E(タスク30)で
 * 確かめる方針(P2 タスク20 から続く決め方)なので、ここでは印の線分の座標を作る
 * `buildThreadMarkPositions` だけを検査する。
 */
import {
  appearanceFromPreset,
  DEFAULT_APPEARANCE,
  type AppearanceEntry,
  type AppearanceMatchEntry,
  type AppearanceSpec,
  type AppearanceTable,
  type SubShapeRef,
} from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { SolidFaceEntry } from '../solid/subShapeSelection.js';
import { buildSolidGeometry, type SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import {
  buildAppearanceInput,
  buildThreadMarkPositions,
  createSolidLayer,
  type ThreadMarkInfo,
} from './createSolidLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';

/** 円 1 つ(48 分割)+ 軸線 1 本ぶんの数値の個数。 */
const FLOATS_PER_MARK = 48 * 6 * 2 + 6;

describe('buildThreadMarkPositions', () => {
  it('印が無ければ空になる', () => {
    expect(buildThreadMarkPositions([])).toEqual(new Float32Array(0));
  });

  it('円2本(48分割の折れ線)+軸線1本ぶんの線分を作る', () => {
    const mark: ThreadMarkInfo = {
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      majorDiameter: 10,
      length: 20,
    };
    const positions = buildThreadMarkPositions([mark]);
    expect(positions.length).toBe(FLOATS_PER_MARK);

    // 始めの円(origin 中心、半径5)の最初の点。方位角0のとき、direction=(0,0,1) の
    // 基底は u=(0,-1,0)・v=(1,0,0)(参照軸(1,0,0)との外積)になるので、点は (0,-5,0)。
    expect(Array.from(positions.slice(0, 3))).toEqual([0, -5, 0]);

    // 終わりの円(origin + direction*length = (0,0,20) 中心)の最初の点も同じ向きにずれる。
    const secondCircleStart = 48 * 6;
    expect(Array.from(positions.slice(secondCircleStart, secondCircleStart + 3))).toEqual([
      0, -5, 20,
    ]);

    // 軸線(最後の6個)は origin → origin + direction*length。
    const axisStart = positions.length - 6;
    expect(Array.from(positions.slice(axisStart, axisStart + 6))).toEqual([0, 0, 0, 0, 0, 20]);
  });

  it('外径・長さが違う印を複数まとめて積む(印の数だけ長さが伸びる)', () => {
    const marks: ThreadMarkInfo[] = [
      { origin: [0, 0, 0], direction: [0, 0, 1], majorDiameter: 6, length: 10 },
      { origin: [5, 5, 0], direction: [1, 0, 0], majorDiameter: 8, length: 12 },
    ];
    const positions = buildThreadMarkPositions(marks);
    expect(positions.length).toBe(FLOATS_PER_MARK * 2);
  });

  it('向きが退化した(長さ0の)印は黙って飛ばす(NaN を作らない)', () => {
    const marks: ThreadMarkInfo[] = [
      { origin: [0, 0, 0], direction: [0, 0, 0], majorDiameter: 10, length: 20 },
      { origin: [1, 2, 3], direction: [0, 1, 0], majorDiameter: 4, length: 6 },
    ];
    const positions = buildThreadMarkPositions(marks);
    // 退化した1本目は積まれず、2本目ぶんだけになる。
    expect(positions.length).toBe(FLOATS_PER_MARK);
    expect(Array.from(positions).some((value) => Number.isNaN(value))).toBe(false);
  });
});

/*
 * ここから下は P5 タスク10(外観の材質配列化と配線、FR-1106〜1109)。
 *
 * `createSolidLayer()` は three.js の入れ物を作るだけで WebGL には触れないので、
 * 材質の配列・まとまり(`geometry.addGroup`)・資源の解放は Node のまま確かめられる。
 * 実際に「どう見えるか」(絵の同一性・fps)はヘッドレスの実測で確かめる方針。
 */

/** 面 1 枚 = 三角形 1 枚のボディを作る(まとまりの区切りを面の数で作れるようにする)。 */
function makeBody(featureId: string, faceCount: number): SolidBodyWithSubShapes {
  const indices = new Uint32Array(faceCount * 3);
  for (let position = 0; position < indices.length; position += 1) {
    indices[position] = position;
  }
  const normals = new Float32Array(faceCount * 9);
  for (let vertex = 0; vertex < faceCount * 3; vertex += 1) {
    normals[vertex * 3 + 2] = 1;
  }
  const faces: SolidFaceEntry[] = [];
  for (let face = 0; face < faceCount; face += 1) {
    faces.push({
      index: face,
      surfaceKind: 'plane',
      area: 1,
      centroid: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: face,
      triangleCount: 1,
    });
  }
  return {
    featureId,
    mesh: {
      positions: new Float32Array(faceCount * 9),
      normals,
      indices,
      edgePositions: new Float32Array(12),
      triangleCount: faceCount,
    },
    volume: 1,
    isValid: true,
    faces,
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 色だけを変えた外観(「自分で決める」相当)。 */
function coloredAppearance(color: string): AppearanceSpec {
  return { ...DEFAULT_APPEARANCE, preset: 'custom', color };
}

/** 面の指紋つきの参照(通し番号だけが要る検査なので、指紋の中身は最小にする)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

function tableOf(entries: AppearanceTable['entries']): AppearanceTable {
  return { entries };
}

/**
 * ボディの面のメッシュか(材質が配列のもの)。部分形状の重ね描きは材質が 1 つなので外れる。
 * 中身まで確かめてから絞り込むので、後の取り出しで型を偽らずに済む。
 */
function isBodyMesh(
  object: THREE.Object3D,
): object is THREE.Mesh<THREE.BufferGeometry, THREE.Material[]> {
  if (!(object instanceof THREE.Mesh)) {
    return false;
  }
  const material: unknown = object.material;
  return Array.isArray(material) && material.every((entry) => entry instanceof THREE.Material);
}

/** 層の中の「ボディの面」だけを取り出す。 */
function bodyMeshesOf(group: THREE.Object3D): THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>[] {
  return group.children.filter(isBodyMesh);
}

describe('buildAppearanceInput(文書の割り当て → 組み立てへ渡す一式)', () => {
  it('割り当てが 1 つも無ければ、ボディの表は空で既定の外観だけになる', () => {
    const input = buildAppearanceInput(tableOf([]), []);
    expect(input.byBody.size).toBe(0);
    expect(input.defaultAppearance).toBe(DEFAULT_APPEARANCE);
  });

  it('立体への割り当ては bodyAppearance に入る', () => {
    const steel = appearanceFromPreset('steel');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'body', bodyFeatureId: 'extrude-1' }, appearance: steel },
      ]),
      [],
    );
    expect(input.byBody.get('extrude-1')?.bodyAppearance).toBe(steel);
    expect(input.byBody.get('extrude-1')?.faceAppearances.size).toBe(0);
  });

  it('面への割り当ては、カーネルが選び直した面の通し番号に入る', () => {
    const glass = appearanceFromPreset('glass');
    const matches: AppearanceMatchEntry[] = [
      { id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: 4 },
    ];
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 2) }, appearance: glass },
      ]),
      matches,
    );
    // 保存されている通し番号(2)ではなく、選び直した番号(4)を使う。
    expect(input.byBody.get('extrude-1')?.faceAppearances.get(4)).toBe(glass);
    expect(input.byBody.get('extrude-1')?.faceAppearances.has(2)).toBe(false);
  });

  it('選び直せなかった(faceIndex が null)割り当ては描かない', () => {
    const input = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-1', 2) },
          appearance: appearanceFromPreset('steel'),
        },
      ]),
      [{ id: 'appearance-1', bodyFeatureId: 'extrude-1', faceIndex: null }],
    );
    // 描くものが 1 つも無いので、そのボディの入れ物そのものを作らない。
    expect(input.byBody.has('extrude-1')).toBe(false);
  });

  it('照合の結果がまだ無い割り当ては、割り当てたときの通し番号を使う(色を付けた直後)', () => {
    const steel = appearanceFromPreset('steel');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 3) }, appearance: steel },
      ]),
      [],
    );
    expect(input.byBody.get('extrude-1')?.faceAppearances.get(3)).toBe(steel);
  });

  it('立体と面の両方の割り当てが 1 つの入れ物にまとまる', () => {
    const steel = appearanceFromPreset('steel');
    const glass = appearanceFromPreset('glass');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 1) }, appearance: glass },
        { id: 'appearance-2', target: { kind: 'body', bodyFeatureId: 'extrude-1' }, appearance: steel },
      ]),
      [],
    );
    const assignment = input.byBody.get('extrude-1');
    expect(assignment?.bodyAppearance).toBe(steel);
    expect(assignment?.faceAppearances.get(1)).toBe(glass);
  });
});

describe('createSolidLayer(材質の配列とまとまり、FR-1106)', () => {
  it('外観を 1 つも割り当てていないときは、材質 1 つ・まとまり 1 つ・P2 と同じ色になる', () => {
    const layer = createSolidLayer();
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, []);
    layer.update(bundle, 'shadedWithEdges', null);

    const meshes = bodyMeshesOf(layer.group);
    expect(meshes.length).toBe(1);
    const material = meshes[0].material[0];
    expect(meshes[0].material.length).toBe(1);
    expect(meshes[0].geometry.groups.length).toBe(1);
    expect(meshes[0].geometry.groups[0]).toMatchObject({ start: 0, count: 18, materialIndex: 0 });
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    // P2〜P4 の faceMaterial と同じ値(§0.a-0.12「1 ドットも変えない」)。
    expect(material.color.getHex()).toBe(DEFAULT_THEME_COLORS.solid);
    expect(material.roughness).toBeCloseTo(0.55, 10);
    expect(material.metalness).toBeCloseTo(0.05, 10);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(1);
    expect(material.polygonOffsetUnits).toBe(1);
    expect(material.transparent).toBe(false);
    layer.dispose();
  });

  it('柄のための箱投影 UV を 2 個組の属性として流し込む(FR-1108)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 2);
    const bundle = buildSolidGeometry([body], null, []);
    layer.update(bundle, 'shadedWithEdges', null);

    const uv = bodyMeshesOf(layer.group)[0].geometry.getAttribute('uv');
    expect(uv.itemSize).toBe(2);
    expect(uv.count).toBe(body.mesh.positions.length / 3);
    layer.dispose();
  });

  it('同じ束を 2 回渡してもまとまりも材質も作り直さない', () => {
    const layer = createSolidLayer();
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, []);
    layer.update(bundle, 'shadedWithEdges', null);
    const mesh = bodyMeshesOf(layer.group)[0];
    const groups = mesh.geometry.groups;
    const materials = mesh.material;

    layer.update(bundle, 'shadedWithEdges', null);
    // clearGroups() は毎回新しい配列を作るので、同一参照なら 1 回も呼ばれていない。
    expect(mesh.geometry.groups).toBe(groups);
    expect(mesh.material).toBe(materials);
    layer.dispose();
  });

  it('ホバーが変わって組み立て直しても、まとまりと材質はそのまま(毎コマ作り直さない)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 6);
    layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges', null);
    const mesh = bodyMeshesOf(layer.group)[0];
    const groups = mesh.geometry.groups;
    const materials = mesh.material;

    // ホバーだけが変わった束(中身は同じまとまり・同じ外観)。
    layer.update(buildSolidGeometry([body], 'extrude-1', []), 'shadedWithEdges', null);
    expect(mesh.geometry.groups).toBe(groups);
    expect(mesh.material).toBe(materials);
    layer.dispose();
  });

  it('面 1 枚へ別の色を割り当てると、材質が 2 つ・まとまりが 2 つ以上になる', () => {
    const layer = createSolidLayer();
    const red = coloredAppearance('#d94f4f');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 2) }, appearance: red },
      ]),
      [],
    );
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', 6)], null, [], input),
      'shadedWithEdges',
      null,
    );

    const mesh = bodyMeshesOf(layer.group)[0];
    expect(mesh.material.length).toBe(2);
    expect(mesh.geometry.groups.length).toBeGreaterThanOrEqual(2);
    // まとまりは索引の全体をちょうど覆う(three の addGroup の約束)。
    const covered = mesh.geometry.groups.reduce((total, group) => total + group.count, 0);
    expect(covered).toBe(18);
    const painted = mesh.material[1];
    if (!(painted instanceof THREE.MeshStandardMaterial)) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    expect(painted.color.getHex()).toBe(0xd94f4f);
    layer.dispose();
  });

  it('外観だけを変えても、三角形の並びは同じものを指したままになる(形を作り直さない)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 6);
    layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges', null);
    const mesh = bodyMeshesOf(layer.group)[0];
    const positions = mesh.geometry.getAttribute('position');

    const input = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-1', 0) },
          appearance: coloredAppearance('#4f7ad9'),
        },
      ]),
      [],
    );
    layer.update(buildSolidGeometry([body], null, [], input), 'shadedWithEdges', null);
    expect(mesh.geometry.getAttribute('position')).toBe(positions);
    expect(mesh.material.length).toBe(2);
    layer.dispose();
  });

  it('材質が上限(8 種)を超える割り当てでは、止めずに既定 1 色へ落とす', () => {
    const layer = createSolidLayer();
    const colors = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999'];
    const entries: AppearanceEntry[] = colors.map((color, face) => ({
      id: `appearance-${String(face)}`,
      target: { kind: 'face', ref: faceRef('extrude-1', face) },
      appearance: coloredAppearance(color),
    }));
    const input = buildAppearanceInput(tableOf(entries), []);
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', colors.length)], null, [], input),
      'shadedWithEdges',
      null,
    );

    const mesh = bodyMeshesOf(layer.group)[0];
    expect(mesh.material.length).toBe(1);
    expect(mesh.geometry.groups.length).toBe(1);
    layer.dispose();
  });

  it('テーマを変えると既定の外観の色だけが塗り替わる(FR-908)', () => {
    const layer = createSolidLayer();
    const red = coloredAppearance('#d94f4f');
    const input = buildAppearanceInput(
      tableOf([
        { id: 'appearance-1', target: { kind: 'face', ref: faceRef('extrude-1', 0) }, appearance: red },
      ]),
      [],
    );
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, [], input);
    layer.update(bundle, 'shadedWithEdges', null);

    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, solid: 0x9ea6b4 });
    layer.update(bundle, 'shadedWithEdges', null);

    const mesh = bodyMeshesOf(layer.group)[0];
    const [base, painted] = mesh.material;
    if (
      !(base instanceof THREE.MeshStandardMaterial) ||
      !(painted instanceof THREE.MeshStandardMaterial)
    ) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    expect(base.color.getHex()).toBe(0x9ea6b4);
    // 利用者が選んだ色はテーマで塗り替えない。
    expect(painted.color.getHex()).toBe(0xd94f4f);
    layer.dispose();
  });

  it('環境マップを渡すと材質へ入り、null に戻すと外れる(FR-1107)', () => {
    const layer = createSolidLayer();
    const bundle = buildSolidGeometry([makeBody('extrude-1', 6)], null, []);
    const environment = new THREE.Texture();
    layer.update(bundle, 'shadedWithEdges', environment);
    const mesh = bodyMeshesOf(layer.group)[0];
    const material = mesh.material[0];
    if (!(material instanceof THREE.MeshStandardMaterial)) {
      throw new Error('材質が MeshStandardMaterial ではありません。');
    }
    expect(material.envMap).toBe(environment);

    layer.update(bundle, 'shadedWithEdges', null);
    expect(material.envMap).toBe(null);
    environment.dispose();
    layer.dispose();
  });

  it('使われなくなった材質を捨てる(WebGL の資源を漏らさない)', () => {
    const layer = createSolidLayer();
    const body = makeBody('extrude-1', 6);
    const input = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-1', 0) },
          appearance: coloredAppearance('#d94f4f'),
        },
      ]),
      [],
    );
    layer.update(buildSolidGeometry([body], null, [], input), 'shadedWithEdges', null);
    const painted = bodyMeshesOf(layer.group)[0].material[1];
    let disposed = false;
    painted.addEventListener('dispose', () => {
      disposed = true;
    });

    // 割り当てを外した束を渡すと、その材質はもう使われない。
    layer.update(buildSolidGeometry([body], null, []), 'shadedWithEdges', null);
    expect(disposed).toBe(true);
    layer.dispose();
  });

  it('dispose() で残っている材質もすべて捨てる', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges', null);
    const material = bodyMeshesOf(layer.group)[0].material[0];
    let disposed = false;
    material.addEventListener('dispose', () => {
      disposed = true;
    });

    layer.dispose();
    expect(disposed).toBe(true);
  });
});
