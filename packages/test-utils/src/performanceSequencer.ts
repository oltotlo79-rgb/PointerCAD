/** 厳密性能検査を、同じパッケージの長い機能検査より前へ固定する。 */
import { readFile } from 'node:fs/promises';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

const STRICT_FLAG = '1';
const HIGH_RISK_ORDER = [
  'assemblyPerformance.test.ts',
  'interferencePerformance.test.ts',
  'exportMesh.test.ts',
  'writeStl.test.ts',
  'solidPerformance.test.ts',
  'readStl.test.ts',
  'readCafMesh.test.ts',
  'exchangePerformance.test.ts',
  'pickSolidSubShapePerformance.test.ts',
  'overlapGrid.test.ts',
] as const;

/** 小さいほど先に実行する。性能判定を持たないファイルは最後へ送る。 */
export function performanceTestPriority(moduleId: string, source: string): number {
  if (!source.includes('expectWithinBudget')) return Number.MAX_SAFE_INTEGER;
  const normalized = moduleId.replaceAll('\\', '/');
  const highRisk = HIGH_RISK_ORDER.findIndex((name) => normalized.endsWith(`/${name}`));
  return highRisk < 0 ? HIGH_RISK_ORDER.length : highRisk;
}

/**
 * Vitestの実行時間キャッシュは、前回失敗・前回所要で順番を変える。厳密性能検査ではその
 * 可変順を使わず、性能判定を持つファイルを静穏な先頭へ固定する。同じ優先度の中だけは
 * BaseSequencerの順番を保ち、通常モードではBaseSequencerの結果を一切変えない。
 */
export class PerformanceFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    if (process.env.POINTERCAD_PERF_STRICT !== STRICT_FLAG) return sorted;
    const scored = await Promise.all(sorted.map(async (specification, originalIndex) => {
      let source = '';
      try {
        source = await readFile(specification.moduleId, 'utf8');
      } catch {
        // 読めないファイルはVitest本体に診断させる。順番を変える理由にはしない。
      }
      return {
        specification,
        originalIndex,
        priority: performanceTestPriority(specification.moduleId, source),
      };
    }));
    scored.sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex);
    return scored.map((entry) => entry.specification);
  }
}
