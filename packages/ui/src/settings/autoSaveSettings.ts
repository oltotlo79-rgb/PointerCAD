import { AUTO_SAVE_INTERVAL_MS } from '@pointercad/io';

export const MIN_AUTO_SAVE_MINUTES = 1;
export const MAX_AUTO_SAVE_MINUTES = 60;
export const DEFAULT_AUTO_SAVE_MINUTES = AUTO_SAVE_INTERVAL_MS / 60_000;

export function parseAutoSaveMinutes(text: string): number | null {
  const source = text.trim();
  if (!/^[0-9]+$/u.test(source)) return null;
  const value = Number(source);
  return Number.isInteger(value) && value >= MIN_AUTO_SAVE_MINUTES && value <= MAX_AUTO_SAVE_MINUTES ? value : null;
}

/** 古い設定の欠落・壊れた値は自動保存を止めず、既定の5分へ戻す。 */
export function readAutoSaveIntervalMs(value: { readonly autoSaveIntervalMs?: unknown }): number {
  const interval = value.autoSaveIntervalMs;
  return typeof interval === 'number' && Number.isInteger(interval) && interval % 60_000 === 0
    && interval >= MIN_AUTO_SAVE_MINUTES * 60_000 && interval <= MAX_AUTO_SAVE_MINUTES * 60_000
    ? interval : AUTO_SAVE_INTERVAL_MS;
}
