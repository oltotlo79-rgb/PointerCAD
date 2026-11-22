import type { RenderDocument } from '@pointercad/drawing';
import type { CadSolidOutcome } from '@pointercad/fem';
import type { SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { addVec3, lengthVec3, scaleVec3, type Vec3 } from '@pointercad/model/vec3';
import { layoutAnalysisReport, type OutlineText, type ReportFigure, type ReportTable } from '../analysisReport/reportLayout.js';
import { t, type MessageKey } from '../i18n/t.js';
import { vonMisesMPa } from './solidFieldView.js';
import { solidResultScalars } from './solidResultScalars.js';

type SolidOutcome = Extract<CadSolidOutcome, { readonly kind: 'result' }>;

/**
 * Significant digits of the report numbers: the 6 digits of the screen (利用者の決定 2026-11-14). As in the beam report, a small
 * value is rounded once and never zeroed by a length tolerance (stresses, energies and residuals are not lengths).
 */
const REPORT_SIGNIFICANT_DIGITS = 6;
const number = (value: number): string => String(Number(value.toPrecision(REPORT_SIGNIFICANT_DIGITS)));
const vector = (values: readonly number[]): string => values.map(number).join('  ');
const withUnit = (text: string, unit: MessageKey): string => text + ' ' + t(unit);

/** The static solid result to report and the saved input it was computed from (the panel only shows a result of that input). */
export interface SolidReportInput {
  readonly analysisName: string;
  readonly documentName: string;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly definition: SolidCadSavedInput;
  readonly outcome: SolidOutcome;
}

/** One row per directional support: the prescribed displacement of each fixed axis, '—' for a free one (as the beam report). */
function supportRows(definition: SolidCadSavedInput): string[][] {
  return (definition.supports ?? []).map((support, index) => [
    t('solidAnalysis.report.supportFace').replace('{face}', String(index + 1)),
    support.fixed.map((fixed, axis) => fixed ? number(support.prescribedMm?.[axis] ?? 0) : '—').join('  ')]);
}

function loadRows(definition: SolidCadSavedInput, outcome: SolidOutcome): string[][] {
  const load = definition.load === 'pressure' ? [t('solidAnalysis.pressure'), number(definition.pressureMPa)]
    : [t('solidAnalysis.loadTraction'), vector(definition.tractionMPa) + ' N/mm²'];
  const gravity = definition.gravity === undefined ? [] : [
    [t('solidAnalysis.gravityTitle'), vector(definition.gravity.accelerationMps2) + ' m/s²'],
    [t('solidAnalysis.gravityDensity'), number(definition.gravity.densityKgM3)]];
  return [[t('solidAnalysis.report.loadedFaces'), String(definition.loadedFaces.length)], load,
    [t('solidAnalysis.area'), withUnit(number(outcome.prepared.loadedAreaMm2), 'solidAnalysis.unitLength') + '²'],
    [t('solidAnalysis.force'), withUnit(vector(outcome.prepared.totalForceN), 'solidAnalysis.unitForce')], ...gravity];
}

function conditionTables(input: SolidReportInput): ReportTable[] {
  const { definition, outcome } = input, mesh = outcome.prepared.input;
  return [
    { id: 'scope', widths: [180], rows: [[t('solidAnalysis.resultLimit')], [t('solidAnalysis.report.units')]] },
    { id: 'conditions', title: t('solidAnalysis.report.conditions'), widths: [100, 80], rows: [
      [t('solidAnalysis.body'), definition.bodyFeatureId],
      [t('solidAnalysis.young'), number(definition.youngMPa)],
      [t('solidAnalysis.poisson'), number(definition.poisson)],
      [t('solidAnalysis.report.fixedFaces'), String(definition.fixedFaces.length)],
      ...supportRows(definition),
      ...loadRows(definition, outcome),
      [t('solidAnalysis.report.mesh'), String(mesh.nodes.length) + ' / ' + String(mesh.elements.length)],
      [t('solidAnalysis.linear'), number(definition.linearDeflectionMm)],
      [t('solidAnalysis.angular'), number(definition.angularDeflectionRad)],
      [t('solidAnalysis.chord'), number(definition.maximumChordDeviationMm)],
      [t('solidAnalysis.volume'), number(definition.maximumVolumeDeviationMm3)],
    ] },
  ];
}

/** Index of the largest value (the first one on a tie); -1 for an empty list. */
function largest(values: readonly number[]): number {
  let found = -1;
  values.forEach((value, index) => { if (found < 0 || value > values[found]) found = index; });
  return found;
}

/** Where the largest displacement and the largest von Mises stress are: node and element numbers from 1, in mm. */
function peaks(outcome: SolidOutcome): { readonly node: number; readonly element: number; readonly centroid: Vec3 } {
  const { nodes, elements } = outcome.prepared.input;
  const node = largest(outcome.result.displacementMm.map(value => lengthVec3(value)));
  const element = largest(outcome.result.elements.map(value => vonMisesMPa(value.stressMPa)));
  if (node < 0 || element < 0) throw new Error(t('solidAnalysis.failed'));
  const corners = elements[element].nodes.map(index => nodes[index]);
  const centroid = scaleVec3(corners.reduce<Vec3>((sum, corner) => addVec3(sum, corner), [0, 0, 0]), 1 / corners.length);
  return { node, element, centroid };
}

function resultTable(outcome: SolidOutcome): ReportTable {
  const scalars = solidResultScalars({ displacementMm: outcome.result.displacementMm, reactionN: outcome.result.reactionN,
    elements: outcome.result.elements });
  const where = peaks(outcome), nodePosition = outcome.prepared.input.nodes[where.node];
  return { id: 'summary', title: t('analysisReport.summary'), widths: [100, 80], rows: [
    [t('solidAnalysis.report.peakDisplacement'), withUnit(number(scalars.maximumDisplacement), 'solidAnalysis.unitLength')
      + '  (' + String(where.node + 1) + ': ' + vector(nodePosition) + ')'],
    [t('solidAnalysis.report.peakStress'), withUnit(number(scalars.maximumVonMises), 'solidAnalysis.unitStress')
      + '  (' + String(where.element + 1) + ': ' + vector(where.centroid) + ')'],
    [t('solidAnalysis.reaction'), withUnit(vector(scalars.reaction), 'solidAnalysis.unitForce')],
    [t('solidAnalysis.energy'), withUnit(number(outcome.result.strainEnergyNmm), 'solidAnalysis.unitEnergy')],
    [t('solidAnalysis.residual'), number(outcome.result.maximumRelativeEquilibriumResidual)],
  ] };
}

/** The caption of the stress figure: its colour range and, when some were too small to print, how many triangles were left out. */
export function solidReportCaption(minimum: number, maximum: number, dropped: number): string {
  const range = t('solidAnalysis.report.figure').replace('{min}', number(minimum)).replace('{max}', number(maximum));
  return dropped === 0 ? range : range + '  ' + t('solidAnalysis.report.figureDropped').replace('{count}', String(dropped));
}

/**
 * A4 report of a static solid result (J-03c stage 2): the same header, page layout and number rounding as the beam report,
 * the conditions, the summary of the result and the stress figure. The result must belong to the passed saved input.
 */
export function buildSolidReport(input: SolidReportInput, figure: ReportFigure, outlineText: OutlineText): readonly RenderDocument[] {
  const { definition, outcome } = input;
  if (outcome.result.source.documentId !== definition.source.documentId) throw new Error(t('analysisReport.unavailable'));
  const header = (page: number): readonly string[] => [
    t('solidAnalysis.report.title') + '    ' + t('analysisReport.page').replace('{page}', String(page)),
    t('analysisReport.document') + '  ' + input.documentName + '    ' + t('analysisReport.analysis') + '  ' + input.analysisName,
    t('analysisReport.exported') + '  ' + input.exportedAt + '    ' + t('analysisReport.version') + '  ' + input.appVersion];
  return layoutAnalysisReport(header, [...conditionTables(input), resultTable(outcome)], figure, outlineText);
}
