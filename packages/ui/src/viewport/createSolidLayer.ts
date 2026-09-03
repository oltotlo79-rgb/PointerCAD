/**
 * ソリッド(立体)の表示層(計画書 docs/plans/P2-ソリッド基礎.md タスク20 手順3)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-106(ホバー・選択・当たり判定)、NFR-PF-1(60fps)。
 *
 * `buildSolidGeometry` が組み立てた並びを three.js の部品へ流し込む。**毎フレーム
 * 作り直さない**。同じ組み立て結果を渡し直したときは何もせず、ボディの並びが同じ
 * (同じ Float32Array)なら入れ物も触らない。個数が同じで中身だけ変わったときは
 * 並びの中身を書き写す。常時の描画ループはここにも作らない
 * (docs/報告記録.md 2026-09-02 15:42)。
 *
 * 色は画面の配色(packages/ui/src/shell/appShell.css の --pcad-* トークン)と同じ値を
 * 16 進の定数として持つ。CSS 変数は three.js から読めないため。
 */

import * as THREE from 'three';

import type { DisplayStyle } from '../store/useAppStore.js';
import type { SolidDrawEntry, SolidEmphasis, SolidGeometryBundle } from './buildSolidGeometry.js';

/**
 * 立体の色味。艶を抑えた樹脂のような明るい灰にして、面の向きの差を読み取りやすくする。
 * P2 のボディは既定の 1 色(§0.a-0.21)。面ごと・ボディごとの色指定は P3 の「外観」で足す。
 */
const SOLID_COLOR = 0xb8bfcc;
const SOLID_ROUGHNESS = 0.55;
const SOLID_METALNESS = 0.05;

/** 面の上に重ねる稜線は暗く、稜線だけのときは背景から浮くよう明るくする(FR-105)。 */
const EDGE_COLOR_OVER_SOLID = 0x0f1115;
const EDGE_COLOR_WIREFRAME = 0xd6dae2;

/**
 * 選択の色 = --pcad-accent。ホバーはその一段薄い --pcad-accent-hover(NFR-UX-7)。
 * スケッチの強調(createSketchLayer.ts)と同じ配色にして、選び方を覚え直させない。
 */
const SELECTED_COLOR = 0x4f8cff;
const HOVERED_COLOR = 0x6b9eff;

/**
 * 描く順。スケッチの作図面 -1 → 面 0 → **立体 1** → 面の縁 2 → 線 3 → 点 4 の間に入れる。
 *
 * 立体の面と稜線は不透明なので、three.js は半透明のもの(方眼・作図面・スケッチの面・
 * 線・点)より**先に**描く。そのうえでスケッチの線と点は `depthTest: false` なので、
 * 立体の奥にあっても隠れずに前面へ出る(docs/報告記録.md 2026-09-03 00:06 の (b))。
 * renderOrder は不透明どうしの順序を決めるだけだが、層の前後関係を 1 箇所で
 * 読み取れるようにスケッチと同じ数直線の上へ置いておく。
 */
const SOLID_RENDER_ORDER = 1;

type SolidMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
type SolidEdges = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/** ボディ 1 つぶんの部品。並びは前回と同じかどうかを参照で見分けられるよう控えておく。 */
interface BodyDraw {
  featureId: string;
  positions: Float32Array | null;
  indices: Uint32Array | null;
  edgePositions: Float32Array | null;
  readonly mesh: SolidMesh;
  readonly edges: SolidEdges;
}

export interface SolidLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 描画データと表示スタイルを反映する。
   * 同じ組み立て結果(同一オブジェクト)を渡し直したときは並びを触らない。
   */
  update(bundle: SolidGeometryBundle, displayStyle: DisplayStyle): void;
  /** 光線に当たったボディの featureId。当たらなければ null(FR-106)。 */
  pickBody(raycaster: THREE.Raycaster): string | null;
  dispose(): void;
}

