import { partKeyOf, standardMembersToBeamAnalysis } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { savedBoltFixture } from '@pointercad/model/testing/analysis-fixtures';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { canonicalSteelPartKey } from './codecs/componentSource.js';

const SAVED_AT = '2026-10-27T00:00:00.000Z';
const CURRENT_FLAT_LABEL = '公表平鋼寸法';
// 旧版の平鋼の表記(製品の表 legacySteelLabels と同じ文字の番号。古いファイルの写しを作るためだけに使う)。
const LEGACY_FLAT_LABEL = String.fromCharCode(29579, 23376, 35069, 37444, 32, 20844, 34920, 26029, 38754, 23544, 27861);

/** e2e の boltPreloadFixture と同じ形: 平鋼 FB 50×6 の部材 2 本と六角ボルト、梁の解析の入力 2 本(部材の鍵を 4 か所に持つ)。 */
function boltDocument() {
  const fixture = savedBoltFixture();
  const bolts = fixture.saved.cadDefinition.axialBolts;
  if (bolts === undefined) throw new Error('fixture lacks bolts');
  const document = withBeamAnalysisInputs(fixture.document, { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'standard-members', definition: { ...fixture.saved.cadDefinition, id: 'other-analysis', axialBolts: { ...bolts, analysisId: 'other-analysis' } } },
    { kind: 'native-bolt-preload', definition: fixture.saved },
  ] });
  return { fixture, document };
}

function readOk(text: string) {
  const read = readAssemblyDocument(text);
  if (!read.ok) throw new Error(`read refused: ${JSON.stringify(read)}`);
  return read.document;
}

function savedPartKeys(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/"expectedPartKey":"((?:[^"\\]|\\.)*)"/gu)].map((match) => JSON.parse(`"${match[1] ?? ''}"`) as string);
}

describe('旧版の鋼材の古い表記を持つ部品の鍵(梁の解析の入力)を読み直す', () => {
  const { fixture, document } = boltDocument();
  const currentText = writeAssemblyDocument(document, { savedAt: SAVED_AT });
  const legacyText = currentText.split(CURRENT_FLAT_LABEL).join(LEGACY_FLAT_LABEL);

  it('古い写しは部品の options 2 か所と梁の解析の鍵 4 か所に古い表記を持つ(検査の前提)', () => {
    expect(currentText.split(CURRENT_FLAT_LABEL)).toHaveLength(7);
    expect(legacyText.split(LEGACY_FLAT_LABEL)).toHaveLength(7);
    expect(legacyText).not.toContain(CURRENT_FLAT_LABEL);
  });

  it('開くと梁の解析の鍵が全部、読んだ部品の今の鍵と一致し、書き直すと今の表記だけの同じ文になる', () => {
    const restored = readOk(legacyText);
    const keys = new Set(restored.components.map((component) => partKeyOf(component.source)));
    const saved = savedPartKeys(restored.beamAnalysisInputs);
    expect(saved).toHaveLength(6);
    expect(saved.filter((key) => !keys.has(key))).toEqual([]);
    const rewritten = writeAssemblyDocument(restored, { savedAt: SAVED_AT });
    expect(rewritten).not.toContain(LEGACY_FLAT_LABEL);
    expect(rewritten).toBe(currentText);
  });

  it('古い写しの解析は changed-source にならず、今の写しと同じ結果の種類になる', () => {
    const outcome = (text: string) => {
      const restored = readOk(text);
      const analysis = restored.beamAnalysisInputs?.analyses.find((input) => input.kind === 'standard-members');
      if (analysis?.kind !== 'standard-members') throw new Error('standard-members input missing');
      const result = standardMembersToBeamAnalysis(restored, analysis.definition, fixture.context);
      return result.ok ? 'ok' : result.issue.code;
    };
    const legacy = outcome(legacyText);
    expect(legacy).not.toBe('changed-source');
    expect(legacy).toBe(outcome(currentText));
  });

  it('鍵の直しは旧版の鋼材の古い表記だけに当たり、ほかの鍵は同じ文字列のまま返す', () => {
    const legacyKey = `flatBar@jp-steel-2026-10-10-r1/3-steel-profile-1:FB 50×6|materialGrade=SS400|productStandard=${LEGACY_FLAT_LABEL}`;
    expect(canonicalSteelPartKey(legacyKey)).toBe(`flatBar@jp-steel-2026-10-10-r1/3-steel-profile-1:FB 50×6|materialGrade=SS400|productStandard=${CURRENT_FLAT_LABEL}`);
    for (const key of [
      `flatBar@jp-steel-2026-10-10-r1/3-steel-profile-1:FB 50×6|materialGrade=SS275|productStandard=${LEGACY_FLAT_LABEL}`,
      `flatBar@jp-steel-2026-11-01-r2/3-steel-profile-1:FB 50×6|materialGrade=SS400|productStandard=${LEGACY_FLAT_LABEL}`,
      'hexBolt@jis-2026-09-08-r1/1:M16|dimensionSeries=annexJA|length=100|threadSeries=coarse',
      'part-ref-1', '', 'flatBar@jp-steel-2026-10-10-r1/x:FB|=broken',
    ]) expect(canonicalSteelPartKey(key)).toBe(key);
  });
});
