/** mm実寸の製作用DXF実体。文字列化はioで行い、曲線を再標本化しない。 */
import type { DrawingDxfEntity } from '../exchange/drawingDxfTypes.js';
import type { SheetFlatBendLine } from './flatBendLines.js';
import type { SheetFlatOutline } from './flatOutline.js';
import type { SheetGeometryResult } from './panelGeometry.js';

export function sheetFlatDxfEntities(outline: SheetFlatOutline, bends: readonly SheetFlatBendLine[]): SheetGeometryResult<readonly DrawingDxfEntity[]> {
  const entities: DrawingDxfEntity[] = [];
  for (const loop of outline.loops) for (const curve of loop.curves) {
    const layer = loop.kind === 'outer' ? 'CUT_OUTER' : 'CUT_HOLES';
    if (curve.kind === 'segment') entities.push({ kind: 'line', layer, color: null,
      start: { x: curve.from[0], y: curve.from[1] }, end: { x: curve.to[0], y: curve.to[1] } });
    else if (curve.kind === 'arc') {
      const sign = curve.normal[2] > 0 ? 1 : -1;
      const base = Math.atan2(curve.xAxis[1], curve.xAxis[0]);
      const rawStart = (base + sign * curve.startAngle) * 180 / Math.PI;
      const startAngle = ((rawStart % 360) + 360) % 360;
      entities.push({ kind: 'arc', layer, color: null, center: { x: curve.center[0], y: curve.center[1] },
        radius: curve.radius, startAngle, endAngle: startAngle + sign * (curve.endAngle - curve.startAngle) * 180 / Math.PI });
    } else return { ok: false, message: '精密断面以外の曲線は板金DXFへ書き出せません。' };
  }
  for (const bend of bends) entities.push({ kind: 'line', layer: bend.direction === 'up' ? 'BEND_UP' : 'BEND_DOWN', color: null,
    start: { x: bend.from[0], y: bend.from[1] }, end: { x: bend.to[0], y: bend.to[1] } });
  return { ok: true, value: entities };
}
