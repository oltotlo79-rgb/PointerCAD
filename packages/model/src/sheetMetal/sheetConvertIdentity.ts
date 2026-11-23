/**
 * 立体から変換した板金(M-08)の板・縁の鍵。面・辺に元の立体の起源があればその文字で、無ければ正準の順の番号で作る。
 * 正準の順は、板・曲げ・辺の配列の並びと面・辺の通し番号によらない(同じ形からは必ず同じ鍵): 基準の板から曲げを
 * たどり、同じ親の子は親の側の接線の中点の辞書順、輪郭は辺の中点の辞書順が最も小さい辺から輪郭の向きに数える。
 */
import type { SheetMetalRecognition, SheetMetalRecognizedBend, SheetMetalRecognizedPanel,
  SheetMetalRecognizedRim } from '@pointercad/kernel';
import { addVec3, crossVec3, scaleVec3, type Vec3 } from '../sketch/vec3.js';

export type RecognizedSheet = Extract<SheetMetalRecognition, { readonly ok: true }>;

/** 元の立体の面・辺の通し番号から起源の文字を引く(起源が無い・一意でない時は null)。 */
export interface SheetConvertOrigins {
  readonly face: (index: number) => string | null;
  readonly edge: (index: number) => string | null;
}

/** 板 1 枚の鍵。`outer`・`holes` の辺の鍵は、`panel.outer`・`panel.holes` の辺と同じ並び。 */
export interface SheetConvertPanelKeys {
  readonly panel: SheetMetalRecognizedPanel;
  readonly key: string;
  readonly outer: readonly string[];
  readonly holes: readonly (readonly string[])[];
}

function comparePoints(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function segmentMidpoint(from: Vec3, to: Vec3): Vec3 {
  return scaleVec3(addVec3(from, to), 0.5);
}
function rimMidpoint({ curve }: SheetMetalRecognizedRim): Vec3 {
  if (curve.kind === 'segment') return segmentMidpoint(curve.from, curve.to);
  const angle = (curve.startAngle + curve.endAngle) / 2, yAxis = crossVec3(curve.normal, curve.xAxis);
  return addVec3(curve.center, addVec3(scaleVec3(curve.xAxis, curve.radius * Math.cos(angle)), scaleVec3(yAxis, curve.radius * Math.sin(angle))));
}

/** 正準の位置 i の起源から鍵を作る。起源が重なる時だけ位置を添えて分ける。 */
function keysFromOrigins(origins: readonly (string | null)[]): string[] {
  const counts = new Map<string, number>();
  for (const origin of origins) if (origin !== null) counts.set(origin, (counts.get(origin) ?? 0) + 1);
  return origins.map((origin, index) => origin === null ? `n:${index}`
    : (counts.get(origin) ?? 0) > 1 ? `o:${origin}#${index}` : `o:${origin}`);
}

/** 輪郭の辺を、中点の辞書順が最も小さい辺から輪郭の向きに並べ替えた時の、元の添え字の並び。 */
function canonicalLoop(loop: readonly SheetMetalRecognizedRim[]): number[] {
  let start = 0;
  loop.forEach((rim, index) => { if (comparePoints(rimMidpoint(rim), rimMidpoint(loop[start])) < 0) start = index; });
  return loop.map((_rim, offset) => (start + offset) % loop.length);
}

function rimKeys(panel: SheetMetalRecognizedPanel, origins: SheetConvertOrigins): Pick<SheetConvertPanelKeys, 'outer' | 'holes'> {
  const lowest = (loop: readonly SheetMetalRecognizedRim[]): Vec3 => rimMidpoint(loop[canonicalLoop(loop)[0]]);
  const holes = panel.holes.map((loop, index) => ({ loop, index })).sort((a, b) => comparePoints(lowest(a.loop), lowest(b.loop)));
  const loops = [{ loop: panel.outer, index: -1 }, ...holes];
  // 正準の位置ごとに、どの輪郭の何番目の辺かを並べる。
  const slots = loops.flatMap(({ loop, index }) => canonicalLoop(loop).map(position => ({ loop: index, position, rim: loop[position] })));
  const keys = keysFromOrigins(slots.map(slot => origins.edge(slot.rim.edgeIndex)));
  const keyOf = (loop: number, position: number): string => keys[slots.findIndex(slot => slot.loop === loop && slot.position === position)];
  return { outer: panel.outer.map((_rim, position) => keyOf(-1, position)),
    holes: panel.holes.map((loop, index) => loop.map((_rim, position) => keyOf(index, position))) };
}

/** 曲げの木を基準の板からたどった正準の順。根が 1 つでない・輪がある・つながらない時は null。 */
function canonicalPanels(sheet: RecognizedSheet): SheetMetalRecognizedPanel[] | null {
  const byFace = new Map(sheet.panels.map(panel => [panel.faceIndex, panel]));
  const children = new Map<number, SheetMetalRecognizedBend[]>(), incoming = new Set<number>();
  if (byFace.size !== sheet.panels.length) return null;
  for (const bend of sheet.bends) {
    if (!byFace.has(bend.fromFaceIndex) || !byFace.has(bend.toFaceIndex) || incoming.has(bend.toFaceIndex)) return null;
    incoming.add(bend.toFaceIndex);
    children.set(bend.fromFaceIndex, [...children.get(bend.fromFaceIndex) ?? [], bend]);
  }
  const roots = sheet.panels.filter(panel => !incoming.has(panel.faceIndex));
  if (roots.length !== 1) return null;
  const order = [roots[0]];
  for (let i = 0; i < order.length; i++) {
    const kids = [...children.get(order[i].faceIndex) ?? []].sort((a, b) => comparePoints(
      segmentMidpoint(a.fromTangent.from, a.fromTangent.to), segmentMidpoint(b.fromTangent.from, b.fromTangent.to)));
    for (const kid of kids) {
      const panel = byFace.get(kid.toFaceIndex);
      if (panel === undefined || order.includes(panel)) return null;
      order.push(panel);
    }
  }
  return order.length === sheet.panels.length ? order : null;
}

/** 板を正準の順(先頭が基準の板)に並べ、板と縁の鍵を付ける。曲げの木が作れない時は null。 */
export function sheetConvertKeys(sheet: RecognizedSheet, origins: SheetConvertOrigins): readonly SheetConvertPanelKeys[] | null {
  const panels = canonicalPanels(sheet);
  if (panels === null) return null;
  const keys = keysFromOrigins(panels.map(panel => origins.face(panel.faceIndex)));
  return panels.map((panel, index) => ({ panel, key: keys[index], ...rimKeys(panel, origins) }));
}
