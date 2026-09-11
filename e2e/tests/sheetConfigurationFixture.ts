import { exactExpressionValueFromNumber as n } from '../../packages/expression/src/index.js';
import { createConfiguration, createDefaultConfigurations } from '../../packages/model/src/part/configurations.js';
import { applyParameters } from '../../packages/model/src/part/reevaluatePart.js';
import { resolvePart } from '../../packages/model/src/part/resolvePart.js';
import type { Parameter } from '../../packages/model/src/parameters/types.js';
import { sheetPerformanceFixture } from '../../packages/model/src/sheetMetal/testing/sheetPerformanceFixture.js';
import { writePcadFile } from '../../packages/io/src/index.js';

/** 値の異なる二構成。保存するのは式と展開条件だけで、B-repは実アプリが計算する。 */
export function sheetConfigurationFile(): Uint8Array {
  const original = sheetPerformanceFixture(1);
  const parameters: readonly Parameter[] = [
    { name: '板厚', value: n(2), unit: 'mm', description: '板金全体の厚み' },
    { name: '内半径', value: n(3), unit: 'mm', description: '基板から継承する曲げ半径' },
    { name: 'K値', value: n(0.4), unit: 'none', description: '製造条件の中立面係数' },
    { name: '腕長', value: n(20), unit: 'mm', description: '両側フランジの直線長' },
  ];
  const evaluated = applyParameters({ ...original, name: '切欠き付きU板の二構成', parameters,
    configurations: createDefaultConfigurations(parameters), activeConfigurationId: 'configuration-1',
    solids: original.solids.map((feature) => feature.kind === 'sheetBase'
      ? { ...feature, rule: { thickness: { ...n(2), source: '板厚' }, innerRadius: { ...n(3), source: '内半径' }, kFactor: { ...n(0.4), source: 'K値' } } }
      : feature.kind === 'sheetFlange' ? { ...feature, length: { ...n(20), source: '腕長' } } : feature),
  });
  const created = createConfiguration(evaluated.document, '厚板', { 板厚: '3', 内半径: '4', K値: '0.3', 腕長: '25' });
  if (!created.ok) throw new Error(`板金の構成を作れません: ${created.reason}`);
  const body = resolvePart(created.document).sheetMetalBodies?.get('relief-0');
  if (!body) throw new Error('切欠きまで解決されたU板が必要です');
  return writePcadFile({ ...created.document,
    sheetUnfolds: [{ sourceFeatureId: 'relief-0', fixedPanelId: body.panels[0].id, seamConnectionIds: [] }],
  });
}

export const SHEET_CONFIGURATIONS = {
  default: { folded: 7000 + 400 * Math.PI - 780 / 19, flat: 7000 + 380 * Math.PI - 40 },
  thick: { folded: 12000 + 825 * Math.PI - 30 - 165 / 4.9, flat: 12000 + 735 * Math.PI - 60 },
} as const;
