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
  DEFAULT_APPEARANCE,
  type AppearanceEntry,
  type AppearanceSpec,
  type AppearanceTable,
  type PrintabilityReport,
  type ResolvedPlane,
  type SubShapeRef,
} from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { printabilityTriangleOffsets } from '../solid/printabilityColors.js';
import type { SolidFaceEntry } from '../solid/subShapeSelection.js';
import { buildSolidGeometry, type SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import {
  buildThreadMarkPositions,
  createSolidLayer,
  type ThreadMarkInfo,
} from './createSolidLayer.js';
import { DEFAULT_THEME_COLORS } from './themeColors.js';
import { buildSphereGridPositions, type SphereGridSpec } from './buildSphereGrid.js';

/** 実測に使う球面の案内線(既定の 5°、半径 10 の球)。 */
const SPHERE_GRID_SPEC: SphereGridSpec = { center: [0, 0, 0], radius: 10, stepDegrees: 5 };

/** 5° の線分の本数(緯線 35 × 72 + 経線 72 × 72、計画書 §2.8.3)。 */
const SPHERE_GRID_SEGMENTS = 35 * 72 + 72 * 72;

/** 1 コマぶんの予算(60fps、NFR-PF-1)。 */
const FRAME_BUDGET_MS = 16;

/** 実測の平均を取る回数。1 回だけだと計測の揺れがそのまま出る。 */
const SPHERE_GRID_ROUNDS = 20;

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

/*
 * `buildAppearanceInput`(文書の割り当て → 組み立てへ渡す一式)そのものの検査は、
 * 関数の移設(P5 タスク11)に合わせて `appearance/appearanceCommands.test.ts` へ移した。
 * ここでは、その結果を流し込んだ層の見え方(材質の配列・まとまり・資源の解放)を確かめる。
 */

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

/* ------------------------------------------------------------------ *
 * 球面の案内線(球面グリッド、FR-431、P5 タスク21)
 * ------------------------------------------------------------------ */

/**
 * 層の中の「球面の案内線」の線分。色が方眼の主線(`gridMajor`)であることで見分ける。
 * ねじの印・切断の予告・部分形状の重ね描きは別の色なので取り違えない。
 */
type SphereGridLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/**
 * 球面の案内線の線分か。中身まで確かめてから絞り込むので、後の取り出しで型を偽らずに済む
 * (`isBodyMesh` と同じ作り)。
 */
function isSphereGridLines(object: THREE.Object3D): object is SphereGridLines {
  if (!(object instanceof THREE.LineSegments)) {
    return false;
  }
  const material: unknown = object.material;
  return (
    material instanceof THREE.LineBasicMaterial &&
    material.color.getHex() === DEFAULT_THEME_COLORS.gridMajor
  );
}

/** 見つからなければ検査を止める(戻り値の絞り込みを兼ねる)。 */
function requireSphereGridLines(group: THREE.Object3D): SphereGridLines {
  const found = group.children.find(isSphereGridLines);
  if (found === undefined) {
    throw new Error('球面の案内線の入れ物が見つかりません。');
  }
  return found;
}

describe('createSolidLayer の球面の案内線(FR-431、タスク21)', () => {
  it('線分を渡すと出て、null で消える(球を選んでいる間だけ出す土台)', () => {
    const layer = createSolidLayer();
    const lines = requireSphereGridLines(layer.group);
    // 何も渡していない間は出ていない(球が 1 つも無い文書では費用ゼロ)。
    expect(lines.visible).toBe(false);

    layer.updateSphereGrid(buildSphereGridPositions(SPHERE_GRID_SPEC));
    expect(lines.visible).toBe(true);
    expect(lines.geometry.getAttribute('position').count).toBe(SPHERE_GRID_SEGMENTS * 2);

    layer.updateSphereGrid(null);
    expect(lines.visible).toBe(false);
    layer.dispose();
  });

  it('同じ並び(同一参照)を渡し直すと入れ物を 1 つも触らない(NFR-PF-1)', () => {
    const layer = createSolidLayer();
    const positions = buildSphereGridPositions(SPHERE_GRID_SPEC);
    layer.updateSphereGrid(positions);
    const lines = requireSphereGridLines(layer.group);
    const attribute = lines.geometry.getAttribute('position');
    const sphere = lines.geometry.boundingSphere;

    layer.updateSphereGrid(positions);
    expect(lines.geometry.getAttribute('position')).toBe(attribute);
    expect(lines.geometry.boundingSphere).toBe(sphere);
    layer.dispose();
  });

  it('案内線の色はホバー・選択のどちらとも違う(見分けられる、2026-09-03 20:40 ①(b))', () => {
    const layer = createSolidLayer();
    const lines = requireSphereGridLines(layer.group);
    expect(lines.material.color.getHex()).not.toBe(DEFAULT_THEME_COLORS.hovered);
    expect(lines.material.color.getHex()).not.toBe(DEFAULT_THEME_COLORS.selected);
    // 案内であることが分かるよう、形そのものより控えめに出す。
    expect(lines.material.transparent).toBe(true);
    expect(lines.material.opacity).toBeLessThan(1);
    // 球の裏側の線は手前の面に隠れてよい(§0.a-0.21 の手順2)。
    expect(lines.material.depthTest).toBe(true);
    layer.dispose();
  });

  it('テーマを変えると案内線の色も塗り替わる(FR-908。部品は作り直さない)', () => {
    const layer = createSolidLayer();
    const lines = requireSphereGridLines(layer.group);
    const material = lines.material;
    layer.setThemeColors({ ...DEFAULT_THEME_COLORS, gridMajor: 0x123456 });
    expect(material.color.getHex()).toBe(0x123456);
    // 部品も材質も作り直さない(同じ入れ物・同じ材質のまま色だけが変わる)。
    expect(layer.group.children).toContain(lines);
    layer.dispose();
  });

  /**
   * §1.5-13 の実測。**5° の案内線(7,704 本)を出し入れする所要**を測る。
   *
   * 上限は 1 コマぶんの予算 16ms(NFR-PF-1 の 60fps)。案内線は球を選んだ瞬間と
   * 間隔を変えたときにしか作り直さない(同じ内容なら `createViewportScene` が
   * 組み立てそのものを省く)ので、この 1 回が 1 コマに収まれば 60fps を割らない。
   */
  it('5° の案内線の組み立てと流し込みが 1 コマ(16ms)に収まる(NFR-PF-1、§1.5-13)', () => {
    const layer = createSolidLayer();
    // 計り始める前に 1 回通して、初回だけの入れ物作りを外へ出す。
    layer.updateSphereGrid(buildSphereGridPositions(SPHERE_GRID_SPEC));

    const started = performance.now();
    for (let round = 0; round < SPHERE_GRID_ROUNDS; round += 1) {
      // 半径を変えた並びを毎回作り直す(球を選び直したときと同じ手間)。
      layer.updateSphereGrid(
        buildSphereGridPositions({ ...SPHERE_GRID_SPEC, radius: 10 + round }),
      );
    }
    const elapsed = (performance.now() - started) / SPHERE_GRID_ROUNDS;
    console.log(
      `[実測] 球面の案内線(5°・線分 ${String(SPHERE_GRID_SEGMENTS)} 本)の更新: ${elapsed.toFixed(3)} ms`,
    );
    expectWithinBudget(elapsed, FRAME_BUDGET_MS, '球面の案内線の更新');
    layer.dispose();
  });
});

/*
 * ここから下は P6 タスク35(ビューの断面表示の配線とつまみ、FR-111、§2.12)。
 *
 * `THREE.Plane` を材質へ配るところまでは WebGL に触れないので Node で確かめられる。
 * **実際に画素が切り取られるか**(ガラス `transmission > 0` の別パスを含む)は
 * 目視と E2E に回す(§1.5-20、タスク44)。
 */

/**
 * 材質か(型を偽らずに絞り込むための番人。`isBodyMesh` と同じ流儀で、
 * 述語の戻り型に既定の型引数を書いて `any` を持ち込まない)。
 */
function isMaterial(value: unknown): value is THREE.Material {
  return value instanceof THREE.Material;
}

/** 層の中にあるすべての材質(同じ材質は 1 回だけ)。 */
function allMaterialsOf(group: THREE.Object3D): THREE.Material[] {
  const collected = new Set<THREE.Material>();
  group.traverse((object) => {
    const material: unknown = Reflect.get(object, 'material');
    if (Array.isArray(material)) {
      for (const entry of material) {
        if (isMaterial(entry)) {
          collected.add(entry);
        }
      }
    } else if (isMaterial(material)) {
      collected.add(material);
    }
  });
  return [...collected];
}

/** メッシュの頂点の数(メッシュでなければ null)。つまみの四角(6 頂点)を見分けるのに使う。 */
function meshVertexCount(object: THREE.Object3D): number | null {
  if (!(object instanceof THREE.Mesh)) {
    return null;
  }
  const geometry: unknown = object.geometry;
  if (!(geometry instanceof THREE.BufferGeometry)) {
    return null;
  }
  const position: unknown = geometry.getAttribute('position');
  return position instanceof THREE.BufferAttribute ? position.count : null;
}

/**
 * 断面表示を配らない材質の数。切断の予告(四角と矢印)と断面表示のつまみ(四角と矢印)の
 * **4 つだけ**が対象外(どちらも平面の上に出るので、自分の切る面で消えてはいけない)。
 */
const UNCLIPPED_MATERIAL_COUNT = 4;

/** つまみを出す平面(XY 面、原点)。`sectionView.ts` の検証表と同じ面。 */
const SECTION_HANDLE_PLANE: ResolvedPlane = {
  origin: [0, 0, 0],
  axisU: [1, 0, 0],
  axisV: [0, 1, 0],
  normal: [0, 0, 1],
};

describe('createSolidLayer(断面表示のクリッピング、FR-111)', () => {
  it('切っているあいだは平面が 1 枚も無い(費用ゼロ、NFR-PF-1)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    for (const mesh of bodyMeshesOf(layer.group)) {
      for (const material of mesh.material) {
        expect(material.clippingPlanes).toEqual([]);
      }
    }
    layer.dispose();
  });

  it('入れると、立体を描く全材質へ同じ 1 枚が配られる(数を数える)', () => {
    const layer = createSolidLayer();
    const bodies = [makeBody('extrude-1', 2), makeBody('extrude-2', 3)];
    layer.update(buildSolidGeometry(bodies, null, []), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    layer.setSectionPlanes([plane]);

    const materials = allMaterialsOf(layer.group);
    const clipped = materials.filter(
      (material) => material.clippingPlanes !== null && material.clippingPlanes.length === 1,
    );
    const untouched = materials.filter((material) => material.clippingPlanes === null);
    // 予告とつまみの 4 つ以外は、1 つ残らず配られている。
    expect(untouched).toHaveLength(UNCLIPPED_MATERIAL_COUNT);
    expect(clipped).toHaveLength(materials.length - UNCLIPPED_MATERIAL_COUNT);
    // 配られたのは**同じ 1 枚**(平面を動かすと全材質へ一度に効く)。
    for (const material of clipped) {
      expect(material.clippingPlanes?.[0]).toBe(plane);
    }
    layer.dispose();
  });

  it('ボディが増えても、新しく作られた材質へ配り直す(配り漏らさない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -5);
    layer.setSectionPlanes([plane]);
    // 外観を割り当てて材質を新しく作らせる(P5 の材質の Map を通る道)。
    const appearance = buildAppearanceInput(
      tableOf([
        {
          id: 'appearance-1',
          target: { kind: 'face', ref: faceRef('extrude-2', 0) },
          appearance: coloredAppearance('#ff0000'),
        },
      ]),
      [],
    );
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', 2), makeBody('extrude-2', 3)], null, [], appearance),
      'shadedWithEdges',
    );
    for (const mesh of bodyMeshesOf(layer.group)) {
      for (const material of mesh.material) {
        expect(material.clippingPlanes?.[0]).toBe(plane);
      }
    }
    layer.dispose();
  });

  it('切ると空へ戻る(元の見た目に戻り、費用もゼロへ戻る)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.setSectionPlanes([new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]);
    layer.setSectionPlanes([]);
    for (const mesh of bodyMeshesOf(layer.group)) {
      for (const material of mesh.material) {
        expect(material.clippingPlanes).toEqual([]);
      }
    }
    layer.dispose();
  });

  it('入れても三角形も稜線も 1 つも変わらない(形を切らない、FR-111)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 3)], null, []), 'shadedWithEdges');
    const [mesh] = bodyMeshesOf(layer.group);
    const before = mesh.geometry.getAttribute('position');
    const beforeIndex = mesh.geometry.getIndex();
    layer.setSectionPlanes([new THREE.Plane(new THREE.Vector3(0, 0, 1), -1)]);
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    expect(mesh.geometry.getAttribute('position')).toBe(before);
    expect(mesh.geometry.getIndex()).toBe(beforeIndex);
    layer.dispose();
  });

  it('入切の所要は 1 コマ(16ms)に収まる(§2.17-7。ボディ 20 個)', () => {
    const layer = createSolidLayer();
    const bodies: SolidBodyWithSubShapes[] = [];
    for (let index = 0; index < 20; index += 1) {
      bodies.push(makeBody(`extrude-${String(index)}`, 6));
    }
    layer.update(buildSolidGeometry(bodies, null, []), 'shadedWithEdges');
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    const started = performance.now();
    layer.setSectionPlanes([plane]);
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    layer.setSectionPlanes([]);
    layer.updateSectionHandle(null);
    const elapsed = performance.now() - started;
    console.log(`断面表示の入切(ボディ 20 個): ${elapsed.toFixed(3)} ms`);
    expectWithinBudget(elapsed, FRAME_BUDGET_MS, '断面表示の入切');
    layer.dispose();
  });
});

