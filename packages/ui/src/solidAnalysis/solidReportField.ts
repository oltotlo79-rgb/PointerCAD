import { drawingViewBasis, type DrawingViewBasis, type PathCommand, type Point2, type RenderPath } from '@pointercad/drawing';
import { crossVec3, dotVec3, scaleVec3, subVec3, type Vec3 } from '@pointercad/model/vec3';
import { cameraPosition, HOME_ORBIT } from '../viewport/cameraMath.js';
import { SOLID_FIELD_HIGH_COLOR, SOLID_FIELD_LOW_COLOR } from './solidFieldPalette.js';
import { buildSolidFieldMesh, solidFieldFraction, type SolidFieldLegend, type SolidFieldMesh } from './solidFieldView.js';

type SolidResult = Parameters<typeof buildSolidFieldMesh>[0];

export interface SolidReportField {
  readonly legend: SolidFieldLegend;
  readonly triangles: number;
  draw(left: number, bottom: number, width: number, height: number): {
    readonly paths: readonly RenderPath[];
    readonly drawn: number;
    readonly dropped: number;
  };
}

interface FigureBox { readonly left: number; readonly bottom: number; readonly width: number; readonly height: number }
interface ProjectedTriangle {
  readonly index: number;
  readonly depth: number;
  readonly points: readonly [Point2, Point2, Point2];
  readonly fill: string;
}

const BAND_COUNT = 10;
const BAND_WIDTH_MM = 5;
const BAND_GAP_MM = 2;
const BAND_FRAME_WIDTH_MM = 0.15;
const MINIMUM_PAPER_TRIANGLE_AREA_MM2 = 0.005;

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

