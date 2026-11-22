import type { SaveEncodingControl } from '@pointercad/io';
import type { MessageKey } from '../i18n/t.js';

/** 書き手が解析の結果を書けなかった理由の符号(io の AnalysisResultIssue と同じ物)。 */
type SaveResultIssue =Parameters<NonNullable<SaveEncodingControl['onAnalysisResultIssue']>>[1];

/** 書けなかった結果 1 件。保存 Worker の成功の返信にも、この形で載る。 */
export interface SaveResultIssueReport {
  readonly analysisId: string;
  readonly issue: SaveResultIssue;
}

/**
 * 符号ごとの、保存できた時に出す文(利用者の回答 2026-11-20 18:2x (3): 計算部は符号だけを返し、文は画面の側の 1 つの
 * 一覧に持つ)。書き手が返すのは主に invalidResult と resultTooLarge で、読みの側だけの符号も同じ文に寄せる。
 */
const SAVED_WITHOUT_RESULT_KEYS: Readonly<Record<SaveResultIssue, MessageKey>> = {
  invalidResult: 'file.savedWithoutResult.invalid',
  unknownSchema: 'file.savedWithoutResult.invalid',
  unknownKind: 'file.savedWithoutResult.invalid',
  bindingMismatch: 'file.savedWithoutResult.invalid',
  resultTooLarge: 'file.savedWithoutResult.tooLarge',
};

export function isSaveResultIssue(value: unknown): value is SaveResultIssue {
  return typeof value === 'string' && Object.hasOwn(SAVED_WITHOUT_RESULT_KEYS, value);
}

/** 保存できた時に出す文。書けなかった結果があれば、最初の 1 件の理由の文にする(文書そのものは保存できている)。 */
export function savedMessageKey(issues: readonly SaveResultIssueReport[]): MessageKey {
  const first = issues[0];
  return first === undefined ? 'file.saved' : SAVED_WITHOUT_RESULT_KEYS[first.issue];
}
