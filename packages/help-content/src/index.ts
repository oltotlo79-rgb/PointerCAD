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
  { id: 'sketch-tools', title: '点・線・円弧をかく', path: 'docs/ja/sketch-tools.md' },
  { id: 'work-plane', title: '作図面を選ぶ', path: 'docs/ja/work-plane.md' },
  { id: 'snap', title: '点にぴったり合わせる(吸着)', path: 'docs/ja/snap.md' },
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
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