describe('createSolidLayer(断面表示のつまみ、§0.42)', () => {
  it('つまみは四角(三角形 2 枚 = 6 頂点)で出る(切断の予告と同じ形)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    const handleFace = layer.group.children.find(
      (object) => object.visible && !isBodyMesh(object) && meshVertexCount(object) === 6,
    );
    expect(handleFace).toBeDefined();
    layer.dispose();
  });

  it('null を渡すと消える', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    const shown = layer.group.children.filter((object) => object.visible).length;
    layer.updateSectionHandle(null);
    expect(layer.group.children.filter((object) => object.visible).length).toBeLessThan(shown);
    layer.dispose();
  });

  it('ボディが 1 つも無くてもつまみは出る(掴めなくならない、NFR-UX-7)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'negative' });
    const shown = layer.group.children.filter(
      (object) => object instanceof THREE.Mesh && object.visible,
    );
    expect(shown.length).toBeGreaterThan(0);
    layer.dispose();
  });

  it('dispose() でつまみの材質も捨てる(WebGL の資源は GC で戻らない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 2)], null, []), 'shadedWithEdges');
    layer.updateSectionHandle({ plane: SECTION_HANDLE_PLANE, keep: 'positive' });
    let disposed = 0;
    const materials = allMaterialsOf(layer.group);
    for (const material of materials) {
      material.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    layer.dispose();
    expect(disposed).toBe(materials.length);
  });
});
/** 三角形の番号の一覧を、カーネルと同じ「下位ビットから」の詰め方でビット列にする。 */
function printBitsOf(triangleCount: number, marked: readonly number[]): Uint8Array {
  const bits = new Uint8Array(Math.ceil(triangleCount / 8));
  for (const triangle of marked) {
    bits[triangle >> 3] |= 1 << (triangle & 7);
  }
  return bits;
}

