import { describe, expect, it } from 'vitest';

import { performanceTestPriority } from './performanceSequencer.js';

describe('厳密性能検査のファイル順', () => {
  it('時間上限を判定するファイルだけを通常機能テストより前へ送る', () => {
    const ordinary = performanceTestPriority('/repo/src/ordinary.test.ts', "import { expect } from 'vitest';");
    const measured = performanceTestPriority('/repo/src/makeRib.test.ts', 'expectWithinBudget(elapsed, 500);');
    expect(measured).toBeLessThan(ordinary);
  });

  it('余裕の小さい実測をOSの区切り文字にかかわらず最優先する', () => {
    const source = 'expectWithinBudget(elapsed, limit);';
    const assembly = performanceTestPriority('C:\\repo\\assemblyPerformance.test.ts', source);
    const interference = performanceTestPriority('/repo/interferencePerformance.test.ts', source);
    const exportMesh = performanceTestPriority('/repo/exportMesh.test.ts', source);
    const generic = performanceTestPriority('/repo/makeRib.test.ts', source);
    expect(assembly).toBeLessThan(generic);
    expect(interference).toBeLessThan(exportMesh);
    expect(exportMesh).toBeLessThan(generic);
  });
});
