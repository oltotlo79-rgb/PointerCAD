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
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