/**
 * 並びを差し替える。**同じ並び(同じ入れ物)なら何もせず**、個数が同じなら書き写すだけに
 * して毎回の作り直しを避ける(NFR-PF-1)。個数が変わったときだけ新しい入れ物を作る。
 */
function setVectorAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  values: Float32Array,
): void {
  const existing = geometry.getAttribute(name);
  if (existing instanceof THREE.BufferAttribute && existing.array instanceof Float32Array) {
    if (existing.array === values) {
      return;
    }
    if (existing.array.length === values.length) {
      existing.array.set(values);
      existing.needsUpdate = true;
      return;
    }
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
}

/** 三角形の頂点番号を差し替える。考え方は `setVectorAttribute` と同じ。 */
function setIndices(geometry: THREE.BufferGeometry, values: Uint32Array): void {
  const existing = geometry.getIndex();
  if (existing !== null && existing.array instanceof Uint32Array) {
    if (existing.array === values) {
      return;
    }
    if (existing.array.length === values.length) {
      existing.array.set(values);
      existing.needsUpdate = true;
      return;
    }
  }
  geometry.setIndex(new THREE.BufferAttribute(values, 1));
}

export function createSolidLayer(): SolidLayer {
  const group = new THREE.Group();

  /**
   * 面の材質は全ボディで 1 つを共有する(P2 のボディは同じ色、§0.a-0.21)。
   * 面と稜線を同時に出すとき、稜線が面に埋もれてちらつくのを防ぐ(FR-105)。
   */
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: SOLID_COLOR,
    roughness: SOLID_ROUGHNESS,
    metalness: SOLID_METALNESS,
    // 閉じた立体なので裏面は見えない。両面を描くと稜線の裏側が透けて見えて重くなる。
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  /**
   * 稜線の材質は強調の度合いごとに 1 つずつ。ボディごとには作らず、
   * どれを使うかだけを切り替える(ボディが増えても材質は 3 つのまま)。
   * `none` の色だけは表示スタイルで変わる(面の上か、稜線だけか)。
   */
  const edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>> = {
    none: new THREE.LineBasicMaterial({ color: EDGE_COLOR_OVER_SOLID }),
    hovered: new THREE.LineBasicMaterial({ color: HOVERED_COLOR }),
    selected: new THREE.LineBasicMaterial({ color: SELECTED_COLOR }),
  };

  const draws: BodyDraw[] = [];
  /** 当たり判定にかける面。`draws` と同じ順に並ぶ。 */
  const pickTargets: THREE.Object3D[] = [];
  /** 当たった面 → ボディの id。userData は型が any になるので Map で持つ。 */
  const idByObject = new Map<THREE.Object3D, string>();

  let lastBundle: SolidGeometryBundle | null = null;

  function createDraw(): BodyDraw {
    const mesh: SolidMesh = new THREE.Mesh(new THREE.BufferGeometry(), faceMaterial);
    mesh.renderOrder = SOLID_RENDER_ORDER;
    const edges: SolidEdges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      edgeMaterials.none,
    );
    edges.renderOrder = SOLID_RENDER_ORDER;
    group.add(mesh);
    group.add(edges);
    return {
      featureId: '',
      positions: null,
      indices: null,
      edgePositions: null,
      mesh,
      edges,
    };
  }

  function disposeDraw(draw: BodyDraw): void {
    group.remove(draw.mesh);
    group.remove(draw.edges);
    draw.mesh.geometry.dispose();
    draw.edges.geometry.dispose();
  }

  /** ボディ 1 つぶんの形を反映する。前回と同じ並びなら何もしない。 */
  function applyGeometry(draw: BodyDraw, entry: SolidDrawEntry): void {
    if (
      draw.featureId === entry.featureId &&
      draw.positions === entry.positions &&
      draw.indices === entry.indices &&
      draw.edgePositions === entry.edgePositions
    ) {
      return;
    }
    setVectorAttribute(draw.mesh.geometry, 'position', entry.positions);
    setVectorAttribute(draw.mesh.geometry, 'normal', entry.normals);
    setIndices(draw.mesh.geometry, entry.indices);
    // 位置が変われば包む球も変わるので、視錐台の外と誤判定されないよう作り直す。
    // 当たり判定(Raycaster)もこの球で粗く絞るため、必ず取り直す。
    draw.mesh.geometry.computeBoundingSphere();
    setVectorAttribute(draw.edges.geometry, 'position', entry.edgePositions);
    draw.edges.geometry.computeBoundingSphere();
    draw.featureId = entry.featureId;
    draw.positions = entry.positions;
    draw.indices = entry.indices;
    draw.edgePositions = entry.edgePositions;
  }

  /** 部品の数をボディの数に合わせ、形を流し込む。 */
  function syncDraws(entries: readonly SolidDrawEntry[]): void {
    while (draws.length > entries.length) {
      const draw = draws.pop();
      if (draw !== undefined) {
        disposeDraw(draw);
      }
    }
    while (draws.length < entries.length) {
      draws.push(createDraw());
    }
    pickTargets.length = 0;
    idByObject.clear();
    for (let position = 0; position < entries.length; position += 1) {
      const draw = draws[position];
      const entry = entries[position];
      applyGeometry(draw, entry);
      pickTargets.push(draw.mesh);
      idByObject.set(draw.mesh, entry.featureId);
    }
  }

  /**
   * 表示スタイルと強調を材質へ写す(FR-105、FR-106)。
   *
   * シェーディング = 面のみ / シェーディング+エッジ = 面と稜線 / ワイヤーフレーム = 稜線のみ。
   * ただし**ホバー中・選択中のボディの稜線は、面のみの表示でも出す**。稜線でしか強調を
   * 示さない決まり(§0.a-0.21「面の色は変えない」)なので、面のみの表示で稜線を全部消すと
   * 何を選んでいるのか分からなくなるため(NFR-UX-7)。
   */
  function applyStyle(entries: readonly SolidDrawEntry[], displayStyle: DisplayStyle): void {
    const showFaces = displayStyle !== 'wireframe';
    const showEdges = displayStyle !== 'shaded';
    edgeMaterials.none.color.setHex(
      displayStyle === 'wireframe' ? EDGE_COLOR_WIREFRAME : EDGE_COLOR_OVER_SOLID,
    );
    for (let position = 0; position < entries.length; position += 1) {
      const draw = draws[position];
      const entry = entries[position];
      draw.mesh.visible = showFaces && entry.triangleCount > 0;
      draw.edges.visible =
        (showEdges || entry.emphasis !== 'none') && entry.edgeCount > 0;
      draw.edges.material = edgeMaterials[entry.emphasis];
    }
  }

  return {
    group,

    update(bundle, displayStyle): void {
      if (bundle !== lastBundle) {
        lastBundle = bundle;
        syncDraws(bundle.entries);
      }
      applyStyle(bundle.entries, displayStyle);
    },

    pickBody(raycaster): string | null {
      // 近い順に並ぶので先頭が手前のボディ。表示スタイルで面を隠していても当たる
      // (three.js の Raycaster は visible を見ない)ため、ワイヤーフレーム表示でも選べる。
      const hits = raycaster.intersectObjects(pickTargets, false);
      for (const hit of hits) {
        const featureId = idByObject.get(hit.object);
        if (featureId !== undefined) {
          return featureId;
        }
      }
      return null;
    },

    dispose(): void {
      for (const draw of draws) {
        disposeDraw(draw);
      }
      draws.length = 0;
      pickTargets.length = 0;
      idByObject.clear();
      faceMaterial.dispose();
      edgeMaterials.none.dispose();
      edgeMaterials.hovered.dispose();
      edgeMaterials.selected.dispose();
      lastBundle = null;
    },
  };
}
