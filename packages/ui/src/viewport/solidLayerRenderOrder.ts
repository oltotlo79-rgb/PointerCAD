/**
 * 立体の表示層の部品を描く順(renderOrder)。層の前後関係を 1 か所で読み取れるよう、スケッチと同じ
 * 数直線(スケッチの作図面 -1 → 面 0 → 立体 1 → 面の縁 2 → 線 3 → 点 4)の上に置く。
 *
 * 立体の面と稜線は不透明なので、three.js は半透明のもの(方眼・作図面・スケッチの面・線・点)より
 * **先に**描く。そのうえでスケッチの線と点は `depthTest: false` なので、立体の奥にあっても隠れずに
 * 前面へ出る。renderOrder は不透明どうしの順序を決めるだけ。
 *
 * ホバーと選択の色の決め方は `createSketchLayer.ts` の注釈にまとめてある。**同じトークン
 * (--pcad-emphasis-hovered / --pcad-emphasis-selected)を使う**ので、スケッチと立体で
 * 「選んでいる」の見え方が 2 通りに割れることはない。
 */

/** 立体の面。 */
export const SOLID_RENDER_ORDER = 1;

/**
 * 稜線は**面より後に**描く(FR-105)。
 *
 * 面は `polygonOffset` で少しだけ奥へ押してあり、稜線はその上に重なる。重なる画素の色は
 * 描いた順で決まる(縁のなめらか化が後から描いたほうを勝たせる)ので、順序を材質の作られた順に
 * 任せてはいけない。three.js の不透明の並べ替えは renderOrder → 材質の通し番号(作った順)の順に
 * 見るため、面の材質を外観から後から作ると順序が逆転して縁の画素の色が変わる
 * (800×600 の絵で 122 画素、最大の階調差 41 の実測がある)。順序をここで明示して同じ絵を保つ。
 */
export const SOLID_EDGE_RENDER_ORDER = SOLID_RENDER_ORDER + 0.25;

/** 部分形状の面の強調と、切断の予告・断面のつまみの四角は、立体の面のすぐ後ろに描く。 */
export const SUB_SHAPE_FACE_RENDER_ORDER = SOLID_RENDER_ORDER + 0.5;

/**
 * 部分形状の辺・頂点の強調、ねじの印、球面の案内線、切断の予告・断面のつまみの矢印、点検の開いた辺は、
 * スケッチの面の縁(`createSketchLayer.ts` の `FACE_OUTLINE_RENDER_ORDER`)と同じ層に置く。
 */
export const SUB_SHAPE_LINE_RENDER_ORDER = 2;
