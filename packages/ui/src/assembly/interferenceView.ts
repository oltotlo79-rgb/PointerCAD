/** 干渉解析の結果を表示専用の一覧へ写す純関数(P7 タスク26)。 */
import type { AssemblyInterferencePair, AssemblyInterferenceReport } from '@pointercad/model';

export interface InterferenceRow {
  readonly key: string;
  readonly pair: AssemblyInterferencePair;
  readonly aName: string;
  readonly bName: string;
  readonly volumeText: string;
}

/** 兄弟の行で衝突せず、入力順にも左右されない安定したキー。 */
export function interferencePairKey(aComponentId: string, bComponentId: string): string {
  const [a, b] = aComponentId.localeCompare(bComponentId) <= 0
    ? [aComponentId, bComponentId] : [bComponentId, aComponentId];
  return `interference:${a}:${b}`;
}

export function formatInterferenceVolume(volumeMm3: number): string {
  const finite = Number.isFinite(volumeMm3) ? Math.max(0, volumeMm3) : 0;
  return `${Object.is(finite, -0) ? '0.000' : finite.toFixed(3)} mm³`;
}

export function interferenceRows(
  report: Pick<AssemblyInterferenceReport, 'pairs'>,
  nameOf: (componentId: string) => string = (componentId) => componentId,
): readonly InterferenceRow[] {
  return report.pairs.map((pair): InterferenceRow => ({
    key: interferencePairKey(pair.aComponentId, pair.bComponentId),
    pair,
    aName: nameOf(pair.aComponentId),
    bName: nameOf(pair.bComponentId),
    volumeText: formatInterferenceVolume(pair.volume),
  })).sort((a, b) => b.pair.volume - a.pair.volume || a.key.localeCompare(b.key));
}

export function selectedInterferencePair(
  report: Pick<AssemblyInterferenceReport, 'pairs'> | null,
  key: string | null,
): AssemblyInterferencePair | null {
  if (report === null || key === null) return null;
  return report.pairs.find((pair) =>
    interferencePairKey(pair.aComponentId, pair.bComponentId) === key) ?? null;
}
