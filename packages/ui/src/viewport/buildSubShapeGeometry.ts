/**
 * ホバー・選択中の部分形状(面・辺・頂点)を、重ね描き用の並びへ組み立てる
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク22、§0.a-0.7、§0.a-0.23-⑩、§2.3.2)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-106(ホバー・選択の強調)、NFR-PF-1(60fps)。
 *
 * three.js にも DOM にも触れない純関数だけを置く(Node で検査できる。
 * `docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して検査する」)。
 * 組み立てた結果は `createSolidLayer.ts` の `updateSubShapes` が three.js の入れ物へ流し込む。
 *
 * **ボディの面メッシュはここでは組み替えない。** 強調する面の三角形だけを取り出した別の
 * 並びを作り(§0.a-0.7 の重ね描き)、元のボディの `positions` / `indices` はそのまま
 * `createSolidLayer.ts` の本体メッシュが使い続ける。
 */

import type { Vec3 } from '@pointercad/model';

import { parseSubShapeId } from '../solid/subShapeSelection.js';
import type { SolidEdgeEntry, SolidFaceEntry } from '../solid/subShapeSelection.js';

import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';

/** 強調の度合い。部分形状はボディと違い「無強調」を描く理由が無いので 2 つだけ。 */
export type SubShapeEmphasis = 'hovered' | 'selected';

/** 強調して描くもの 1 まとまり。位置の並びは three.js へそのまま渡せる形。 */
export interface SubShapeHighlight {
  readonly emphasis: SubShapeEmphasis;
  /** 面の三角形(位置・法線・頂点番号)。三角形どうしで頂点を共有しない(1 枚 9 個 × 三角形数)。無ければ長さ 0。 */
  readonly facePositions: Float32Array;
  readonly faceNormals: Float32Array;
  readonly faceIndices: Uint32Array;
  /** 辺の線分。1 本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly edgePositions: Float32Array;
  /** 頂点。1 個あたり 3 個。同じ座標は重複させない(§0.a-0.23-⑩)。 */
  readonly vertexPositions: Float32Array;
}

export interface SubShapeHighlightBundle {
  readonly hovered: SubShapeHighlight;
  readonly selected: SubShapeHighlight;
  /** ホバー・選択を合わせた強調中の三角形の合計(目視確認と将来の実測用)。 */
  readonly faceTriangleCount: number;
  readonly edgeCount: number;
  readonly vertexCount: number;
}

const EMPTY_FLOAT32 = new Float32Array(0);
const EMPTY_UINT32 = new Uint32Array(0);

const EMPTY_HOVERED_HIGHLIGHT: SubShapeHighlight = {
  emphasis: 'hovered',
  facePositions: EMPTY_FLOAT32,
  faceNormals: EMPTY_FLOAT32,
  faceIndices: EMPTY_UINT32,
  edgePositions: EMPTY_FLOAT32,
  vertexPositions: EMPTY_FLOAT32,
};

const EMPTY_SELECTED_HIGHLIGHT: SubShapeHighlight = {
  emphasis: 'selected',
  facePositions: EMPTY_FLOAT32,
  faceNormals: EMPTY_FLOAT32,
  faceIndices: EMPTY_UINT32,
  edgePositions: EMPTY_FLOAT32,
  vertexPositions: EMPTY_FLOAT32,
};

/** 何も強調していないとき。起動直後と、ホバー・選択のどちらも部分形状でないときに使う。 */
export const EMPTY_SUB_SHAPE_HIGHLIGHT: SubShapeHighlightBundle = {
  hovered: EMPTY_HOVERED_HIGHLIGHT,
  selected: EMPTY_SELECTED_HIGHLIGHT,
  faceTriangleCount: 0,
  edgeCount: 0,
  vertexCount: 0,
};

/** 組み立て中の下書き。emphasis ごとに 1 つ持つ。 */
interface Accumulator {
  readonly facePositions: number[];
  readonly faceNormals: number[];
  readonly faceIndices: number[];
  /** `faceIndices` の次の番号(三角形どうしで頂点を共有しないので、積むたびに増やすだけ)。 */
  nextFaceIndex: number;
  readonly edgePositions: number[];
  readonly vertexPositions: number[];
  /** 頂点の重複を除くための鍵(§0.a-0.23-⑩「重複を除いて」)。 */
  readonly vertexKeys: Set<string>;
}

function createAccumulator(): Accumulator {
  return {
    facePositions: [],
    faceNormals: [],
    faceIndices: [],
    nextFaceIndex: 0,
    edgePositions: [],
    vertexPositions: [],
    vertexKeys: new Set<string>(),
  };
}

/** 一覧から通し番号の合う 1 件を引く。`subShapeSelection.ts` の `entryAt` と同じ考え方。 */
function findByIndex<T extends { readonly index: number }>(
  entries: readonly T[],
  index: number,
): T | null {
  const direct = entries[index];
  if (direct !== undefined && direct.index === index) {
    return direct;
  }
  return entries.find((entry) => entry.index === index) ?? null;
}

/** 頂点 1 つを積む。同じ座標が既にあれば足さない(重複を除く)。 */
function addVertex(acc: Accumulator, position: Vec3): void {
  const key = `${position[0]},${position[1]},${position[2]}`;
  if (acc.vertexKeys.has(key)) {
    return;
  }
  acc.vertexKeys.add(key);
  acc.vertexPositions.push(position[0], position[1], position[2]);
}

