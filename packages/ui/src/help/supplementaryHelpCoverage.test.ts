import { MANUAL_CHAPTERS } from '@pointercad/help-content';
import { describe, expect, it, vi } from 'vitest';
import { FILE_KIND_SPECS } from '../file/fileContracts.js';
import { DEFAULT_DISPLAY_SETTINGS } from '../settings/settings.js';
import { toolDefaultEntries } from '../settings/numericToolDefaults.js';
import { t } from '../i18n/t.js';
import { buildSupplementaryHelpCoverage } from './supplementaryHelpCoverage.js';

vi.mock('../store/useAppStore.js', () => { throw new Error('Reading the help inventory must not initialize the application store'); });

describe('設定・出力・道具の数値欄も実際の定義から説明先を棚卸しする', () => {
  it('全設定と全保存形式を含み、未対応のDWGを書き出せると記録しない', () => {
    const coverage = buildSupplementaryHelpCoverage(MANUAL_CHAPTERS);
    expect(coverage.settings.map(item => item.id).sort()).toEqual(Object.keys(DEFAULT_DISPLAY_SETTINGS).sort());
    expect(coverage.outputs.map(item => item.id).sort()).toEqual(Object.keys(FILE_KIND_SPECS).filter(id => id !== 'dwg').sort());
    expect(coverage.outputs.find(item => item.id === 'pcada')?.extensions).toEqual(['.pcada']);
    expect(coverage.outputs.find(item => item.id === 'jpg')?.extensions).toEqual(['.jpg', '.jpeg']);
    expect(coverage.outputs.find(item => item.id === 'zip')?.topicIds).toContain('joint');
    expect(coverage.contentCertified).toBe(false);
  });
  it('座標方式・板金・図面を含む既定値の全欄が実際と同じ名称と説明を持つ', () => {
    const coverage = buildSupplementaryHelpCoverage(MANUAL_CHAPTERS), actual = toolDefaultEntries();
    expect(coverage.toolDefaults.map(item => item.id)).toEqual(actual.map(item => item.id));
    expect(actual.some(item => item.sheetKey !== undefined)).toBe(true);
    expect(actual.some(item => item.drawingKey !== undefined)).toBe(true);
    expect(actual.some(item => item.mode === 'polar')).toBe(true);
    for (const [index, item] of actual.entries()) {
      expect(coverage.toolDefaults[index].fields).toEqual(item.fields.map(field => ({
        key: field.key, label: t(field.labelKey), hint: t(field.tooltipKey), unit: field.unit,
      })));
    }
  });
  it('設定または保存形式の説明章が消えたら、残りの章で成功扱いにしない', () => {
    for (const missing of ['display-settings', 'template', 'script-tools', 'joint', 'tutorial']) {
      expect(() => buildSupplementaryHelpCoverage(MANUAL_CHAPTERS.filter(topic => topic.id !== missing))).toThrow('Missing help chapter');
    }
    expect(() => buildSupplementaryHelpCoverage([...MANUAL_CHAPTERS, MANUAL_CHAPTERS[0]])).toThrow('Duplicate help topics');
  });
});