// Match the viewport's interpolation in linear RGB, then encode the report fill in sRGB.
function bandColor(fraction: number): string {
  const channels = [16, 8, 0].map(shift => {
    const low = srgbToLinear(((SOLID_FIELD_LOW_COLOR >> shift) & 0xff) / 255);
    const high = srgbToLinear(((SOLID_FIELD_HIGH_COLOR >> shift) & 0xff) / 255);
    const channel = linearToSrgb(low + (high - low) * fraction);
    return Math.round(channel * 255).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

const BAND_COLORS = Array.from({ length: BAND_COUNT }, (_, index) => bandColor((index + 0.5) / BAND_COUNT));

function projectTriangles(mesh: SolidFieldMesh, basis: DrawingViewBasis): ProjectedTriangle[] {
  const { positions, triangleElements, elementValues, legend } = mesh;
  let magnitude = 0;
  for (const coordinate of positions) magnitude = Math.max(magnitude, Math.abs(coordinate));
  // A common power of two preserves the fit and keeps the cross products in range.
  const unit = 2 ** Math.min(1023, Math.floor(Math.log2(magnitude))) || 1;
  const pointAt = (offset: number): Vec3 => [positions[offset] / unit, positions[offset + 1] / unit, positions[offset + 2] / unit];
  const project = (point: Vec3): Point2 => [dotVec3(point, basis.x), dotVec3(point, basis.y)];
  const triangles: ProjectedTriangle[] = [];
  for (const [index, element] of triangleElements.entries()) {
    const offset = index * 9;
    const a = pointAt(offset), b = pointAt(offset + 3), c = pointAt(offset + 6);
    const normal = crossVec3(subVec3(b, a), subVec3(c, a));
    // The basis normal is the look direction (packages/drawing/src/layout/thirdAngle.ts:10), so the eye is on its negative
    // side: a face is kept only when its outward normal points at the eye, and a larger depth is nearer to the eye.
    if (dotVec3(normal, basis.normal) >= 0) continue;
    const depth = -(dotVec3(a, basis.normal) + dotVec3(b, basis.normal) + dotVec3(c, basis.normal)) / 3;
    const fraction = solidFieldFraction(elementValues[element], legend);
    const band = Math.max(0, Math.min(BAND_COUNT - 1, Math.floor(fraction * BAND_COUNT)));
    triangles.push({ index, depth, points: [project(a), project(b), project(c)], fill: BAND_COLORS[band] });
  }
  return triangles.sort((a, b) => a.depth - b.depth || a.index - b.index);
}

function fitToPaper(triangles: readonly ProjectedTriangle[], width: number, height: number): (point: Point2) => Point2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { points } of triangles) {
    for (const [x, y] of points) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  const fit = Math.min(width / spanX, height / spanY);
  const scale = Number.isFinite(fit) ? fit : 1;
  const insetX = (width - spanX * scale) / 2, insetY = (height - spanY * scale) / 2;
  return ([x, y]) => [Math.min(width, Math.max(0, insetX + (x - minX) * scale)),
    Math.min(height, Math.max(0, insetY + (y - minY) * scale))];
}

function polygonPath(points: readonly Point2[], ownerId: string, layerId: string, fill: string | null,
  stroke: RenderPath['stroke']): RenderPath {
  const commands = points.map<PathCommand>((to, index) => ({ kind: index === 0 ? 'M' : 'L', to }));
  commands.push({ kind: 'Z' });
  return { kind: 'path', ownerId, layerId, subpaths: [{ commands }], transform: [1, 0, 0, 1, 0, 0],
    fill, stroke, clip: null, fillRule: 'nonzero' };
}

function rectangle(left: number, bottom: number, right: number, top: number): readonly Point2[] {
  return [[left, bottom], [right, bottom], [right, top], [left, top]];
}

function drawBand(box: FigureBox, bandWidth: number): RenderPath[] {
  const left = box.left + (box.width - bandWidth), right = box.left + box.width, top = box.bottom + box.height;
  const atStep = (step: number): number => box.bottom + box.height * (step / BAND_COUNT);
  const paths = BAND_COLORS.map((fill, index) => polygonPath(rectangle(left, atStep(index), right, atStep(index + 1)),
    `band-${index}`, 'legend', fill, null));
  const widthMm = Math.min(BAND_FRAME_WIDTH_MM, bandWidth / 2, box.height / 2);
  const inset = widthMm / 2;
  paths.push(polygonPath(rectangle(left + inset, box.bottom + inset, right - inset, top - inset),
    'band-frame', 'legend', null, { color: '#171717', widthMm, dashMm: [] }));
  return paths;
}

function drawField(triangles: readonly ProjectedTriangle[], box: FigureBox): ReturnType<SolidReportField['draw']> {
  const { left, bottom, width, height } = box;
  if (!(width > 0 && height > 0) || ![left, bottom, left + width, bottom + height].every(Number.isFinite)) {
    return { paths: [], drawn: 0, dropped: 0 };
  }
  const bandWidth = Math.min(BAND_WIDTH_MM, width / 4);
  const bandGap = Math.min(BAND_GAP_MM, width / 12);
  const band = drawBand(box, bandWidth);
  if (triangles.length === 0) return { paths: band, drawn: 0, dropped: 0 };

  const fit = fitToPaper(triangles, width - bandWidth - bandGap, height);
  const paths: RenderPath[] = [];
  for (const triangle of triangles) {
    const [a, b, c] = triangle.points.map(fit);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    if (area < MINIMUM_PAPER_TRIANGLE_AREA_MM2) continue;
    const points = [a, b, c].map(([x, y]): Point2 => [left + x, bottom + y]);
    paths.push(polygonPath(points, `tri-${triangle.index}`, 'field', triangle.fill, null));
  }
  const drawn = paths.length;
  return { paths: [...paths, ...band], drawn, dropped: triangles.length - drawn };
}

/**
 * The paper basis of the viewport's home view (front, top and right visible; 統括の決定 2026-11-22 11:36). The direction is
 * read from HOME_ORBIT, so the report never keeps its own copy of the view: the look direction runs from the eye to the
 * target, and paper +x is horizontal, to the eye's right.
 */
function homeViewBasis(): DrawingViewBasis | null {
  const eye = cameraPosition({ ...HOME_ORBIT, distance: 1, target: [0, 0, 0] });
  return drawingViewBasis({ normal: scaleVec3(eye, -1), xDir: crossVec3([0, 0, 1], eye) });
}

/** An undeformed snapshot of the boundary from the home view, coloured by element von Mises stress in MPa. */
export function solidReportField(outcome: SolidResult): SolidReportField | null {
  const mesh = buildSolidFieldMesh(outcome, 'vonMises', 0);
  const basis = homeViewBasis();
  if (mesh === null || basis === null) return null;
  const projected = projectTriangles(mesh, basis);
  return { legend: mesh.legend, triangles: mesh.triangleElements.length,
    draw: (left, bottom, width, height) => drawField(projected, { left, bottom, width, height }) };
}
