import { describe, expect, it } from 'vitest';
import { createConfiguration, createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { applyScriptCommands } from '../../../model/src/scripting/scriptCommands.js';
import { parseDocument, serializeDocument } from '../pcad/documentJson.js';

function setParameter(document: PartDocument, name: string, source: string): PartDocument {
  const result = applyScriptCommands(document, [{ kind: 'parameter.set', resultId: null,
    callStack: 'at (user-script.js:1:1)', fields: { name, source, unit: 'mm' } }],
  new Map(), 'run', 'mm', new Map([['user-script.js', 'cad.parameters.set()']]));
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}
function roundTrip(document: PartDocument): PartDocument {
  const result = parseDocument(serializeDocument(document, { savedAt: '2026-09-11T00:00:00.000Z' }));
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}
describe('自動作図のパラメータと構成を通常の部品保存へ接続する', () => {
  it('初期文書へ追加したパラメータを保存して再開できる', () => {
    const initial = createEmptyPartDocument();
    const document = setParameter(initial, '板厚', '1/7');
    const opened = roundTrip(document);
    expect(opened).toEqual(document);
    expect(opened.configurations[0].values).toEqual({ 板厚: '1/7' });
    expect(initial.parameters).toEqual([]); expect(initial.configurations[0].values).toEqual({});
  });
  it('変更は現在の構成へ入り、別構成の独自値は保持して新しい名前だけ補完する', () => {
    const initial = setParameter(createEmptyPartDocument(), '板厚', '5');
    const variant = createConfiguration(initial, '厚板', { 板厚: '12' });
    if (!variant.ok) throw new Error(variant.reason);
    const document = setParameter(setParameter(variant.document, '板厚', '7'), '幅', '30');
    const opened = roundTrip(document);
    const active = opened.configurations.find(item => item.id === opened.activeConfigurationId);
    const other = opened.configurations.find(item => item.id !== opened.activeConfigurationId);
    expect(active?.values).toEqual({ 板厚: '7', 幅: '30' });
    expect(other?.values).toEqual({ 板厚: '12', 幅: '30' });
  });
});
