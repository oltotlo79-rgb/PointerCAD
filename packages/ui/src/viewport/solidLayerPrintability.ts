/**
 * 立体の表示層のうち、3D プリントの点検の色の責務(FR-815)。
 *
 * **外観を上書きせず、割り当てを一時的に差し替えるだけ**にする。点検を頼んだ立体は外観の割り当てを
 * 無視して 3 材質(既定 + 赤 + 橙)で描かれ、開いた辺を持つ三角形の輪郭が紫の線で重なる。点検を閉じれば
 * 元の外観に戻る(形も体積も一切変わらず、再計算も起きない)。材質そのものは材質の入れ物が鍵で
 * 持っているので、出し入れで作り直しは起きない。
 */
import { DEFAULT_APPEARANCE, type AppearanceSpec } from '@pointercad/model';
import * as THREE from 'three';

import type { FaceGroup } from '../appearance/buildFaceGroups.js';
import { buildPrintabilityGroups, buildPrintabilityOpenEdgePositions, printabilityAppearances } from '../solid/printabilityColors.js';
import type { SolidDrawEntry } from './buildSolidGeometry.js';
import type { PrintabilityHighlight } from './createSolidLayer.js';
import { disposeBorrowedGeometry, setVectorAttribute } from './solidLayerBuffers.js';
import { SUB_SHAPE_LINE_RENDER_ORDER } from './solidLayerRenderOrder.js';
import { cssColor, DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/**
 * 開いた辺の線の色の濃さ。**面より手前に出す**(`depthTest: false`)ので、そのままだと
 * 形の中の辺まで全部見えて絵が潰れる。薄くして「向こう側にもある」と読めるようにする。
 */
const PRINT_OPEN_EDGE_OPACITY = 0.85;

/** 点検の色を出しているあいだの、立体 1 つぶんのまとまりと材質。 */
export interface PrintabilityPlan {
  /** 作ったときの三角形の枚数。形が作り直されたら組み直す目印。 */
  readonly triangleCount: number;
  readonly groups: readonly FaceGroup[];
  /** 既定 + 赤 + 橙 の 3 つ。ボディをまたいで同じ配列を使い回す(参照で比べられる)。 */
  readonly appearances: readonly AppearanceSpec[];
}

/** 開いた辺の紫の線、ボディ 1 つぶん。並びと結果が同じなら引き直さない。 */
interface PrintOpenEdgeDraw {
  readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  positions: Float32Array;
  indices: Uint32Array;
  report: PrintabilityHighlight['report'];
  triangleOffset: number;
  triangleCount: number;
}

interface SolidPrintabilityOptions {
  readonly group: THREE.Group;
  /** 層の作りかけの資源の持ち主へ預ける(作る途中で失敗しても捨てられる)。 */
  readonly acquired: <T extends { dispose(): void }>(resource: T) => T;
  readonly getColors: () => ThemeColors;
}

/** 1 つの層の点検の色。返す関数はどれも層の持ち主(`createSolidLayer`)だけが呼ぶ。 */
export function createSolidPrintability(options: SolidPrintabilityOptions) {
  const { group, acquired, getColors } = options;
  /*
    開いた辺は body 別の local 配列と Double origin で描く。材質だけ共有し、遠方の世界座標を
    Float32 頂点へ焼き込まない。面に隠れた辺も見えるよう `depthTest: false` にする——開いているところは
    形の裏側にあることが多く、隠したのでは「どこが閉じていないか」を探せない(NFR-UX-7)。

    **線の太さは指定しない。** WebGL の線幅はほとんどの環境で 1 画素に固定されており、
    `LineBasicMaterial.linewidth` は効かない(three.js の既知の制限)。太さの代わりに**三角形の輪郭
    3 辺すべてを引く**ことで面として目立たせる(`buildPrintabilityOpenEdgePositions` の注釈)。
  */
  const material = acquired(new THREE.LineBasicMaterial({
    color: DEFAULT_THEME_COLORS.printOpenEdge,
    transparent: true,
    opacity: PRINT_OPEN_EDGE_OPACITY,
    depthTest: false,
    depthWrite: false,
  }));
  const openEdgeDraws = new Map<string, PrintOpenEdgeDraw>();
  /** いま出している点検の色。`null` なら外観のまま(点検を閉じた状態)。 */
  let highlight: PrintabilityHighlight | null = null;
  /**
   * 点検の間の 3 つの外観。**テーマの色が変わるまで作り直さない**——毎回作ると
   * 参照で比べる外観の一覧が必ず食い違い、ホバーのたびに材質を組み直すことになる(NFR-PF-1)。
   */
  let appearanceSet: readonly AppearanceSpec[] | null = null;
  /** 立体ごとのまとまりの控え。三角形の枚数ぶん走る計算なので、毎コマは繰り返さない。 */
  const plans = new Map<string, PrintabilityPlan>();

  /** 点検の色の控えを捨てる(点検の出し入れ・テーマの切替のとき)。 */
  function clearCache(): void {
    appearanceSet = null;
    plans.clear();
  }

  /** 点検の間の 3 つの外観(既定 + 赤 + 橙)。控えがあればそれを返す。 */
  function specs(): readonly AppearanceSpec[] {
    if (appearanceSet === null) {
      // 既定は `DEFAULT_APPEARANCE` のまま渡す。テーマの立体の色は、材質を作る直前の
      // `themedAppearance` が当てる(外観を割り当てていない立体とまったく同じ道)。
      const colors = getColors();
      appearanceSet = printabilityAppearances(
        DEFAULT_APPEARANCE,
        cssColor(colors.printThin),
        cssColor(colors.printOverhang),
      );
    }
    return appearanceSet;
  }

  /**
   * 立体 1 つの点検の色の割り当て。点検を出していない・その立体を点検していない・
   * 三角形の並びが結果と噛み合わないときは `null`(元の外観のまま描く)。
   */
  function planFor(entry: SolidDrawEntry): PrintabilityPlan | null {
    if (highlight === null) {
      return null;
    }
    const triangleOffset = highlight.triangleOffsets.get(entry.featureId);
    if (triangleOffset === undefined) {
      return null;
    }
    const cached = plans.get(entry.featureId);
    if (cached !== undefined && cached.triangleCount === entry.triangleCount) {
      return cached;
    }
    const groups = buildPrintabilityGroups(highlight.report, triangleOffset, entry.triangleCount);
    if (groups.length === 0) {
      // 数が噛み合わなかった(点検の後に形が変わった等)。関係の無い面を赤くしない。
      return null;
    }
    const plan: PrintabilityPlan = { triangleCount: entry.triangleCount, groups, appearances: specs() };
    plans.set(entry.featureId, plan);
    return plan;
  }

  function clearOpenEdges(): void {
    for (const draw of openEdgeDraws.values()) {
      group.remove(draw.lines);
      disposeBorrowedGeometry(draw.lines.geometry);
    }
    openEdgeDraws.clear();
  }

  /** 開いた辺の紫の線を 1 ボディぶん引き直す(並びと結果が前回と同じなら引き直さない)。 */
  function refreshOpenEdgeDraw(current: PrintabilityHighlight, key: string, entry: SolidDrawEntry,
    triangleOffset: number): PrintOpenEdgeDraw | null {
    let draw = openEdgeDraws.get(key);
    if (draw !== undefined && draw.positions === entry.positions && draw.indices === entry.indices
      && draw.report === current.report && draw.triangleOffset === triangleOffset
      && draw.triangleCount === entry.triangleCount) {
      return draw;
    }
    const positions = buildPrintabilityOpenEdgePositions(
      entry.positions, entry.indices, current.report, triangleOffset, entry.triangleCount,
    );
    if (positions.length === 0) return null;
    if (draw === undefined) {
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      lines.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
      draw = { lines, positions: entry.positions, indices: entry.indices,
        report: current.report, triangleOffset, triangleCount: entry.triangleCount };
      openEdgeDraws.set(key, draw);
      group.add(lines);
    }
    setVectorAttribute(draw.lines.geometry, 'position', positions);
    draw.lines.geometry.computeBoundingSphere();
    draw.positions = entry.positions;
    draw.indices = entry.indices;
    draw.report = current.report;
    draw.triangleOffset = triangleOffset;
    draw.triangleCount = entry.triangleCount;
    return draw;
  }

  /**
   * 開いた辺の紫の線を body 別に更新する。origin だけの変更は配列を作り直さない。
   * 点検の取消・body 削除時は GPU と CPU 配列への参照をともに解放する。
   */
  function rebuildOpenEdges(entries: readonly SolidDrawEntry[]): void {
    const current = highlight;
    if (current === null) {
      clearOpenEdges();
      return;
    }
    const active = new Set<string>();
    const occurrences = new Map<string, number>();
    for (const entry of entries) {
      // Keep separate frames even for repeated IDs in a directly supplied bundle.
      const occurrence = occurrences.get(entry.featureId) ?? 0;
      occurrences.set(entry.featureId, occurrence + 1);
      const key = JSON.stringify([entry.featureId, occurrence]);
      const triangleOffset = current.triangleOffsets.get(entry.featureId);
      if (triangleOffset === undefined) {
        continue;
      }
      const draw = refreshOpenEdgeDraw(current, key, entry, triangleOffset);
      if (draw === null) continue;
      const origin = entry.coordinateFrame?.origin ?? [0, 0, 0];
      draw.lines.position.set(origin[0], origin[1], origin[2]);
      active.add(key);
    }
    for (const [key, draw] of openEdgeDraws) {
      if (active.has(key)) continue;
      group.remove(draw.lines);
      disposeBorrowedGeometry(draw.lines.geometry);
      openEdgeDraws.delete(key);
    }
    group.updateMatrixWorld(true);
  }

  return {
    /** 開いた辺の線の材質(断面表示の平面を配る相手、破棄の相手)。 */
    material,
    planFor,
    rebuildOpenEdges,
    /** 点検の色を差し替える。前と同じなら false(何もしない)。 */
    set(next: PrintabilityHighlight | null): boolean {
      if (next === highlight) return false;
      highlight = next;
      clearCache();
      return true;
    },
    /** テーマの色。赤・橙は材質の鍵に色が入っているので、控えを捨てて次の反映で作り直す。 */
    applyTheme(colors: ThemeColors): void {
      material.color.setHex(colors.printOpenEdge);
      clearCache();
    },
    /** 破棄で解放する開いた辺の形。 */
    openEdgeGeometries(): THREE.BufferGeometry[] {
      return [...openEdgeDraws.values()].map((draw) => draw.lines.geometry);
    },
    /** 破棄の終わりに、線と控えを空にする。 */
    reset(): void {
      openEdgeDraws.clear();
      highlight = null;
      clearCache();
    },
  };
}
