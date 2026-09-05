/**
 * 拘束の印(記号の小さな札)の表示層
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク13、§0.a-0.7 の①、FR-313、NFR-UX-7)。
 *
 * 利用者の決定(§0.a-0.7 の①)は「要素の脇に `⊥` `∥` `=` `H` `V` などの記号を**常時**出す」。
 * 記号そのものは `constraintSummary.ts` の `symbol`(1 文字)で、ここはそれを 3D の中へ
 * **画面上で一定の大きさ**で置く仕事だけをする。
 *
 * **記号 1 つあたり 1 つの `Mesh` を作らない**(計画書の落とし穴「拘束が 200 個あれば印も
 * 200 個」)。同じ記号・同じ状態の印は 1 つの `THREE.Points` にまとめ、記号の絵を
 * `PointsMaterial.map` に貼る。`sizeAttenuation: false` なので**大きさは画素で決まり**、
 * 視点を回しても寄っても同じ大きさで正面を向く(ビルボード)。描画の呼び出しは
 * 「出ている記号 × 状態」の種類ぶん(実際は 1〜4 個)で、印の数には比例しない(NFR-PF-1)。
 *
 * 色は `themeColors.ts` のトークンから読む。ビューキューブの面に固定色を焼き込んで
 * テーマに追従しなかった失敗(docs/報告記録.md 2026-09-04 15:40)を繰り返さないため、
 * ここには 16 進の色を書かない(既定値の後退先は `themeColors.ts` の 1 か所)。
 */

import * as THREE from 'three';

