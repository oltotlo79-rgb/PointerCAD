import type { Point2 } from '../types.js';

/** 出典: docs/standards/jis-drawing/general-tolerances-jis-b-0405.json。
 * JIS B 0405:1991の番号・等級表記。注記を置く寸法は慣用値のため要確認。 */
export const GENERAL_TOLERANCE_GRADES = { f: '精級', m: '中級', c: '粗級', v: '極粗級' } as const;
export type GeneralToleranceGrade = keyof typeof GENERAL_TOLERANCE_GRADES;
export const DEFAULT_GENERAL_TOLERANCE_GRADE: GeneralToleranceGrade = 'm';

export interface GeneralToleranceNote {
  readonly text: string;
  readonly position: Point2;
  readonly anchor: 'end';
  readonly baseline: 'bottom';
  readonly sizeMm: number;
  /** P9の幾何の普通公差はまだ表示しない。 */
  readonly geometricNote: null;
}

export function generalToleranceNote(input: {
  readonly enabled?: boolean;
  readonly grade?: string;
  readonly titleBlockRight: number;
  readonly titleBlockTop: number;
  readonly sizeMm?: number;
  readonly gapMm?: number;
}): GeneralToleranceNote | null {
  if (input.enabled === false) return null;
  const grade = input.grade ?? DEFAULT_GENERAL_TOLERANCE_GRADE;
  const label = Object.entries(GENERAL_TOLERANCE_GRADES).find(([key]) => key === grade)?.[1];
  const sizeMm = input.sizeMm ?? 3.5;
  const gap = input.gapMm ?? 3.5;
  if (label === undefined || ![input.titleBlockRight, input.titleBlockTop, sizeMm, gap].every(Number.isFinite)
    || sizeMm <= 0 || gap < 0) return null;
  return { text: `指示なき寸法の普通公差 JIS B 0405-${label}(${grade})`,
    position: [input.titleBlockRight, input.titleBlockTop + gap], anchor: 'end', baseline: 'bottom', sizeMm, geometricNote: null };
}
