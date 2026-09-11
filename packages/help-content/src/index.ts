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
  { id: 'scripts', title: 'JavaScriptで自動作図する', path: 'docs/ja/scripts.md' },
  { id: 'script-api', title: '自動作図APIリファレンス', path: 'docs/ja/script-api.md' },
  { id: 'script-tools', title: '処理を保存し、道具として登録する', path: 'docs/ja/script-tools.md' },
  { id: 'cam', title: '作った形を加工ソフトへ渡す', path: 'docs/ja/cam.md' },
  { id: 'sheet-metal', title: '板金の基板と曲げ条件を作る', path: 'docs/ja/sheet-metal.md' },
  { id: 'sheet-metal-flange', title: '板金の縁からフランジを作る', path: 'docs/ja/sheet-metal-flange.md' },
  { id: 'sheet-metal-bend-relief', title: '指定線で板を曲げる・曲げリリーフを作る', path: 'docs/ja/sheet-metal-bend-relief.md' },
  { id: 'sheet-metal-flat', title: '板金を展開し、穴表・図面・加工用ファイルを作る', path: 'docs/ja/sheet-metal-flat.md' },
  { id: 'dimension', title: '図面に寸法を記入する', path: 'docs/ja/dimension.md' },
  { id: 'dimension-auto', title: '自動寸法を記入する', path: 'docs/ja/dimension-auto.md' },
  { id: 'dimension-arrange', title: '寸法線をまとめて整列する', path: 'docs/ja/dimension-arrange.md' },
  { id: 'dimension-series', title: '直列・並列・座標・累進の寸法をまとめて記入する', path: 'docs/ja/dimension-series.md' },
  { id: 'dimension-tolerance', title: '寸法の公差・はめあいを指定する', path: 'docs/ja/dimension-tolerance.md' },
  { id: 'text-outline', title: '文字を輪郭にする・文字を含む図面を渡す', path: 'docs/ja/text-outline.md' },
  { id: 'drawing-views', title: '図を追加する・詳細図・補助投影図・部分図・破断図', path: 'docs/ja/drawing-views.md' },
  { id: 'drawing-section', title: '断面図で部品の内部を示す', path: 'docs/ja/drawing-section.md' },
  { id: 'drawing-scale', title: '用紙サイズ・縮尺・用紙位置', path: 'docs/ja/drawing-scale.md' },
  { id: 'drawing-note', title: '文字注記と引出線', path: 'docs/ja/drawing-note.md' },
  { id: 'gdt', title: '幾何公差とデータムを記入する', path: 'docs/ja/gdt.md' },
  { id: 'welding', title: '溶接記号で施工する側・寸法・方法を伝える', path: 'docs/ja/welding.md' },
  { id: 'drawing-bom', title: '図面に部品表と部品番号を置く', path: 'docs/ja/drawing-bom.md' },
  { id: 'drawing-table', title: '図面の穴表・改訂欄・表題欄を記入する', path: 'docs/ja/drawing-table.md' },
  { id: 'drawing-layer', title: 'レイヤーで色・線・表示・印刷を管理する', path: 'docs/ja/drawing-layer.md' },
  { id: 'surface-finish', title: '表面性状と加工注記を付ける', path: 'docs/ja/surface-finish.md' },
  { id: 'drawing-export', title: '図面を保存・書き出し・印刷する', path: 'docs/ja/drawing-export.md' },
  { id: 'named-view', title: '視点に名前を付けて保存する・4分割で見る', path: 'docs/ja/named-view.md' },
  { id: 'drawing', title: '部品から図面を作る・注記する・書き出す', path: 'docs/ja/drawing.md' },
  { id: 'text-sketch', title: '文字をスケッチの輪郭にする', path: 'docs/ja/text-sketch.md' },
  { id: 'font-licenses', title: '字体と解析ライブラリのライセンス', path: 'docs/ja/font-licenses.md' },
  { id: 'viewport', title: '画面を回す・動かす・拡大する', path: 'docs/ja/viewport.md' },
  { id: 'numeric-input', title: '数値と式の入れ方', path: 'docs/ja/numeric-input.md' },
  {
    id: 'parameters',
    title: '名前を付けた数値(パラメータ)',
    path: 'docs/ja/parameters.md',
  },
  { id: 'sketch-tools', title: '点・線・円弧をかく', path: 'docs/ja/sketch-tools.md' },
  { id: 'sketch-intersections', title: '交点で線をつなぐ・曲げる・区間を消す', path: 'docs/ja/sketch-intersections.md' },
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
  { id: 'assembly', title: '部品を置いて組み立てる', path: 'docs/ja/assembly.md' },
  { id: 'assembly-place', title: '部品を配置する', path: 'docs/ja/assembly-place.md' },
  { id: 'mate', title: '部品どうしを合わせる', path: 'docs/ja/mate.md' },
  { id: 'joint', title: 'ジョイントで動きを残す', path: 'docs/ja/joint.md' },
  { id: 'interference', title: '部品の干渉を調べる', path: 'docs/ja/interference.md' },
  { id: 'standard-parts', title: '規格部品を置く', path: 'docs/ja/standard-parts.md' },
  { id: 'explode', title: '分解した見せ方を作る', path: 'docs/ja/explode.md' },
  { id: 'bom', title: '部品表を確認する', path: 'docs/ja/bom.md' },
  {
    id: 'replace-subassembly',
    title: '部品を差し替える・組を置く',
    path: 'docs/ja/replace-subassembly.md',
  },
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
    id: 'strength',
    title: '梁・軸・ボルトの簡易強度計算',
    path: 'docs/ja/strength.md',
  },
  {
    id: 'mass-properties',
    title: '材料と重さを調べる',
    path: 'docs/ja/mass-properties.md',
  },
  {
    id: 'export',
    title: '書き出す(ほかのソフトへ渡す)',
    path: 'docs/ja/export.md',
  },
  {
    id: 'import',
    title: '読み込む(ほかのソフトの形を取り込む)',
    path: 'docs/ja/import.md',
  },
  {
    id: 'dxf',
    title: 'DXF を読み書きする',
    path: 'docs/ja/dxf.md',
  },
  {
    id: 'units',
    title: '単位を変える(ミリメートルとインチ)',
    path: 'docs/ja/units.md',
  },
  {
    id: 'section-view',
    title: '切って中を見る',
    path: 'docs/ja/section-view.md',
  },
  {
    id: 'selection',
    title: '選ぶものを絞る・選んだ組に名前を付ける',
    path: 'docs/ja/selection.md',
  },
  {
    id: 'canvas',
    title: '下絵を敷く',
    path: 'docs/ja/canvas.md',
  },
  {
    id: 'print-check',
    title: '3D プリントの前に点検する',
    path: 'docs/ja/print-check.md',
  },
  {
    id: 'template',
    title: 'ひな形を使う',
    path: 'docs/ja/template.md',
  },
  {
    id: 'print-save-as',
    title: '印刷する・別名で保存する',
    path: 'docs/ja/print-save-as.md',
  },
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