/** 検査用の点検の結果。層は要約を 1 つも読まないので、要約は型を満たすだけの値。 */
function printReportOf(
  triangleCount: number,
  marked: {
    readonly thin?: readonly number[];
    readonly overhang?: readonly number[];
    readonly openEdge?: readonly number[];
  } = {},
): PrintabilityReport {
  return {
    triangleCount,
    thinTriangles: printBitsOf(triangleCount, marked.thin ?? []),
    overhangTriangles: printBitsOf(triangleCount, marked.overhang ?? []),
    openEdgeTriangles: printBitsOf(triangleCount, marked.openEdge ?? []),
    summary: {
      triangleCount,
      degenerateCount: 0,
      inspectedTriangleCount: triangleCount,
      thinCount: marked.thin?.length ?? 0,
      overhangCount: marked.overhang?.length ?? 0,
      openEdgeCount: marked.openEdge?.length ?? 0,
      openEdgeTriangleCount: marked.openEdge?.length ?? 0,
      watertight: (marked.openEdge?.length ?? 0) === 0,
      minThicknessFoundMm: 20,
      minThicknessMm: 0.8,
      overhangAngleDeg: 45,
      cellSizeMm: 1.6,
    },
    cancelled: false,
  };
}

/** 立体 1 つを点検したときの、層へ渡す一式。 */
function printHighlightOf(
  featureId: string,
  triangleCount: number,
  report: PrintabilityReport,
): { readonly report: PrintabilityReport; readonly triangleOffsets: ReadonlyMap<string, number> } {
  return {
    report,
    triangleOffsets: printabilityTriangleOffsets([{ featureId, triangleCount }]),
  };
}