/**
 * 面 1 枚の三角形を積む。`face.triangleOffset` / `triangleCount` の範囲を、
 * ボディの `indices` / `positions` / `normals` から切り出す。
 *
 * 範囲表が並びの外を指していても落ちないよう、必ず配列の中へ丸める
 * (`pickSubShape.ts` の辺の扱いと同じ考え方。上流が変わって三角形が減った直後など)。
 */
function addFace(acc: Accumulator, body: SolidBodyWithSubShapes, face: SolidFaceEntry): void {
  const { positions, normals, indices } = body.mesh;
  const begin = Math.max(0, face.triangleOffset * 3);
  const end = Math.min(begin + Math.max(0, face.triangleCount) * 3, indices.length);
  for (let offset = begin; offset < end; offset += 1) {
    const vertexIndex = indices[offset];
    const base = vertexIndex * 3;
    if (base + 2 >= positions.length || base + 2 >= normals.length) {
      continue;
    }
    acc.facePositions.push(positions[base], positions[base + 1], positions[base + 2]);
    acc.faceNormals.push(normals[base], normals[base + 1], normals[base + 2]);
    acc.faceIndices.push(acc.nextFaceIndex);
    acc.nextFaceIndex += 1;
  }
}

/**
 * 辺 1 本の線分を積む。`includeEndpoints` のときだけ両端を頂点として積む
 * (選択の辺だけに端点を出す。§0.a-0.23-⑩「ホバー中の辺は端点の点を出さない」)。
 */
function addEdge(
  acc: Accumulator,
  body: SolidBodyWithSubShapes,
  edge: SolidEdgeEntry,
  includeEndpoints: boolean,
): void {
  const positions = body.mesh.edgePositions;
  const begin = Math.max(0, edge.segmentOffset * 6);
  const end = Math.min(begin + Math.max(0, edge.segmentCount) * 6, positions.length);
  for (let offset = begin; offset + 5 < end; offset += 6) {
    for (let component = 0; component < 6; component += 1) {
      acc.edgePositions.push(positions[offset + component]);
    }
  }
  if (includeEndpoints) {
    addVertex(acc, edge.start);
    addVertex(acc, edge.end);
  }
}

/** 1 つの要素 id を、見つかったボディ・部分形状に応じて積む。見つからなければ黙って飛ばす。 */
function addElement(
  bodies: readonly SolidBodyWithSubShapes[],
  elementId: string,
  acc: Accumulator,
  includeEndpoints: boolean,
): void {
  const parsed = parseSubShapeId(elementId);
  if (parsed === null) {
    return;
  }
  const body = bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId);
  if (body === undefined) {
    return;
  }
  switch (parsed.kind) {
    case 'face': {
      const face = findByIndex(body.faces ?? [], parsed.index);
      if (face !== null) {
        addFace(acc, body, face);
      }
      return;
    }
    case 'edge': {
      const edge = findByIndex(body.edges ?? [], parsed.index);
      if (edge !== null) {
        addEdge(acc, body, edge, includeEndpoints);
      }
      return;
    }
    case 'vertex': {
      const vertex = findByIndex(body.vertices ?? [], parsed.index);
      if (vertex !== null) {
        addVertex(acc, vertex.position);
      }
      return;
    }
  }
}

function finalize(emphasis: SubShapeEmphasis, acc: Accumulator): SubShapeHighlight {
  if (acc.facePositions.length === 0 && acc.edgePositions.length === 0 && acc.vertexPositions.length === 0) {
    return emphasis === 'hovered' ? EMPTY_HOVERED_HIGHLIGHT : EMPTY_SELECTED_HIGHLIGHT;
  }
  return {
    emphasis,
    facePositions: Float32Array.from(acc.facePositions),
    faceNormals: Float32Array.from(acc.faceNormals),
    faceIndices: Uint32Array.from(acc.faceIndices),
    edgePositions: Float32Array.from(acc.edgePositions),
    vertexPositions: Float32Array.from(acc.vertexPositions),
  };
}

/**
 * ホバーと選択の部分形状を、描くための並びへ組み立てる(§0.a-0.7)。
 *
 * - 番号が範囲の外の参照(上流が変わって面が減った等)は**黙って飛ばす**。
 * - スケッチ要素の id(`point-1#3`)や、部分形状でないボディの id は `parseSubShapeId` が
 *   null を返すのでそのまま飛ばされる。
 * - **選択とホバーが同じものを指していたら、選択だけに入れる**(二重描きを避ける)。
 * - 端点の点(§0.a-0.23-⑩)は**選択の辺だけ**に付け、ホバーの辺には付けない。
 */
export function buildSubShapeGeometry(
  bodies: readonly SolidBodyWithSubShapes[],
  hoveredElementId: string | null,
  selection: readonly string[],
): SubShapeHighlightBundle {
  const selectedAcc = createAccumulator();
  for (const elementId of selection) {
    addElement(bodies, elementId, selectedAcc, true);
  }

  const hoveredAcc = createAccumulator();
  if (hoveredElementId !== null && !selection.includes(hoveredElementId)) {
    addElement(bodies, hoveredElementId, hoveredAcc, false);
  }

  const hovered = finalize('hovered', hoveredAcc);
  const selected = finalize('selected', selectedAcc);

  if (hovered === EMPTY_HOVERED_HIGHLIGHT && selected === EMPTY_SELECTED_HIGHLIGHT) {
    return EMPTY_SUB_SHAPE_HIGHLIGHT;
  }

  return {
    hovered,
    selected,
    faceTriangleCount: (hovered.faceIndices.length + selected.faceIndices.length) / 3,
    edgeCount: (hovered.edgePositions.length + selected.edgePositions.length) / 6,
    vertexCount: (hovered.vertexPositions.length + selected.vertexPositions.length) / 3,
  };
}
