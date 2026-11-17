import { serializeCsvReport } from '../file/csvReport.js';
import { buildSteelStockList, PRODUCT_CATALOG_REGISTRY, STEEL_EVIDENCE, type AssemblyDocument, type PartLibrary, type SteelEvidence,
  type SteelStockList } from '@pointercad/model';

import { saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { familyKindKey } from './catalogFamilyChoices.js';
import { steelShapeLabelKey } from './standardPartPicker.js';
import { DEFAULT_STOCK_CUTTING, type StockCuttingSettings } from './stockCuttingSettings.js';
import { catalogMiterNote, catalogStockCuttingRows, steelStockCuttingRows, stockCuttingView } from './stockCuttingView.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';

const CONDITIONS = {
  'hotRolled-heatTreatmentUnspecified': 'assembly.steel.hotRolled',
  'brightBar-heatTreatmentUnspecified': 'assembly.steel.brightBar',
  'blackPipe-plainEnds': 'assembly.steel.blackPipe',
  'whitePipe-zincCoated': 'assembly.steel.whitePipe',
  'rectTube-asManufactured': 'assembly.steel.rectTubeAsManufactured',
  'structuralPipe-plainEnds': 'assembly.steel.structuralPipePlainEnds',
  'lightGauge-coldFormed': 'assembly.steel.lightGaugeColdFormed',
  'stainlessPipe-solutionTreated-plainEnds': 'assembly.steel.stainlessPipeSolutionTreated',
} as const;
const GEOMETRIES = {
  profileSection: 'assembly.steel.csv.geometryProfile',
  simplifiedSection: 'assembly.steel.csv.geometrySimplified',
  nominal: 'assembly.steel.csv.geometryNominal',
} as const;
const ISSUE_LABELS = {
  unknownSteel: 'assembly.steel.omittedUnknown', unassignedMaterial: 'assembly.steel.omittedMaterial',
  missingAssembly: 'assembly.steel.omittedMissing', cycle: 'assembly.steel.omittedCycle',
  depthLimit: 'assembly.steel.omittedDepth',
} as const;
/** Appended after the original 14 columns so existing column positions stay stable. */
const PROVENANCE_HEADINGS = [
  'assembly.steel.csv.catalogRevision', 'assembly.steel.csv.generatorRevision', 'assembly.steel.csv.geometry',
  'assembly.steel.csv.sourceTitle', 'assembly.steel.csv.sourceEdition', 'assembly.steel.csv.sourceLocator',
  'assembly.steel.csv.sourceUrl', 'assembly.steel.csv.sourceSha256', 'assembly.steel.csv.sourceFetchedDate',
  'assembly.steel.csv.profileSource', 'assembly.steel.csv.materialSource', 'assembly.steel.csv.productStandardSource',
] as const;
const NO_PROVENANCE = PROVENANCE_HEADINGS.map(() => '');
/** Standards follow all 26 existing columns; evidence states are copied without promotion. */
const STANDARD_EDITION_HEADINGS = [
  'assembly.steel.materialStandardEdition', 'assembly.steel.materialStandardVerification',
  'assembly.steel.dimensionStandardEdition', 'assembly.steel.dimensionStandardVerification',
] as const;
const NO_STANDARD_EDITION = STANDARD_EDITION_HEADINGS.map(() => '');
const STANDARD_VERIFICATION_LABELS = {
  draft: 'assembly.steel.standardDraft', 'final-standard': 'assembly.steel.standardFinal',
  unverified: 'assembly.steel.standardUnverified',
} as const;

function standardEditionCells(product: SteelStockList['rows'][number]['product']): string[] {
  return [product.standardEdition.material, product.standardEdition.dimensions].flatMap((standard) => [
    `${standard.number}:${standard.edition || t('assembly.steel.standardUnverified')}`,
    t(STANDARD_VERIFICATION_LABELS[standard.verification]),
  ]);
}

export function steelStockIssueText(issue: SteelStockList['issues'][number]): string {
  return t(ISSUE_LABELS[issue.reason]);
}

/** An unprinted edition stays explicit; it is never inferred from a date or file name. */
function edition(evidence: SteelEvidence): string {
  return evidence.edition ?? t('assembly.steel.csv.editionNotPrinted');
}
/** One compact cell for a secondary source: title, edition, page, URL and the hash of the fetched bytes. */
function evidenceCell(evidence: SteelEvidence): string {
  return [evidence.title, edition(evidence), evidence.locator, evidence.url, `SHA-256 ${evidence.sha256}`,
    `${t('assembly.steel.csv.sourceFetchedDate')} ${evidence.fetchedDate}`].join(' ｜ ');
}
/** Saved revisions and existing catalog constants only; a legacy simplified row never shows profile evidence. */
function provenance(row: SteelStockList['rows'][number]): string[] {
  const { product } = row;
  const source = STEEL_EVIDENCE[product.evidence];
  return [row.catalogRevision, row.generatorRevision, t(GEOMETRIES[product.geometry]),
    source.title, edition(source), source.locator, source.url, source.sha256, source.fetchedDate,
    product.geometry === 'profileSection' && product.profileEvidence !== undefined
      ? evidenceCell(product.profileEvidence) : t('assembly.steel.csv.profileSourceNone'),
    product.materialEvidence === undefined ? t('assembly.steel.csv.sameAsDimensionSource')
      : evidenceCell(STEEL_EVIDENCE[product.materialEvidence]),
    product.productStandardEvidence === undefined ? t('assembly.steel.csv.sameAsDimensionSource')
      : evidenceCell(product.productStandardEvidence)];
}

/** 実物どおりの断面の形材の族(チャンネル・角パイプ・丸棒・フラットバー・アングル)の線図。この族の行の注記に「内側の形は簡略」を添えない。 */
const EXACT_SECTION_DIAGRAMS: ReadonlySet<string> = new Set(['channel', 'rectTube', 'roundBar', 'flatBar', 'angle']);

/**
 * 族の行の注記の列: 単位質量を持つ行だけ「単位質量 … kg/m」。断面の内側を簡略にした族(溝つきのフレーム)の行は「(内側の形は簡略)」を添える。
 * CSV に質量の列は足さない。
 */
function unitMassNote(row: SteelStockList['catalogRows'][number]): string {
  if (row.unitMassKgPerM === null) return '';
  const exact = EXACT_SECTION_DIAGRAMS.has(PRODUCT_CATALOG_REGISTRY.loaded(row.familyId)?.diagram ?? '');
  return t(exact ? 'catalog.stock.unitMassNoteExact' : 'catalog.stock.unitMassNote').split('{mass}').join(String(row.unitMassKgPerM));
}

/**
 * 族の行の形の扱いの列: 実物どおりの断面の形材の行は「資料の寸法どおりの断面」、ほか(溝つきのフレーム・ナットの素材など)は
 * 「資料の寸法で作った簡略の形」で、行が簡略にした所を持つ時はそれを添える(鋼材の旧版の簡略断面の文字は使わない)。
 */
function catalogGeometry(row: SteelStockList['catalogRows'][number]): string {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(row.familyId);
  const simplified = family?.rows.find((candidate) => candidate.key === row.itemKey)?.simplified ?? [];
  if (EXACT_SECTION_DIAGRAMS.has(family?.diagram ?? '') && simplified.length === 0) return t('catalog.stock.geometrySource');
  const base = t('catalog.stock.geometrySimplified');
  return simplified.length === 0 ? base : `${base}: ${simplified.join('・')}`;
}

/**
 * 長さを持つ族(フレームなど)の部品の行と、その合計の行(E-03)。鋼材の 30 列と同じ列に、族の種類・呼び・規格の欄・材質の表示・長さ・本数・
 * 出どころ(資料の題・頁・SHA。規格の行でない族は空)を入れる。族の部品が無い文書では行を作らない(鋼材だけの CSV は前と同じバイト)。
 */
function catalogStockRows(stock: SteelStockList): (string | number)[][] {
  if (stock.catalogRows.length === 0) return [];
  const rows: (string | number)[][] = stock.catalogRows.map((row) => [t('assembly.steel.csv.cut'), row.materialLabel ?? '', '',
    row.standardLabel, t(familyKindKey(row.kindKey)), row.size, '', row.lengthMm, row.quantity, row.totalLengthMm,
    JSON.stringify(row.occurrencePaths), unitMassNote(row) + catalogMiterNote(row), '', t('assembly.steel.finishedUnknown'),
    row.catalogRevision, row.generatorRevision, catalogGeometry(row), row.evidence.title, edition(row.evidence),
    row.evidence.locator, row.evidence.url, row.evidence.sha256, row.evidence.fetchedDate, t('assembly.steel.csv.profileSourceNone'),
    t('assembly.steel.csv.sameAsDimensionSource'), t('assembly.steel.csv.sameAsDimensionSource'), ...NO_STANDARD_EDITION]);
  rows.push([t('catalog.stock.total'), '', '', '', '', '', '', '', stock.catalogRows.reduce((total, row) => total + row.quantity, 0),
    stock.catalogRows.reduce((total, row) => total + row.totalLengthMm, 0), '', '', '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
  return rows;
}

/**
 * 定尺への割り付けの行(J-01 包み 7)。定尺を入れた時だけ、組(同じ鋼材・同じ族の呼び)ごとに 1 行: 種類の欄に「定尺への割り付け」、
 * 素材購入長の列に定尺、数量の列に棒の本数、注記の列に要約と棒ごとの切り出し。定尺が無い時は行を作らない(前と同じバイト)。
 */
function stockCuttingCsvRows(stock: SteelStockList, settings: StockCuttingSettings): (string | number)[][] {
  const view = stockCuttingView([...steelStockCuttingRows(stock.rows),
    ...catalogStockCuttingRows(stock.catalogRows, (kindKey) => t(familyKindKey(kindKey)))], settings);
  if (view.kind === 'noStock') return [];
  return view.groups.map((group) => [t('catalog.stockCutting.title'), '', '', '', '', '', '', settings.stockLengthMm ?? '',
    group.bars.length, '', '', [group.summary, ...group.bars].join(' / '), '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
}

/** UTF-8 BOM for Japanese spreadsheets; every report includes scope, totals and all omissions. */
export function serializeSteelStockCsv(stock: SteelStockList, stockCutting: StockCuttingSettings = DEFAULT_STOCK_CUTTING): Uint8Array {
  const rows: (string | number)[][] = [[
    t('assembly.steel.csv.kind'), t('assembly.steel.material'), t('assembly.steel.csv.materialStandard'),
    t('assembly.steel.csv.productStandard'), t('assembly.steel.shape'), t('assembly.standardPart.size'),
    t('assembly.steel.csv.condition'), `${t('assembly.steel.stockLength')} (mm)`,
    t('assembly.steel.quantity'), `${t('assembly.steel.totalLength')} (mm)`,
    t('assembly.steel.csv.paths'), t('assembly.steel.csv.notice'), t('assembly.steel.csv.assemblyRef'),
    `${t('assembly.steel.finishedLength')} (mm)`, ...PROVENANCE_HEADINGS.map((key) => t(key)), ...STANDARD_EDITION_HEADINGS.map((key) => t(key)),
  ]];
  rows.push([t('assembly.steel.csv.scope'), '', '', '', '', '', '', '', '', '', '', t('assembly.steel.stockScope'), '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
  for (const row of stock.rows) {
    rows.push([t('assembly.steel.csv.cut'), row.product.materialGrade, row.product.materialStandard,
      row.product.productStandard, t(steelShapeLabelKey(row.product.catalog, row.product.materialGrade)), row.product.size,
      t(CONDITIONS[row.product.condition]), row.lengthMm, row.quantity, row.totalLengthMm,
      JSON.stringify(row.occurrencePaths), catalogMiterNote(row), '', row.finishedLengthMm ?? t('assembly.steel.finishedUnknown'),
      ...provenance(row), ...standardEditionCells(row.product)]);
  }
  rows.push([t('assembly.steel.stockTotal'), '', '', '', '', '', '', '', stock.totalQuantity, stock.totalLengthMm, '',
    stock.issues.length === 0 ? '' : t('assembly.steel.stockPartial'), '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
  rows.push(...catalogStockRows(stock));
  rows.push(...stockCuttingCsvRows(stock, stockCutting));
  for (const issue of stock.issues) {
    rows.push([t('assembly.steel.csv.omitted'), '', '', '', '', '', '', '', '', '',
      JSON.stringify(issue.occurrencePath), steelStockIssueText(issue), issue.assemblyRef ?? '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
  }
  return serializeCsvReport(rows);
}

interface SteelStockCsvAttempt {
  readonly pending: { current: AbortController | null };
  readonly assembly: AssemblyDocument;
  readonly library: PartLibrary;
  readonly busy: (value: boolean) => void;
  readonly error: (value: string) => void;
  readonly status: (value: string) => void;
}

/** Keep one save owned by this assembly/library/session and the open picker. */
export async function exportSteelStockCsv(attempt: SteelStockCsvAttempt): Promise<void> {
  const { pending, assembly, library } = attempt;
  if (pending.current !== null) return;
  const controller = new AbortController();
  const owner = useAppStore.getState();
  const ownerCurrent = (): boolean => {
    const state = useAppStore.getState();
    return activeDocumentKind(state) === 'assembly' && state.standardPartPickerOpen
      && state.activeDocumentId === owner.activeDocumentId && state.assembly === assembly
      && state.assemblyLibrary === library && state.fileGateway === owner.fileGateway;
  };
  if (!ownerCurrent()) return;
  pending.current = controller;
  const current = (): boolean => pending.current === controller && !controller.signal.aborted && ownerCurrent();
  const release = (): void => {
    if (pending.current === controller) { pending.current = null; attempt.busy(false); }
  };
  const unsubscribe = useAppStore.subscribe(() => { if (!ownerCurrent()) controller.abort(); });
  const cancelled = (): void => { unsubscribe(); release(); };
  controller.signal.addEventListener('abort', cancelled, { once: true });
  attempt.busy(true);
  attempt.error('');
  attempt.status('');
  try {
    const stock = buildSteelStockList(assembly, library.assemblies, library.parts);
    const saved = await saveFileAsThrough(owner.fileGateway, 'steel-stock-list.csv', 'csv',
      serializeSteelStockCsv(stock, owner.displaySettings.stockCutting), { signal: controller.signal, isCurrent: current });
    if (current()) attempt.status(t(saved ? 'assembly.steel.csv.saved' : 'assembly.steel.csv.cancelled'));
  } catch (error) {
    if (current()) attempt.error(error instanceof Error ? error.message : t('assembly.steel.csv.failed'));
  } finally {
    unsubscribe();
    controller.signal.removeEventListener('abort', cancelled);
    release();
  }
}
