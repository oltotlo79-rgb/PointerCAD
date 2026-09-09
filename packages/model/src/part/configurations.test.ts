import { describe, expect, it } from 'vitest';
import type { Parameter } from '../parameters/types.js';
import { createEmptyPartDocument, createPrimitiveFeature } from './createPartDocument.js';
import { activateConfiguration, createConfiguration, createDefaultConfigurations, deleteConfiguration,
  renameConfiguration, renameConfigurationParameter, synchronizeConfigurations,
  type ConfigurationChange } from './configurations.js';
import type { PartDocument } from './types.js';

const parameter = (name: string, source: string): Parameter => ({
  name, value: { source, value: 0, display: '0' }, unit: 'mm', description: '',
});
function fixture(): PartDocument {
  const base = createEmptyPartDocument();
  const parameters = [parameter('幅', '20'), parameter('穴径', '幅/2')];
  return { ...base, parameters, configurations: createDefaultConfigurations(parameters),
    activeConfigurationId: 'configuration-1',
    solids: [{ ...createPrimitiveFeature(base, 'sphere'), shape: {
      kind: 'sphere', radius: { source: '幅/2', value: 10, display: '10' },
    } }],
  };
}
function success(result: ConfigurationChange): PartDocument {
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}

describe('設計表(FR-209、P8-62)', () => {
  it('古いパラメータ表の式を既定1構成に保つ', () => {
    expect(createDefaultConfigurations(fixture().parameters)).toEqual([
      { id: 'configuration-1', name: '既定', values: { 幅: '20', 穴径: '幅/2' } },
    ]);
    expect(createDefaultConfigurations([])).toHaveLength(1);
  });
  it('3構成を作り、式・パラメータ値・立体の下流寸法を一緒に切り替える', () => {
    let document = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    document = success(createConfiguration(document, '大', { 幅: '60' }));
    expect(document.configurations).toHaveLength(3);
    document = success(activateConfiguration(document, 'configuration-3'));
    expect(document.parameters.map((item) => [item.value.source, item.value.value])).toEqual([['60', 60], ['幅/2', 30]]);
    expect(document.solids[0]).toMatchObject({ shape: { radius: { source: '幅/2', value: 30 } } });
    document = success(activateConfiguration(document, 'configuration-2'));
    expect(document.solids[0]).toMatchObject({ shape: { radius: { source: '幅/2', value: 5 } } });
  });
  it('作成だけではアクティブな形を切り替えない', () => {
    const initial = fixture();
    const next = success(createConfiguration(initial, '小', { 幅: '10' }));
    expect(next.parameters).toBe(initial.parameters);
    expect(next.solids).toBe(initial.solids);
    expect(next.activeConfigurationId).toBe(initial.activeConfigurationId);
  });
  it('保存対象には数値キャッシュを入れない', () => {
    const document = success(createConfiguration(fixture(), '式', { 幅: 'sqrt(2)*10' }));
    expect(document.configurations[1].values).toEqual({ 幅: 'sqrt(2)*10', 穴径: '幅/2' });
    expect(Object.values(document.configurations[1].values).every((value) => typeof value === 'string')).toBe(true);
  });
  it('表にないパラメータ名は断る', () => {
    expect(createConfiguration(fixture(), '不明', { 未定義: '2' })).toEqual({ ok: false, reason: 'unknownParameter' });
  });
  it.each(['', '1/0', '幅+1', '10^309'])('壊れた式・循環・桁あふれ %s を断る', (source) => {
    expect(createConfiguration(fixture(), '不正', { 幅: source })).toEqual({ ok: false, reason: 'invalidExpression' });
  });
  it('空白の名前と重複名を断る', () => {
    expect(createConfiguration(fixture(), '  ')).toEqual({ ok: false, reason: 'emptyName' });
    expect(createConfiguration(fixture(), ' 既定 ')).toEqual({ ok: false, reason: 'duplicateName' });
  });
  it('切替の前の文書を変更せず、Undoへ1文書として渡せる', () => {
    const before = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    const snapshot = JSON.stringify(before);
    const after = success(activateConfiguration(before, 'configuration-2'));
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after.activeConfigurationId).toBe('configuration-2');
    expect(before.activeConfigurationId).toBe('configuration-1');
  });
  it('同じ構成への再切替は同一文書を返す', () => {
    const before = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    const active = success(activateConfiguration(before, 'configuration-2'));
    expect(success(activateConfiguration(active, 'configuration-2'))).toBe(active);
  });
  it('存在しない構成を断る', () => {
    expect(activateConfiguration(fixture(), 'missing')).toEqual({ ok: false, reason: 'notFound' });
    expect(deleteConfiguration(fixture(), 'missing')).toEqual({ ok: false, reason: 'notFound' });
  });
  it('アクティブ構成削除時は先頭へ切替、最後を削除するとnullにする', () => {
    let document = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    document = success(deleteConfiguration(document, 'configuration-1'));
    expect(document.activeConfigurationId).toBe('configuration-2');
    expect(document.parameters[0].value.value).toBe(10);
    document = success(deleteConfiguration(document, 'configuration-2'));
    expect(document.configurations).toEqual([]);
    expect(document.activeConfigurationId).toBeNull();
    const restored = success(createConfiguration(document, '再開', { 幅: '15' }));
    expect(restored.activeConfigurationId).toBe(restored.configurations[0].id);
    expect(restored.parameters[0].value.value).toBe(15);
  });
  it('改名と削除は他の構成や式を保つ', () => {
    const document = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    const renamed = success(renameConfiguration(document, 'configuration-2', '小型'));
    expect(renamed.configurations[1].values).toBe(document.configurations[1].values);
    expect(success(deleteConfiguration(renamed, 'configuration-2')).parameters).toBe(document.parameters);
    expect(renameConfiguration(renamed, 'configuration-2', '既定')).toEqual({ ok: false, reason: 'duplicateName' });
  });
  it('通常の式変更を選択中の構成へ反映し、別の構成の値を保つ', () => {
    const document = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    const edited = synchronizeConfigurations({ ...document, parameters: [parameter('幅', '25'), parameter('穴径', '幅/2')] });
    expect(edited.configurations.map((item) => item.values['幅'])).toEqual(['25', '10']);
    expect(synchronizeConfigurations(edited)).toBe(edited);
  });
  it('パラメータ追加・削除を全構成へ反映する', () => {
    const document = success(createConfiguration(fixture(), '小', { 幅: '10' }));
    const changed = synchronizeConfigurations({ ...document, parameters: [parameter('幅', '20'), parameter('厚み', '3')] });
    expect(changed.configurations.map((item) => item.values)).toEqual([{ 幅: '20', 厚み: '3' }, { 幅: '10', 厚み: '3' }]);
  });
  it('改名は別構成の式へも字句単位で追従する', () => {
    const document = success(createConfiguration(fixture(), '小', { 幅: '10', 穴径: '幅/3' }));
    const renamed = renameConfigurationParameter(document, '幅', '横幅');
    expect(renamed.configurations.map((item) => item.values)).toEqual([{ 横幅: '20', 穴径: '横幅/2' }, { 横幅: '10', 穴径: '横幅/3' }]);
  });
  it('同じ入力では採番と評価が一致する', () => {
    const build = () => {
      const document = success(createConfiguration(fixture(), '小', { 幅: '10/3' }));
      return activateConfiguration(document, 'configuration-2');
    };
    expect(build()).toEqual(build());
  });
});
