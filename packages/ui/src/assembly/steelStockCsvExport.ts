import { buildSteelStockList, STEEL_EVIDENCE, type AssemblyDocument, type PartLibrary, type SteelEvidence,
  type SteelStockList, type SteelSectionCatalog } from '@pointercad/model';

import { saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';

const SHAPES: Readonly<Record<SteelSectionCatalog, Parameters<typeof t>[0]>> = {
  flatBar: 'assembly.steel.flatBar', roundBar: 'assembly.steel.roundBar',
  steelPipe: 'assembly.steel.steelPipe', equalAngle: 'assembly.steel.equalAngle',
  channel: 'assembly.steel.channel', hBeam: 'assembly.steel.hBeam',
};
const CONDITIONS = {
  'hotRolled-heatTreatmentUnspecified': 'assembly.steel.hotRolled',
  'brightBar-heatTreatmentUnspecified': 'assembly.steel.brightBar',
  'blackPipe-plainEnds': 'assembly.steel.blackPipe',
  'whitePipe-zincCoated': 'assembly.steel.whitePipe',
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

/** Quoting controls field boundaries, while the visible prefix controls spreadsheet interpretation.
 * Follow parameterCsv's text: convention, including whitespace/control and width variants.
 * CSV is an output report; it is not an import format or a lossless CAD document.
 */
function cell(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && (/^[=+@'\-\p{White_Space}\p{Cc}\p{Cf}]/u.test(text)
    || /^[＝＋－＠−]/u.test(text) || text.startsWith('text:'))) text = `text:${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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

/** UTF-8 BOM for Japanese spreadsheets; every report includes scope, totals and all omissions. */
export function serializeSteelStockCsv(stock: SteelStockList): Uint8Array {
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
      row.product.productStandard, t(SHAPES[row.product.catalog]), row.product.size,
      t(CONDITIONS[row.product.condition]), row.lengthMm, row.quantity, row.totalLengthMm,
      JSON.stringify(row.occurrencePaths), '', '', row.finishedLengthMm ?? t('assembly.steel.finishedUnknown'),
      ...provenance(row), ...standardEditionCells(row.product)]);
  }
  rows.push([t('assembly.steel.stockTotal'), '', '', '', '', '', '', '', stock.totalQuantity, stock.totalLengthMm, '',
    stock.issues.length === 0 ? '' : t('assembly.steel.stockPartial'), '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
  for (const issue of stock.issues) {
    rows.push([t('assembly.steel.csv.omitted'), '', '', '', '', '', '', '', '', '',
      JSON.stringify(issue.occurrencePath), steelStockIssueText(issue), issue.assemblyRef ?? '', '', ...NO_PROVENANCE, ...NO_STANDARD_EDITION]);
  }
  return new TextEncoder().encode(String.fromCharCode(0xfeff) + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
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
      serializeSteelStockCsv(stock), { signal: controller.signal, isCurrent: current });
    if (current()) attempt.status(t(saved ? 'assembly.steel.csv.saved' : 'assembly.steel.csv.cancelled'));
  } catch (error) {
    if (current()) attempt.error(error instanceof Error ? error.message : t('assembly.steel.csv.failed'));
  } finally {
    unsubscribe();
    controller.signal.removeEventListener('abort', cancelled);
    release();
  }
}
