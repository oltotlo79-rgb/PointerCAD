import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createDefaultConfigurations, createEmptyPartDocument,
  createPrimitiveFeature, activateConfiguration, createConfiguration, saveNamedView,
  type PartDocument, type PrimitiveFeature } from '@pointercad/model';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

const savedAt = '2026-09-09T00:00:00.000Z';
function part(): PartDocument {
  const base = createEmptyPartDocument();
  const parameters = [{ name: '幅', value: { source: '1/7', value: 1 / 7, display: '0.142857142857' }, unit: 'mm' as const, description: '' }];
  return { ...base, parameters, configurations: createDefaultConfigurations(parameters) };
}
function roundTrip(document: PartDocument): PartDocument {
  const parsed = parseDocument(serializeDocument(document, { savedAt }));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.document;
}
function mutate(document: PartDocument, change: (body: Record<string, unknown>) => void): string {
  const raw: unknown = JSON.parse(serializeDocument(document, { savedAt }));
  if (!isRecord(raw) || !isRecord(raw['document'])) throw new Error('Expected document envelope');
  change(raw['document']);
  return JSON.stringify(raw);
}

describe('名前付き視点と構成を実際の部品・アセンブリ保存形式で往復する(P8-60/62/64)', () => {
  it('既定の4視点と構成1件は新規部品の往復で変わらない', () => {
    const document = createEmptyPartDocument();
    expect(roundTrip(document)).toEqual(document);
  });
  it('任意の上方向・平行投影・ズームも式とは独立して保存する', () => {
    const base = part();
    const result = saveNamedView(base.namedViews, '検査方向', { position: [20, 40, 70], target: [1, 2, 3], up: [1, 1, 0], projection: 'orthographic', zoom: 2.5 });
    if (!result.ok) throw new Error(result.reason);
    expect(roundTrip({ ...base, namedViews: result.views }).namedViews).toEqual(result.views);
  });
  it('構成ごとの式を保存し、別の構成を選ぶと参照する形も再評価する', () => {
    const base = part();
    const sphere: PrimitiveFeature = { ...createPrimitiveFeature(base, 'sphere'),
      shape: { kind: 'sphere', radius: { source: '幅*7', value: 1, display: '1' } } };
    const created = createConfiguration({ ...base, solids: [sphere] }, '大', { 幅: '10/7' });
    if (!created.ok) throw new Error(created.reason);
    const reopened = roundTrip(created.document);
    const selected = activateConfiguration(reopened, reopened.configurations[1].id);
    if (!selected.ok) throw new Error(selected.reason);
    expect(selected.document.parameters[0].value.source).toBe('10/7');
    expect(selected.document.solids[0]).toMatchObject({ shape: { kind: 'sphere', radius: { source: '幅*7', value: 10 } } });
  });
  it('保存する構成値は式だけで、表示値・解・メッシュを含めない', () => {
    const reopened = roundTrip(part());
    expect(reopened.configurations[0].values).toEqual({ 幅: '1/7' });
    expect(Object.keys(reopened.configurations[0])).toEqual(['id', 'name', 'values']);
  });
  it('途中で壊れた式も開いて修正できる(FR-504)', () => {
    const document = part();
    const parameters = document.parameters.map((entry) => ({ ...entry, value: { ...entry.value, source: '1/' } }));
    const reopened = roundTrip({ ...document, parameters, configurations: createDefaultConfigurations(parameters) });
    expect(reopened.configurations[0].values['幅']).toBe('1/');
  });
  it('空の構成一覧と未選択は往復する', () => {
    const document = { ...part(), configurations: [], activeConfigurationId: null };
    expect(roundTrip(document)).toEqual(document);
  });
  it('構成の式のキー順が異なっても保存バイトが同じ', () => {
    const document = part();
    const first = { ...document, configurations: [{ id: 'configuration-1', name: '既定', values: { 幅: '1/7', 高さ: '5' } }] };
    const second = { ...first, configurations: [{ ...first.configurations[0], values: { 高さ: '5', 幅: '1/7' } }] };
    expect(serializeDocument(first, { savedAt })).toBe(serializeDocument(second, { savedAt }));
  });
  it.each(['namedViews', 'configurations', 'activeConfigurationId'])('現行版で必須の%sを欠いたファイルは断る', (key) => {
    expect(parseDocument(mutate(part(), (body) => { delete body[key]; }))).toMatchObject({ ok: false, error: { code: 'missingField' } });
  });
  it.each([
    { key: 'zoom', value: 0 }, { key: 'zoom', value: -1 },
    { key: 'position', value: [0, 0, 0] }, { key: 'up', value: [0, -1, 0] },
    { key: 'projection', value: 'fishEye' },
  ])('壊れた視点を断る: $key=$value', ({ key, value }) => {
    const text = mutate(part(), (body) => {
      body['namedViews'] = [{ ...part().namedViews[0], [key]: value }];
    });
    expect(parseDocument(text)).toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });
  it('存在しない構成を選択中として読むことはない', () => {
    expect(parseDocument(mutate(part(), (body) => { body['activeConfigurationId'] = 'absent'; }))).toMatchObject({ ok: false });
  });
  it('構成の名前・IDの重複を断る', () => {
    expect(parseDocument(mutate(part(), (body) => { body['configurations'] = [part().configurations[0], part().configurations[0]]; }))).toMatchObject({ ok: false });
  });
  it('構成に欠けたパラメータや未知の名前を断る', () => {
    for (const values of [{}, { 幅: '1/7', unknown: '2' }]) {
      expect(parseDocument(mutate(part(), (body) => { body['configurations'] = [{ ...part().configurations[0], values }]; }))).toMatchObject({ ok: false });
    }
  });
  it.each([2, 3, 4, 5, 6, 7, 8, 9])('旧版%dから、元の式を持つ既定構成と4視点を補う', (schema) => {
    const document = part();
    const body: Record<string, unknown> = { ...document, schemaVersion: schema };
    delete body['namedViews']; delete body['configurations']; delete body['activeConfigurationId'];
    const result = parseDocument(JSON.stringify({ app: 'PointerCAD', kind: 'part', schema, savedAt, document: body }));
    expect(result).toMatchObject({ ok: true, document: { schemaVersion: PCAD_SCHEMA_VERSION,
      configurations: [{ name: '既定', values: { 幅: '1/7' } }], activeConfigurationId: 'configuration-1' } });
    expect(result.ok && result.document.namedViews).toHaveLength(4);
  });
  it('アセンブリでも4視点を保存し、旧版8は補って開く', () => {
    const document = createAssemblyDocument('組図');
    const raw = writeAssemblyDocument(document, { savedAt, partFiles: [] });
    expect(readAssemblyDocument(raw)).toMatchObject({ ok: true, document });
    const body: Record<string, unknown> = { ...document, schemaVersion: 8 };
    delete body['namedViews'];
    const legacy: unknown = JSON.parse(raw);
    if (!isRecord(legacy)) throw new Error('Expected assembly envelope');
    const result = readAssemblyDocument(JSON.stringify({ ...legacy, schema: 8, document: body }));
    expect(result).toMatchObject({ ok: true, document });
  });
});
