/**
 * 長さを持つ族(フレームなど)の部品の切断の一覧の小さな表(E-03。model の `buildSteelStockList` の catalogRows)。
 * 開いているアセンブリに置いた族の部品を、種類・呼び・長さで束ね、本数・合計の長さ・質量(行の材質の密度)を出す。
 * 鋼材の切断の一覧(鋼材の窓)とは別に、族の窓の中に出す。表示だけで、文書は変えない。
 */
import { buildSteelStockList, type SteelStockList } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { formatBomMass } from './bomTableRows.js';
import { familyKindKey } from './catalogFamilyChoices.js';
import { StockCuttingFields } from './StockCuttingFields.js';
import { catalogStockCuttingRows } from './stockCuttingView.js';

/** 表の 1 行の文字(種類・呼び・長さ・本数・合計の長さ・合計の質量)。 */
function catalogStockCells(row: SteelStockList['catalogRows'][number]): readonly string[] {
  return [t(familyKindKey(row.kindKey)), row.size, String(row.lengthMm), String(row.quantity), String(row.totalLengthMm),
    formatBomMass(row.massTotalG)];
}

export function CatalogStockTable(): React.JSX.Element | null {
  const assembly = useAppStore((state) => state.assembly);
  const library = useAppStore((state) => state.assemblyLibrary);
  if (assembly === null) return null;
  const rows = buildSteelStockList(assembly, library.assemblies, library.parts).catalogRows;
  return (
    <details className="pcad-popover__hint">
      <summary>{t('catalog.stock.title')}</summary>
      {rows.length === 0 ? <p>{t('catalog.stock.empty')}</p> : <table>
        <thead><tr>
          <th scope="col">{t('catalog.stock.kind')}</th><th scope="col">{t('assembly.standardPart.size')}</th>
          <th scope="col">{t('assembly.steel.stockLength')} (mm)</th><th scope="col">{t('assembly.steel.quantity')}</th>
          <th scope="col">{t('assembly.steel.totalLength')} (mm)</th><th scope="col">{t('catalog.stock.mass')}</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key}>{catalogStockCells(row).map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table>}
      {rows.length === 0 ? null : <StockCuttingFields rows={catalogStockCuttingRows(rows, (kindKey) => t(familyKindKey(kindKey)))} />}
    </details>
  );
}
