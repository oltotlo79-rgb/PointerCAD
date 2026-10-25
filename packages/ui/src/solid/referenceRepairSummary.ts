import type { SubShapeRef } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';

const originLabels: Readonly<Record<NonNullable<SubShapeRef['origin']>['identity']['kind'], MessageKey>> = {
  'box-face': 'propertyPanel.repair.boxFace', 'box-edge': 'propertyPanel.repair.boxEdge', 'box-vertex': 'propertyPanel.repair.boxVertex',
  'cylinder-face': 'propertyPanel.repair.cylinderFace', 'cylinder-edge': 'propertyPanel.repair.cylinderEdge', 'cylinder-vertex': 'propertyPanel.repair.cylinderVertex',
  'surface-side': 'propertyPanel.repair.surfaceSide',
  'extrude-side': 'propertyPanel.repair.extrudeSide', 'extrude-cap': 'propertyPanel.repair.extrudeCap',
  'extrude-curve-side': 'propertyPanel.repair.extrudeSide', 'extrude-curve-cap': 'propertyPanel.repair.extrudeCap',
  'blend-face': 'propertyPanel.repair.blendFace', 'merged-face': 'propertyPanel.repair.mergedFace',
  'hole-face': 'propertyPanel.repair.holeFace',
  'sphere-face': 'propertyPanel.repair.sphereFace',
  'cone-face': 'propertyPanel.repair.coneFace', 'torus-face': 'propertyPanel.repair.torusFace',
  'merged-edge': 'propertyPanel.repair.mergedEdge', 'merged-vertex': 'propertyPanel.repair.mergedVertex',
  'face-intersection-edge': 'propertyPanel.repair.intersectionEdge', 'face-intersection-vertex': 'propertyPanel.repair.intersectionVertex',
};
const roleLabels: Readonly<Record<string, MessageKey>> = {
  surface: 'propertyPanel.repair.surface',
  top: 'propertyPanel.repair.top', bottom: 'propertyPanel.repair.bottom', front: 'propertyPanel.repair.front', back: 'propertyPanel.repair.back',
  left: 'propertyPanel.repair.left', right: 'propertyPanel.repair.right', start: 'propertyPanel.repair.start', end: 'propertyPanel.repair.end',
  side: 'propertyPanel.repair.side', wall: 'propertyPanel.repair.side', floor: 'propertyPanel.repair.bottom', seam: 'propertyPanel.repair.seam', ring: 'propertyPanel.repair.ring',
};

export function summarizeRepairReference(reference: SubShapeRef): string {
  const fp = reference.fingerprint, origin = reference.origin?.identity;
  const kind = t(fp.kind === 'face' ? 'propertyPanel.repair.face' : fp.kind === 'edge' ? 'propertyPanel.repair.edge' : 'propertyPanel.repair.vertex');
  const role = origin?.kind === 'hole-face' && origin.role === 'entry-cap' ? t('propertyPanel.holeEntry')
    : origin !== undefined && 'role' in origin ? origin.role.split('-').map(part => {
    const key = roleLabels[part]; return key === undefined ? part : t(key);
  }).join(t('display.listSeparator')) : origin !== undefined && 'end' in origin ? t(roleLabels[origin.end]) : '';
  const meaning = origin === undefined ? t('propertyPanel.repair.geometryIdentity') : `${t(originLabels[origin.kind])} ${role}`;
  const position = fp.position.map(value => String(Number(value.toPrecision(9)))).join(', ');
  const size = fp.kind === 'face' ? t('propertyPanel.repair.area').replace('{value}', String(fp.area))
    : fp.kind === 'edge' ? t('propertyPanel.repair.length').replace('{value}', String(fp.length)) : '';
  const source = origin?.kind === 'extrude-side' || origin?.kind === 'surface-side' ? ` / ${origin.profile.sketchId} / ${origin.profile.lineFeatureId}`
    : origin?.kind === 'extrude-curve-side' ? ` / ${origin.profile.sketchId} / ${origin.profile.curveFeatureId}` : '';
  return `${meaning}${source} / ${reference.bodyFeatureId} / ${kind} ${reference.index} / (${position}) mm${size.length === 0 ? '' : ` / ${size}`}`;
}
