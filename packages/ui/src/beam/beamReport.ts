import type { RenderDocument } from '@pointercad/drawing';
import type { BeamAnalysisDocument, BeamAnalysisResult, PropertySource } from '@pointercad/model/beam-analysis';
import { t, type MessageKey } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';
import type { BeamMemberDraft } from './beamSession.js';
import { beamReportFigure } from './beamReportFigure.js';
import { layoutBeamReport, type OutlineText, type ReportTable } from './beamReportLayout.js';

type Conditions = Pick<BeamAnalysisDocument, 'id' | 'revision' | 'source' | 'units' | 'nodes' | 'members' |
  'materials' | 'sections' | 'constraints' | 'loads'>;

interface MemberLabel extends Pick<BeamMemberDraft, 'id'> {
  readonly occurrence: Pick<BeamMemberDraft['occurrence'], 'label'>;
}

/** Pass the evaluated static conditions used for this result, including the world-space node positions. */
export interface BeamReportInput {
  readonly analysisName: string;
  readonly documentName: string;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly members: readonly MemberLabel[];
  readonly conditions: Conditions;
  readonly result: BeamAnalysisResult;
}

// Keep the beam readout when it already meets report precision. Round the original value once,
// including tiny dimensionless residuals that must not be compared to a sketch length tolerance.
function number(value: number): string {
  const readout = beamDisplayNumber(value);
  const rounded = Number(value.toPrecision(6));
  return Number(readout) === rounded ? readout : String(rounded);
}
const vector = (values: readonly number[], factor = 1): string => values.map(value => number(value * factor)).join('  ');

const sourceKeys: Readonly<Record<PropertySource['kind'], MessageKey>> = {
  'user-supplied': 'beam.source.user', measured: 'beam.source.measured', published: 'beam.source.published',
};
function provenance(source: PropertySource): string {
  return [t(sourceKeys[source.kind]), source.reference, source.condition].filter(Boolean).join(' / ');
}

function conditionTables(input: BeamReportInput): ReportTable[] {
  const { conditions } = input;
  const mm = conditions.units === 'N-mm' ? 1 : 1000;
  const labels = new Map(input.members.map(member => [member.id, member.occurrence.label]));
  return [
    { id: 'scope', widths: [180], rows: [[t('beam.scope')], [t('beam.resultScope')], [t('beam.report.units')]] },
    { id: 'materials', title: t('beam.material'), widths: [31, 23, 23, 15, 24, 64],
      headings: [t('beam.report.materialId'), 'E (MPa)', 'G (MPa)', t('beam.weldPoisson'), t('beam.density') + ' (kg/m³)', t('beam.provenance')],
      rows: conditions.materials.map(m => [m.id, number(m.youngModulus / mm ** 2), number(m.shearModulus / mm ** 2),
        number(m.youngModulus / (2 * m.shearModulus) - 1), number(m.densityKgM3), provenance(m.source)]) },
    { id: 'sections', title: t('beam.section'), widths: [31, 22, 22, 22, 22, 17, 44],
      headings: [t('beam.report.sectionId'), 'A (mm²)', 'Iy (mm⁴)', 'Iz (mm⁴)', 'J (mm⁴)', t('beam.shearFactor'), t('beam.provenance')],
      rows: conditions.sections.map(s => [s.id, number(s.area * mm ** 2), number(s.iy * mm ** 4), number(s.iz * mm ** 4),
        number(s.torsionConstant * mm ** 4), number(s.shearFactor), provenance(s.source)]) },
    { id: 'members', title: t('beam.members'), widths: [26, 46, 23, 23, 31, 31],
      headings: ['ID', t('beam.transientAxialMember'), t('beam.report.startNode'), t('beam.report.endNode'),
        t('beam.report.materialId'), t('beam.report.sectionId')],
      rows: conditions.members.map(m => [m.id, labels.get(m.id) ?? m.componentId, m.startNodeId, m.endNodeId, m.materialId, m.sectionId]) },
    { id: 'supports', title: t('beam.report.supports'), widths: [50, 130], headings: ['ID', t('beam.node')],
      rows: conditions.constraints.map(c => [c.id, c.nodeId]) },
    { id: 'loads', title: t('beam.report.loads'), widths: [30, 34, 58, 58],
      headings: ['ID', t('beam.node'), 'Fx  Fy  Fz (N)', 'Mx  My  Mz (N·mm)'],
      rows: conditions.loads.map(l => [l.id, l.nodeId, vector(l.force), vector(l.moment, mm)]) },
  ];
}

function resultTables(result: BeamAnalysisResult): ReportTable[] {
  const { nodes, balance } = result;
  const peak = nodes.reduce((best, node) => {
    const magnitude = Math.hypot(...node.displacementM);
    return magnitude > best.magnitude ? { magnitude, id: node.nodeId } : best;
  }, { magnitude: -1, id: '' });
  if (peak.magnitude < 0) throw new Error(t('beam.error.model'));
  return [
    { id: 'summary', title: t('beam.report.summary'), widths: [78, 102], rows: [
      [t('beam.report.peak'), number(peak.magnitude * 1000) + ' mm  (' + peak.id + ')'],
      [t('beam.report.balanceForce'), vector(balance.forceN)],
      [t('beam.report.balanceMoment'), vector(balance.momentNm, 1000)],
      [t('beam.report.referencePoint'), vector(balance.referenceM, 1000)],
      [t('beam.report.freeResidual'), number(balance.maximumFreeResidual)],
    ] },
    { id: 'nodes', title: t('beam.results'), widths: [25, 38, 36, 37, 44],
      headings: [t('beam.node'), t('beam.displacement'), t('beam.rotation'), t('beam.reaction'), t('beam.reactionMoment')],
      rows: nodes.map(n => [n.nodeId, vector(n.displacementM, 1000), vector(n.rotationRad),
        n.constrained ? vector(n.reactionN) : '—', n.constrained ? vector(n.reactionNm, 1000) : '—']) },
    { id: 'ends', title: t('beam.report.endForces'), widths: [24, 36, 42, 36, 42],
      headings: [t('beam.transientAxialMember'), t('beam.report.startForce'), t('beam.report.startMoment'),
        t('beam.report.endForce'), t('beam.report.endMoment')],
      rows: result.elements.map(e => [e.memberId, vector(e.start.slice(0, 3)), vector(e.start.slice(3), 1000),
        vector(e.end.slice(0, 3)), vector(e.end.slice(3), 1000)]) },
  ];
}

export function buildBeamReport(input: BeamReportInput, outlineText: OutlineText): readonly RenderDocument[] {
  const { conditions, result } = input;
  if (conditions.id !== result.analysisId || conditions.revision !== result.analysisRevision ||
    conditions.source.documentId !== result.source.documentId || conditions.source.documentRevision !== result.source.documentRevision ||
    conditions.source.geometryRevision !== result.source.geometryRevision) throw new Error(t('beam.error.model'));
  const header = (page: number): readonly string[] => [t('beam.report.title') + '    ' + t('beam.report.page').replace('{page}', String(page)),
    t('beam.report.document') + '  ' + input.documentName + '    ' + t('beam.report.analysis') + '  ' + input.analysisName,
    t('beam.report.exported') + '  ' + input.exportedAt + '    ' + t('beam.report.version') + '  ' + input.appVersion];
  return layoutBeamReport(header, [...conditionTables(input), ...resultTables(result)], beamReportFigure(conditions, result), outlineText);
}