import type { ConstraintMark } from '../sketch/constraintPicking.js';
import { cssColor, DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/** 印の大きさ(画素)。スケッチの点(5 画素)より大きく、読める最小の大きさにする。 */
export const MARK_SIZE_PIXELS = 16;

/** 選ばれている印を大きくする倍率(一覧の行を押したときに 3D で光らせる)。 */
const SELECTED_SCALE = 1.6;

/**
 * 記号の絵の細かさ。**表示の大きさの 2 倍**にとどめる。
 * これより細かく描くと、画面へ縮めるときの補間で線が薄まり、地の色に溶けて読めなくなる
 * (実測 2026-09-05: 64 画素で描いた `H` は明るいテーマで #0f766e が #45b5af まで
 * 薄まっていた)。高 DPI の画面でも 2 倍あれば輪郭は保てる。
 */
const TEXTURE_SCALE = 2;

/**
 * 絵の 1 辺の画素数の上限。ずらし量(`MARK_SPREAD_PIXELS` × 重なった数)が大きいほど
 * 四角も大きくなるので、描画側(`gl_PointSize`)の実装上の上限に近づかないよう頭を打つ。
 * 256 は「1 か所に 14 個の印が重なる」までを描ける大きさ(16 + 2×13×9 = 250)。
 */
const MAX_QUAD_PIXELS = 256;

/** 絵の中の文字の大きさ(1 辺に対する割合)。記号は 1 文字なので大きめに取れる。 */
const GLYPH_RATIO = 0.78;

/**
 * 記号の線を太らせる量(絵の 1 辺に対する割合)。`∥` `=` のように細い線でできた記号は、
 * 塗るだけだと縮めたときに消えてしまうので、同じ色で縁取って太らせる。
 */
const GLYPH_STROKE_RATIO = 0.05;

/**
 * 描く順。案内線(1)・下書きの線(3)・点(4)より手前に出す。印は要素の脇に置くもので、
 * 線に隠れると読めないため。深度は見ない(`depthTest: false`)ので前後はこの数で決まる。
 */
const MARK_RENDER_ORDER = 5;

/** 状態ごとの色の欄(`ThemeColors`)。`ConstraintMark.state` を網羅する。 */
const STATE_COLOR_FIELDS: Readonly<Record<ConstraintMark['state'], keyof ThemeColors>> = {
  ok: 'constraintOk',
  conflicting: 'constraintConflict',
  redundant: 'constraintRedundant',
  // 指している要素が消えた拘束は「直さないと効かない」ので、矛盾と同じ赤で出す。
  dangling: 'constraintConflict',
};

/**
 * 印の色(`ThemeColors` のどの欄を使うか)。**「固定」だけは状態に関わらず鍵の色**
 * (§0.a-0.7 の②「動かない点」を色で見分ける。統括の指示「満たしている / 冗長は薄い /
 * 矛盾は赤 / 動かない点は鍵」)。ただし矛盾・材料切れは直す必要があるので赤を優先する。
 */
export function markColorField(mark: ConstraintMark, fixedSymbol: string): keyof ThemeColors {
  if (mark.state === 'ok' && mark.symbol === fixedSymbol) {
    return 'constraintFixed';
  }
  return STATE_COLOR_FIELDS[mark.state];
}

/**
 * まとめて描く単位の鍵(記号 + 色 + 強調 + ずらし量)。
 *
 * ずらし量(P4b タスク22b)を鍵に含めるのは、**ずらしを記号の絵の中に焼き込む**ため。
 * `PointsMaterial` は点 1 つずつに画面上のずれを持たせられないので、四角を
 * 「表示の大きさ + ずらし量の 2 倍」まで広げ、その中で記号を中心からずらして描く。
 * 四角の大きさは画素で決まる(`sizeAttenuation: false`)ので、ずれも画素で正確に効く。
 * ずらし量の種類は実際には数種類しか出ないので、描画の呼び出しはほとんど増えない。
 */
function batchKey(
  symbol: string,
  color: number,
  selected: boolean,
  offset: readonly [number, number],
): string {
  return `${symbol}|${color.toString(16)}|${selected ? 's' : 'n'}|${String(offset[0])},${String(offset[1])}`;
}

/** ずらし量まで含めた四角の 1 辺(画素)。中心から `offset` だけ動かしても入る大きさ。 */
export function quadPixelsFor(markPixels: number, offset: readonly [number, number]): number {
  const reach = Math.max(Math.abs(offset[0]), Math.abs(offset[1]));
  return Math.min(MAX_QUAD_PIXELS, markPixels + 2 * reach);
}

/**
 * 記号 1 文字を描いた絵。文字の大きさは絵の中で決め打ちで、画面上の大きさは
 * `PointsMaterial.size`(画素)が決める。
 *
 * 絵を描けない場面(検査用の見えない画面など)では null を返し、印を出さずに済ませる
 * (`createReferenceLayer.ts` の名前の札と同じ扱い。線と点は出る)。
 */
function createSymbolTexture(
  symbol: string,
  color: number,
  markPixels: number,
  offset: readonly [number, number],
): THREE.CanvasTexture | null {
  const quadPixels = quadPixelsFor(markPixels, offset);
  const size = Math.round(quadPixels * TEXTURE_SCALE);
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    return null;
  }
  // 記号そのものの大きさは四角の広さに依らず一定(表示 16 画素)にする。
  const glyphPixels = markPixels * GLYPH_RATIO * TEXTURE_SCALE;
  context.font = `${String(Math.round(glyphPixels))}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const fill = cssColor(color);
  context.fillStyle = fill;
  context.strokeStyle = fill;
  context.lineWidth = markPixels * GLYPH_STROKE_RATIO * TEXTURE_SCALE;
  context.lineJoin = 'round';
  // 四角の中心から、画面上のずらし量ぶんだけ動かして描く(y は下が正で画面と同じ向き)。
  const centre = size / 2;
  const x = centre + offset[0] * TEXTURE_SCALE;
  const y = centre + offset[1] * TEXTURE_SCALE;
  context.strokeText(symbol, x, y);
  context.fillText(symbol, x, y);
  const texture = new THREE.CanvasTexture(canvas);
  // 記号は小さく描くので、縮小のときにぼやけないよう線形補間にし、ミップマップも作らない
  // (ミップマップの段が選ばれると、さらに薄まって読めなくなる)。
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** まとめて描く単位 1 つ(同じ記号・同じ色・同じ強調)。 */
interface MarkBatch {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly texture: THREE.CanvasTexture;
}

export interface ConstraintLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /** 出す印を差し替える。空か `null` で消す。 */
  setMarks(marks: readonly ConstraintMark[] | null): void;
  /** 選ばれている拘束(一覧の行を押したとき)。その印だけ大きく出す。`null` で解除。 */
  setSelected(constraintId: string | null): void;
  /** 表示テーマの色を反映する(FR-908)。記号の絵は色ごとに作り直す。 */
  setThemeColors(colors: ThemeColors): void;
  dispose(): void;
}

/**
 * 印の層を作る。`fixedSymbol` は「固定」の記号(`constraintSummary.ts` の
 * `constraintKindSymbol('fix')`)で、色を鍵の色へ振り分けるのに使う。記号の表そのものは
 * ui の `constraintSummary.ts` が正本なので、ここでは値として受け取るだけにする
 * (同じ表を 2 か所に書かない)。
 */
export function createConstraintLayer(fixedSymbol: string): ConstraintLayer {
  const group = new THREE.Group();
  /** まとめて描く単位。鍵は「記号 + 色 + 強調」。 */
  const batches = new Map<string, MarkBatch>();

  let marks: readonly ConstraintMark[] = [];
  let selectedId: string | null = null;
  let colors: ThemeColors = DEFAULT_THEME_COLORS;

  function disposeBatch(batch: MarkBatch): void {
    group.remove(batch.points);
    batch.points.geometry.dispose();
    batch.points.material.dispose();
    batch.texture.dispose();
  }

  /** いまの印・強調・色で、まとめて描く単位を作り直す。 */
  function refresh(): void {
    /** 鍵 → 座標の並び。 */
    const grouped = new Map<
      string,
      {
        color: number;
        symbol: string;
        selected: boolean;
        offset: readonly [number, number];
        positions: number[];
      }
    >();
    for (const mark of marks) {
      const color = colors[markColorField(mark, fixedSymbol)];
      const selected = mark.constraintId === selectedId;
      const key = batchKey(mark.symbol, color, selected, mark.offset);
      const found = grouped.get(key);
      if (found === undefined) {
        grouped.set(key, {
          color,
          symbol: mark.symbol,
          selected,
          offset: mark.offset,
          positions: [mark.position[0], mark.position[1], mark.position[2]],
        });
        continue;
      }
      found.positions.push(mark.position[0], mark.position[1], mark.position[2]);
    }

    // 使わなくなった単位を片付ける(記号が消えた・色が変わった)。
    for (const [key, batch] of batches) {
      if (!grouped.has(key)) {
        disposeBatch(batch);
        batches.delete(key);
      }
    }

    for (const [key, entry] of grouped) {
      const values = new Float32Array(entry.positions);
      const existing = batches.get(key);
      if (existing !== undefined) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
        geometry.computeBoundingSphere();
        existing.points.geometry.dispose();
        existing.points.geometry = geometry;
        continue;
      }
      const markPixels = MARK_SIZE_PIXELS * (entry.selected ? SELECTED_SCALE : 1);
      const texture = createSymbolTexture(entry.symbol, entry.color, markPixels, entry.offset);
      if (texture === null) {
        // 絵を描けない場面。印は出さないが、線と点はそのまま出る。
        continue;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
      geometry.computeBoundingSphere();
      const material = new THREE.PointsMaterial({
        map: texture,
        // ずらしを絵の中に焼き込むぶん、四角そのものは広く取る(`batchKey` の注釈)。
        size: quadPixelsFor(markPixels, entry.offset),
        // 大きさを画素で決める(定数サイズ)。寄っても引いても同じ大きさで読める。
        sizeAttenuation: false,
        transparent: true,
        // 記号の外側(透明な地)を描かない。重なった印が四角く欠けて見えるのを防ぐ。
        alphaTest: 0.1,
        depthTest: false,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      points.renderOrder = MARK_RENDER_ORDER;
      group.add(points);
      batches.set(key, { points, texture });
    }
  }

  return {
    group,

    setMarks(next): void {
      marks = next ?? [];
      refresh();
    },

    setSelected(constraintId): void {
      if (constraintId === selectedId) {
        return;
      }
      selectedId = constraintId;
      refresh();
    },

    setThemeColors(next): void {
      colors = next;
      // 記号の絵に色を焼き込んでいるので、テーマが変わったら作り直す。
      for (const [key, batch] of batches) {
        disposeBatch(batch);
        batches.delete(key);
      }
      refresh();
    },

    dispose(): void {
      marks = [];
      for (const batch of batches.values()) {
        disposeBatch(batch);
      }
      batches.clear();
    },
  };
}
