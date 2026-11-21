import { drawingViewBasis, ISOMETRIC_DIRECTION, type Point2, type RenderPath } from '@pointercad/drawing';
import { dot, subtract, type BeamAnalysisDocument, type BeamAnalysisResult, type Vector3 } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import type { ReportFigure } from './beamReportLayout.js';

interface Segment { readonly from: Point2; readonly to: Point2; readonly id: string; readonly displaced: boolean }

function draw(segments: readonly Segment[], left: number, bottom: number, width: number, height: number): RenderPath[] {
  const points = segments.flatMap(edge => [edge.from, edge.to]);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
  const fit = Math.min(spanX > 0 ? width / spanX : Infinity, spanY > 0 ? height / spanY : Infinity);
  const scale = Number.isFinite(fit) ? fit : 1;
  const paper = ([x, y]: Point2): Point2 => [left + width / 2 + (x - minX - spanX / 2) * scale,
    bottom + height / 2 + (y - minY - spanY / 2) * scale];
  return segments.map(edge => ({
    kind: 'path', ownerId: edge.id, layerId: edge.displaced ? 'deformed' : 'members',
    subpaths: [{ commands: [{ kind: 'M', to: paper(edge.from) }, { kind: 'L', to: paper(edge.to) }] }],
    transform: [1, 0, 0, 1, 0, 0], fill: null, clip: null, fillRule: 'nonzero',
    stroke: { color: edge.displaced ? '#171717' : '#777777', widthMm: edge.displaced ? 0.35 : 0.25,
      dashMm: edge.displaced ? [2, 1] : [] },
  }));
}

/** Both line sets use the same orthographic basis, origin and fit. Nodal rotations do not describe a sampled curve. */
export function beamReportFigure(geometry: Pick<BeamAnalysisDocument, 'nodes' | 'units'>, result: BeamAnalysisResult): ReportFigure {
  const basis = drawingViewBasis({ normal: ISOMETRIC_DIRECTION, xDir: [1, -1, 0] });
  const first = geometry.nodes[0];
  if (basis === null || first === undefined || result.elements.length === 0) throw new Error(t('beam.error.model'));
  const toM = geometry.units === 'N-mm' ? 0.001 : 1;
  const positions = new Map(geometry.nodes.map(node => [node.id, subtract(node.position, first.position)]));
  const motion = new Map(result.nodes.map(node => [node.nodeId, node.displacementM]));
  const peak = Math.max(...result.nodes.map(node => Math.hypot(...node.displacementM)));
  const span = Math.max(...result.elements.map(element => element.frame.lengthM));
  const exponent = peak > 0 ? Math.floor(Math.log10(span) - Math.log10(peak) - 1) : 0;
  const factor = 10 ** Math.min(308, Math.max(0, exponent));
  const point = (nodeId: string, displaced: boolean): Point2 => {
    const base = positions.get(nodeId), delta = motion.get(nodeId);
    if (base === undefined || delta === undefined) throw new Error(t('beam.error.model'));
    const multiplier = displaced ? factor : 0;
    const v: Vector3 = [base[0] * toM + delta[0] * multiplier, base[1] * toM + delta[1] * multiplier,
      base[2] * toM + delta[2] * multiplier];
    return [dot(v, basis.x), dot(v, basis.y)];
  };
  const segments = [false, true].flatMap(displaced => result.elements.map(element => ({
    id: element.memberId, displaced, from: point(element.nodeIds[0], displaced), to: point(element.nodeIds[1], displaced),
  })));
  return { caption: t('beam.report.figure').replace('{factor}', String(factor)),
    paths: (left, bottom, width, height) => draw(segments, left, bottom, width, height) };
}
