/**
 * ヘルプ文書(要件 FR-901)。Markdown を docs/ja 配下で管理する。
 * 機能追加のたびにヘルプの追加を必須とする(NFR-MA-4)。
 */

/** ヘルプの1項目。id はコンテキストヘルプ(FR-903)から参照する。 */
export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  /** packages/help-content からの相対パス。 */
  readonly path: string;
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  { id: 'viewport', title: '画面を回す・動かす・拡大する', path: 'docs/ja/viewport.md' },
  { id: 'numeric-input', title: '数値と式の入れ方', path: 'docs/ja/numeric-input.md' },
  {
    id: 'parameters',
    title: '名前を付けた数値(パラメータ)',
    path: 'docs/ja/parameters.md',
  },
  { id: 'sketch-tools', title: '点・線・円弧をかく', path: 'docs/ja/sketch-tools.md' },
  {
    id: 'shapes',
    title: '四角・多角形・長穴・円をかく',
    path: 'docs/ja/shapes.md',
  },
  { id: 'ellipse', title: '楕円をかく', path: 'docs/ja/ellipse.md' },
  {
    id: 'spline',
    title: 'なめらかな曲線をかく(スプライン)',
    path: 'docs/ja/spline.md',
  },
  { id: 'work-plane', title: '作図面を選ぶ', path: 'docs/ja/work-plane.md' },
  {
    id: 'work-plane-custom',
    title: '好きな向きの作業平面を作る',
    path: 'docs/ja/work-plane-custom.md',
  },
  {
    id: 'reference-geometry',
    title: '基準の軸・点・座標系を作る',
    path: 'docs/ja/reference-geometry.md',
  },
  {
    id: 'origin',
    title: '原点を置き直す',
    path: 'docs/ja/origin.md',
  },
  {
    id: 'edit-curves',
    title: 'オフセット・トリム・延長',
    path: 'docs/ja/edit-curves.md',
  },
  {
    id: 'constraints',
    title: '形を条件で決める(拘束)',
    path: 'docs/ja/constraints.md',
  },
  {
    id: 'sketch-fillet',
    title: '線の角を丸める・面取りする',
    path: 'docs/ja/sketch-fillet.md',
  },
  {
    id: 'copy-array',
    title: 'ミラー・複写・並べる',
    path: 'docs/ja/copy-array.md',
  },
  {
    id: 'project-intersect',
    title: '立体から線を取り込む(投影・断面)',
    path: 'docs/ja/project-intersect.md',
  },
  { id: 'snap', title: '点にぴったり合わせる(吸着)', path: 'docs/ja/snap.md' },
  {
    id: 'tracking',
    title: '向きをそろえる(直交・角度・延長線)',
    path: 'docs/ja/tracking.md',
  },
  {
    id: 'command-line',
    title: 'キーボードだけでかく(コマンドの欄)',
    path: 'docs/ja/command-line.md',
  },
  { id: 'face-and-color', title: '面を張る・色を変える', path: 'docs/ja/face-and-color.md' },
  { id: 'edit-sketch', title: 'かいたものを直す', path: 'docs/ja/edit-sketch.md' },
  { id: 'solid-basics', title: '厚みをつける・回す', path: 'docs/ja/solid-basics.md' },
  {
    id: 'solid-combine',
    title: '立体をつなぐ・組み合わせる',
    path: 'docs/ja/solid-combine.md',
  },
  {
    id: 'feature-tree',
    title: '作ったものの一覧と、やり直し',
    path: 'docs/ja/feature-tree.md',
  },
  {
    id: 'timeline',
    title: '途中まで戻して確かめる(タイムライン)',
    path: 'docs/ja/timeline.md',
  },
  { id: 'save-and-open', title: '保存する・開く', path: 'docs/ja/save-and-open.md' },
  {
    id: 'select-subshape',
    title: '面・辺・頂点を選ぶ',
    path: 'docs/ja/select-subshape.md',
  },
  { id: 'hole', title: '穴をあける', path: 'docs/ja/hole.md' },
  {
    id: 'fillet-chamfer',
    title: '角を丸める・面を取る',
    path: 'docs/ja/fillet-chamfer.md',
  },
  { id: 'thread', title: 'ねじ穴をあける', path: 'docs/ja/thread.md' },
  { id: 'pattern', title: '同じ加工を並べる', path: 'docs/ja/pattern.md' },
  { id: 'spring', title: 'ばねを作る', path: 'docs/ja/spring.md' },
  {
    id: 'primitive',
    title: '球・箱・円柱・円錐・トーラスを置く',
    path: 'docs/ja/primitive.md',
  },
  {
    id: 'sphere-grid',
    title: '球の表面に点を置く',
    path: 'docs/ja/sphere-grid.md',
  },
  {
    id: 'ruled-loft',
    title: '面と面をつなぐ・ロフト',
    path: 'docs/ja/ruled-loft.md',
  },
  {
    id: 'shape-edit',
    title: '立体の形を変える・並べる',
    path: 'docs/ja/shape-edit.md',
  },
  {
    id: 'cut',
    title: '平面で切る',
    path: 'docs/ja/cut.md',
  },
  {
    id: 'display-settings',
    title: '画面の見た目を変える',
    path: 'docs/ja/display-settings.md',
  },
  {
    id: 'appearance-color',
    title: '色と材質を選ぶ',
    path: 'docs/ja/appearance-color.md',
  },
  {
    id: 'appearance-pattern',
    title: '柄を選ぶ',
    path: 'docs/ja/appearance-pattern.md',
  },
  {
    id: 'appearance-glass',
    title: 'ガラス・鏡と映り込み',
    path: 'docs/ja/appearance-glass.md',
  },
  {
    id: 'measure',
    title: '長さ・角度・面積を測る',
    path: 'docs/ja/measure.md',
  },
  {
    id: 'mass-properties',
    title: '材料と重さを調べる',
    path: 'docs/ja/mass-properties.md',
  },
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
