import type { WeldDisplaySide } from '@pointercad/drawing';
import type { ResolvedWeldSymbol } from './welding.js';

/** 保存した表示値を流用せず、現在の式から得たmm値をZ3021表5の順序で配置する。 */
export function weldDisplaySides(resolved: ResolvedWeldSymbol): readonly WeldDisplaySide[] | null {
  if (resolved.issues.length > 0 || resolved.feature === null) return null;
  const number = (value: number): string => Number(value.toPrecision(10)).toString();
  return resolved.sides.map((side) => {
    const { spec, sizeMm, lengthMm, pitchMm, count, rootGapMm, grooveDepthMm, grooveAngleDeg } = side;
    let size = sizeMm === null ? '' : number(sizeMm);
    if (spec.size?.kind === 'throat') size = `a${size}`;
    if (spec.size?.kind === 'penetration') size = `${grooveDepthMm === null ? '' : number(grooveDepthMm)}(${size})`;
    else if (grooveDepthMm !== null) size = number(grooveDepthMm);
    const length = lengthMm === null ? '' : number(lengthMm);
    return { kind: spec.kind, side: spec.side, size,
      length: count === null || pitchMm === null ? length : `${length}(${number(count)})-${number(pitchMm)}`,
      rootGap: rootGapMm === null ? '' : number(rootGapMm), grooveAngle: grooveAngleDeg === null ? '' : `${number(grooveAngleDeg)}°`,
      contour: spec.contour, finish: spec.finish === 'none' ? '' : ({ grind: 'G', machine: 'M', chip: 'C', polish: 'P' } as const)[spec.finish] };
  });
}