/** 層の中の「開いた辺の紫の線」の本数(見えているものだけ)。 */
function openEdgeLineCount(group: THREE.Object3D): number {
  let count = 0;
  for (const object of group.children) {
    if (!(object instanceof THREE.LineSegments) || !object.visible) {
      continue;
    }
    const material: unknown = object.material;
    const geometry: unknown = object.geometry;
    if (
      material instanceof THREE.LineBasicMaterial &&
      geometry instanceof THREE.BufferGeometry &&
      material.color.getHex() === DEFAULT_THEME_COLORS.printOpenEdge
    ) {
      const position: unknown = geometry.getAttribute('position');
      count += position instanceof THREE.BufferAttribute ? position.count / 2 : 0;
    }
  }
  return count;
}

describe('createSolidLayer(3D プリントの点検の色、FR-815、§0.53)', () => {
  it('点検を出すと 1 ボディ 3 材質(既定・赤・橙)になり、P5 の上限 8 に触れない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges');
    expect(bodyMeshesOf(layer.group)[0].material).toHaveLength(1);

    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 6, printReportOf(6, { thin: [1], overhang: [3] })),
    );

    const materials = bodyMeshesOf(layer.group)[0].material;
    expect(materials).toHaveLength(3);
    const colored = materials.map((material) =>
      material instanceof THREE.MeshStandardMaterial ? material.color.getHex() : null,
    );
    expect(colored[0]).toBe(DEFAULT_THEME_COLORS.solid);
    expect(colored[1]).toBe(DEFAULT_THEME_COLORS.printThin);
    expect(colored[2]).toBe(DEFAULT_THEME_COLORS.printOverhang);
    layer.dispose();
  });

  it('薄い三角形とせり出しの三角形が、それぞれの材質のまとまりになる', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [1], overhang: [2] })),
    );

    // 索引の単位(三角形 × 3)。0 = 既定、1 = 赤、2 = 橙、3 = 既定 の 4 つに割れる。
    const groups = bodyMeshesOf(layer.group)[0].geometry.groups;
    expect(groups.map((group) => [group.start, group.count, group.materialIndex])).toEqual([
      [0, 3, 0],
      [3, 3, 1],
      [6, 3, 2],
      [9, 3, 0],
    ]);
    layer.dispose();
  });

  it('閉じると元の外観に戻る(材質もまとまりも点検の前と同じ数)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges');
    const before = bodyMeshesOf(layer.group)[0].geometry.groups.length;

    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 6, printReportOf(6, { thin: [2] })),
    );
    expect(bodyMeshesOf(layer.group)[0].material).toHaveLength(3);

    layer.setPrintabilityHighlight(null);
    const mesh = bodyMeshesOf(layer.group)[0];
    expect(mesh.material).toHaveLength(1);
    expect(mesh.geometry.groups).toHaveLength(before);
    const material = mesh.material[0];
    expect(material instanceof THREE.MeshStandardMaterial ? material.color.getHex() : null).toBe(
      DEFAULT_THEME_COLORS.solid,
    );
    layer.dispose();
  });

  it('点検を頼まなかった立体は、点検の間も元の外観のまま', () => {
    const layer = createSolidLayer();
    layer.update(
      buildSolidGeometry([makeBody('extrude-1', 3), makeBody('extrude-2', 3)], null, []),
      'shadedWithEdges',
    );
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 3, printReportOf(3, { thin: [0] })),
    );

    const meshes = bodyMeshesOf(layer.group);
    expect(meshes[0].material).toHaveLength(3);
    expect(meshes[1].material).toHaveLength(1);
    layer.dispose();
  });

  it('三角形の数が点検の結果と噛み合わない立体には色を塗らない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 6)], null, []), 'shadedWithEdges');
    // 点検は 4 枚ぶんしか持っていないのに、画面には 6 枚ある(点検の後に形が変わった)。
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 6, printReportOf(4, { thin: [0] })),
    );

    expect(bodyMeshesOf(layer.group)[0].material).toHaveLength(1);
    layer.dispose();
  });

  it('開いた辺を持つ三角形の輪郭(3 辺)を紫の線で引き、閉じると消える', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    expect(openEdgeLineCount(layer.group)).toBe(0);

    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { openEdge: [1, 2] })),
    );
    // 三角形 2 枚 × 3 辺 = 線分 6 本。
    expect(openEdgeLineCount(layer.group)).toBe(6);

    layer.setPrintabilityHighlight(null);
    expect(openEdgeLineCount(layer.group)).toBe(0);
    layer.dispose();
  });

  it('閉じた形では紫の線を 1 本も引かない', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [0] })),
    );

    expect(openEdgeLineCount(layer.group)).toBe(0);
    layer.dispose();
  });

  it('点検の色にも断面表示の平面が配られる(切ったのに線だけ空中に残らない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [0], openEdge: [1] })),
    );
    layer.setSectionPlanes([new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)]);

    const untouched = allMaterialsOf(layer.group).filter(
      (material) => material.clippingPlanes === null,
    );
    expect(untouched).toHaveLength(UNCLIPPED_MATERIAL_COUNT);
    layer.dispose();
  });

  it('dispose() で点検の材質もすべて捨てる(WebGL の資源は GC で戻らない)', () => {
    const layer = createSolidLayer();
    layer.update(buildSolidGeometry([makeBody('extrude-1', 4)], null, []), 'shadedWithEdges');
    layer.setPrintabilityHighlight(
      printHighlightOf('extrude-1', 4, printReportOf(4, { thin: [0], overhang: [1], openEdge: [2] })),
    );
    let disposed = 0;
    const materials = allMaterialsOf(layer.group);
    for (const material of materials) {
      material.addEventListener('dispose', () => {
        disposed += 1;
      });
    }
    layer.dispose();
    expect(disposed).toBe(materials.length);
  });
});
