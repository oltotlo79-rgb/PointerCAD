import type { BeamAnalysisDocument, Vector3 } from './analysisModel.js';
import { translateBeamAnalysis, type OofemBeamPlan } from './analysisTranslation.js';

export interface OofemModalPlan extends Omit<OofemBeamPlan, 'schema'> {
  readonly schema: 'pointercad-oofem-modal-plan/1';
  readonly modeCount: number;
  readonly originalNodeCount: number;
  readonly normalizationLengthM: number;
}

/** Refined nodes are solver-only data and never replace saved CAD associations. */
export function translateBeamModal(value: unknown): {
  readonly document: BeamAnalysisDocument;
  readonly plan: OofemModalPlan;
} {
  const prepared = translateBeamAnalysis(value);
  const settings = prepared.document.modal;
  if (settings === undefined) throw new Error('modal-required: explicit modal schema 2 is required');
  const nodes = [...prepared.plan.nodes];
  const members: OofemBeamPlan['members'][number][] = [];
  const count = settings.segmentsPerMember;
  const usedIds = new Set(nodes.map(node => node.id));
  for (const member of prepared.plan.members) {
    const start = nodes[member.nodes[0] - 1];
    const end = nodes[member.nodes[1] - 1];
    let prior = member.nodes[0];
    for (let segment = 1; segment <= count; segment += 1) {
      let next = member.nodes[1];
      if (segment < count) {
        next = nodes.length + 1;
        let id = `modal-interior-${next}`;
        while (usedIds.has(id)) id += '-';
        usedIds.add(id);
        const fraction = segment / count;
        const positionM: Vector3 = [
          start.positionM[0] + fraction * (end.positionM[0] - start.positionM[0]),
          start.positionM[1] + fraction * (end.positionM[1] - start.positionM[1]),
          start.positionM[2] + fraction * (end.positionM[2] - start.positionM[2]),
        ];
        nodes.push({ number: next, id, positionM, fixed: false, load: [0, 0, 0, 0, 0, 0] });
      }
      members.push({ ...member, number: members.length + 1, nodes: [prior, next],
        frame: { ...member.frame, lengthM: member.frame.lengthM / count } });
      prior = next;
    }
  }
  const minimum = [0, 1, 2].map(axis => Math.min(...nodes.map(node => node.positionM[axis])));
  const maximum = [0, 1, 2].map(axis => Math.max(...nodes.map(node => node.positionM[axis])));
  const normalizationLengthM = Math.hypot(...maximum.map((value, axis) => value - minimum[axis]));
  if (!Number.isFinite(normalizationLengthM) || normalizationLengthM <= 1e-9) {
    throw new Error('modal-scale: invalid normalization length');
  }
  return { document: prepared.document, plan: {
    ...prepared.plan, schema: 'pointercad-oofem-modal-plan/1', nodes, members,
    modeCount: settings.modeCount, originalNodeCount: prepared.plan.nodes.length, normalizationLengthM,
  } };
}
