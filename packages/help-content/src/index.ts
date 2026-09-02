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
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
