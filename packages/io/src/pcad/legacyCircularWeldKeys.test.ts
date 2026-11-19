import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource, partKeyOf,
  readCircularFilletWeldSource, STEEL_PRODUCTS, steelProductOptions, type AssemblyComponent, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { canonicalSteelOptions, canonicalSteelPartKey } from './codecs/componentSource.js';

const SAVED_AT = '2026-11-19T00:00:00.000Z';
const CURRENT_ROUND_LABEL = '公表丸鋼寸法';
// 旧版の丸鋼の表記(製品の表 legacySteelLabels と同じ文字の番号。古いファイルの写しを作るためだけに使う)。
const LEGACY_ROUND_LABEL = String.fromCharCode(22823, 38442, 35069, 37941, 32, 20844, 34920, 20024, 37628, 23544, 27861);

/** 部品の出どころの鍵の形(model の componentSourceKey と同じ書き方を、検査の側で独立に組む)。 */
function sourceKeyOf(source: StandardPartSource): string {
  const pairs = Object.keys(source.options).sort().map((name) => [name, source.options[name]]);
  return `standard:${source.catalog}:${source.size}:${source.catalogRevision}:${source.generatorRevision}:${JSON.stringify(pairs)}`;
}

/** 名前の順に欄を並べた JSON(円周の溶接の保存の書き方)。 */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, row: unknown): unknown => (typeof row !== 'object' || row === null || Array.isArray(row) ? row
    : Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))));
}

/** 旧版の SS400 の丸鋼(円筒の親)と、それに付けた円周のすみ肉溶接のビード(親の鍵を options の中に持つ)の文書。 */
function weldedDocument(): { readonly document: AssemblyDocument; readonly bar: AssemblyComponent } {
  const row = STEEL_PRODUCTS.find((product) => product.catalog === 'roundBar' && product.materialGrade === 'SS400');
  if (row === undefined) throw new Error('SS400 round bar is unavailable');
  const empty = createAssemblyDocument('円周の溶接の古い鍵');
  const barSource = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
  const bar = createComponentFor(empty, barSource, { partName: '丸鋼' });
  const parent = { documentId: 'assembly-1', ownerId: bar.id, occurrencePath: [bar.id], sourceKey: sourceKeyOf(barSource),
    placementKey: 'pose-1', bodyFeatureId: 'primitive-1', bodyKey: 'body-bar' };
  const payload = { weldId: 'weld-1', beadId: 'bead-1', radialDirection: 1, normalDirection: 1,
    path: { kind: 'circular-weld-path', evidence: { kind: 'circle-edge', source: { ...parent, edgeIndex: 0 },
      centerMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1], radiusMm: 10, parameterRange: [0, Math.PI / 2], orientation: 1 },
    intervals: [{ beadId: 'bead-1', beadSourceKey: 'draft-epoch-1', fromParameter: 0, toParameter: Math.PI / 2 }] },
    parents: [
      { ...parent, role: 'plane', ownerId: 'plate', occurrencePath: ['plate'], sourceKey: 'part:p@4', bodyKey: 'body-p',
        reference: { bodyFeatureId: 'primitive-1', index: 1, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1600,
          position: [0, 0, 0], axis: [0, 0, 1], radius: null } } },
      { ...parent, role: 'cylinder', reference: { bodyFeatureId: 'primitive-1', index: 2,
        fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 200 * Math.PI, position: [0, 0, 5], axis: [0, 0, 1], radius: 10 } } },
    ] };
  const bead: StandardPartSource = { kind: 'standardPart', catalog: 'filletWeld', catalogRevision: 'weld-1', generatorRevision: 'fillet-weld-5',
    size: '3x4', options: { weldCircular: sortedJson(payload) } };
  if (readCircularFilletWeldSource(bead) === null) throw new Error('fixture bead refused');
  const withBar = addComponent(empty, bar);
  const beadComponent = createComponentFor(withBar, bead, { partName: '円周のビード',
    placement: { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] } });
  return { document: addComponent(withBar, beadComponent), bar };
}

describe('円周の溶接が保存した親の鍵の、旧版の鋼材の古い表記を読み直す', () => {
  const { document } = weldedDocument();
  const currentText = writeAssemblyDocument(document, { savedAt: SAVED_AT });
  const legacyText = currentText.split(CURRENT_ROUND_LABEL).join(LEGACY_ROUND_LABEL);

  it('古い写しは、丸鋼の options とビードの中の親の鍵(親 1 と経路の出どころ)に古い表記を持つ(検査の前提)', () => {
    expect(currentText.split(CURRENT_ROUND_LABEL)).toHaveLength(4);
    // 旧版の丸鋼の表記は今の表記を後ろに含む(発行元の名前 + 空白 + 今の表記)ので、古い表記の数で見る。
    expect(legacyText.split(LEGACY_ROUND_LABEL)).toHaveLength(4);
  });

  it('開くとビードの中の親の鍵が丸鋼の今の鍵と一致し、ビードの形が作れ、書き直すと今の写しと同じ文になる', () => {
    const read = readAssemblyDocument(legacyText);
    if (!read.ok) throw new Error('read refused');
    const [bar, bead] = read.document.components;
    if (bar?.source.kind !== 'standardPart' || bead?.source.kind !== 'standardPart') throw new Error('components missing');
    const saved = readCircularFilletWeldSource(bead.source);
    expect(saved?.options.parents[1].sourceKey).toBe(sourceKeyOf(bar.source));
    expect(saved?.options.path.evidence.source.sourceKey).toBe(sourceKeyOf(bar.source));
    expect(buildStandardPartFromSource(bead.source)).not.toBeNull();
    const rewritten = writeAssemblyDocument(read.document, { savedAt: SAVED_AT });
    expect(rewritten).not.toContain(LEGACY_ROUND_LABEL);
    expect(rewritten).toBe(currentText);
  });

  it('古いビードの鍵(梁の解析の溶接の入力が保存する形)を直すと、読んだビードの今の鍵になる', () => {
    const legacy = readAssemblyDocument(legacyText);
    const oldBead = JSON.parse(legacyText) as { document: { components: { source: StandardPartSource }[] } };
    const oldSource = oldBead.document.components[1]?.source;
    if (!legacy.ok || oldSource === undefined) throw new Error('fixture missing');
    const newBead = legacy.document.components[1];
    expect(newBead === undefined ? null : canonicalSteelPartKey(partKeyOf(oldSource))).toBe(newBead === undefined ? '' : partKeyOf(newBead.source));
    expect(canonicalSteelPartKey(partKeyOf(oldSource))).not.toBe(partKeyOf(oldSource));
  });

  it('ビードの中の親の鍵が旧版の鋼材でない・壊れている時は、ビードの options をそのまま返す', () => {
    for (const key of ['part:p@4', '', 'standard:roundBar:φ20:jp-steel-2026-10-10-r1:3-steel-profile-1:[broken',
      'standard:hexBolt:M16:jis-2026-09-08-r1:1:[["length","100"]]']) {
      const options = { weldCircular: sortedJson({ parents: [{ sourceKey: key }] }) };
      expect(canonicalSteelOptions({ kind: 'standardPart', catalog: 'filletWeld', size: '3x4', options, catalogRevision: 'weld-1',
        generatorRevision: 'fillet-weld-5' })).toBe(options);
    }
  });
});
