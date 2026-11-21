/**
 * 計算部(model)が返した失敗の文の鍵と差し込む値から、画面の文を作る(D4「失敗の文は画面の側の一覧に持つ」)。
 * 文は文言の表(ja/*.json)が鍵ごとに 1 つ持ち、model は文を持たない。鍵が表に無い時(作る側の誤り)は、内部の鍵を
 * 画面に出さず、共通の 1 つの文(assembly.error.internal)にする(統括の決定 2026-11-20 18:4x の D4-1)。
 */
import type { FailureText } from '@pointercad/model';

import { MESSAGE_KEYS, t, type MessageKey } from './t.js';

export function failureMessage(text: FailureText): string {
  const key: MessageKey = MESSAGE_KEYS.find((candidate) => candidate === text.key) ?? 'assembly.error.internal';
  return Object.entries(text.parameters).reduce((message, [name, value]) =>
    message.split(`{${name}}`).join(typeof value === 'string' ? value : failureMessage(value)), t(key));
}

/**
 * 合致の断りの文(文字。合致の道を鍵へ移す D4 の 0c までは model の文)と、組立の誤りの鍵と値が混ざる一覧を、画面の文にする。
 * 0c で合致の道も鍵になったら消す。
 */
export function mixedFailureMessages(items: readonly (string | FailureText)[]): string[] {
  return items.map((item) => typeof item === 'string' ? item : failureMessage(item));
}

/**
 * 梁の解析の断り(AnalysisIssue か、投げられた InputIssue)の英語の診断の文の目印 {failures} の所へ、組立の誤りの文を「; 」で
 * つないで入れる(統括の決定 2026-11-20 19:4x。並びと区切りは鍵へ移す前の `solved.messages.join('; ')` と同じ)。
 * 目印を含む文を画面・診断へ出す所は、全部この口を通す(通していない所が無い事は、0a の束の README の道具で確かめる)。
 */
export function issueMessage(issue: { readonly message: string; readonly failures?: readonly (string | FailureText)[] | undefined }): string {
  if (issue.failures === undefined) return issue.message;
  return issue.message.split('{failures}').join(mixedFailureMessages(issue.failures).join('; '));
}
