/**
 * 規格部品の選ぶ窓の寸法の図(K-07c)の線図。私たちの形の台本が作った部品文書の、最初の押し出しの面のスケッチ(作図面の線と弧)を、
 * 窓の枠に収めた SVG の path と、外形の幅・高さの寸法線にする(資料の図は使わない。統括の決定 2026-11-18 の D2)。
 * 描くのは「最初の立体が押し出しで、その面のスケッチが全部 xy の作図面」の時だけ。基本の形(円柱など)で作る部品や、
 * 作図面の線が形の一部(六角穴付きボルトの穴の六角など)にすぎない部品は描かない(null。窓は表だけを出す)。
 * 縮尺は枠に合わせる(実寸ではない)。座標は px で作り、y は下向きへ直す。
 */
import {
  arcPointAt, curveEnd, curveStart, DEFAULT_WORK_PLANE_ID, distanceVec3, isFullCircle, resolveSketch,
  type PartDocument, type ResolvedArc, type ResolvedCurve, type Vec3,
} from '@pointercad/model';

/** 図の枠(px)。外形はこの中に収まる一番大きい縮尺(縦横同じ)で描く。 */
const FIGURE_BOX = { width: 220, height: 140 } as const;
/** 枠の外の余白(px)。下は幅の寸法線と数、右は高さの寸法線と数の分。 */
const MARGIN = { left: 8, top: 8, right: 64, bottom: 30 } as const;
/** 寸法線を外形から離す量と、端の短い線の長さ(px)。 */
const DIMENSION_GAP = 12;
const TICK = 4;
/** 覚えておく線図の数(窓で行を選び直す間だけ使う)。 */
const CACHE_SIZE = 8;
const QUARTER_TURN = Math.PI / 2;

type Loop = readonly ResolvedCurve[];

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** 寸法線 1 本: 線の path(延長の線と端を含む)、数の位置、数(mm)。 */
interface DimensionLine {
  readonly path: string;
  readonly textX: number;
  readonly textY: number;
  readonly valueMm: number;
}

interface PartOutline {
  /** SVG の幅と高さ(px)。 */
  readonly viewWidth: number;
  readonly viewHeight: number;
  /** 輪 1 つにつき 1 本の path の d(外周と穴)。 */
  readonly paths: readonly string[];
  readonly widthLine: DimensionLine;
  readonly heightLine: DimensionLine;
}

/** 最初の押し出しの面のスケッチを解いた輪(外周と穴)。描けない時は null。 */
function profileLoops(document: PartDocument): readonly Loop[] | null {
  const first = document.solids[0];
  if (first?.kind !== 'extrude') return null;
  const sketch = document.sketches.find((candidate) => candidate.id === first.profile.sketchId);
  if (sketch === undefined || sketch.features.some((feature) => feature.planeId !== DEFAULT_WORK_PLANE_ID)) return null;
  const resolved = resolveSketch(sketch);
  // 途中まで描いて形を取り違えさせない(誤りが 1 つでもあれば描かない)。
  if (resolved.errors.length > 0) return null;
  const loops = resolved.faces.flatMap((face) => [face.curves, ...(face.holes ?? [])]).filter((loop) => loop.length > 0);
  const drawable = loops.every((loop) => loop.every((curve) => curve.kind === 'segment' || curve.kind === 'arc'));
  return loops.length > 0 && drawable ? loops : null;
}

/** 円弧の端と、円弧が通る 0・90・180・270 度の点(外形の範囲に使う。標本は取らない)。 */
function arcExtremes(arc: ResolvedArc): Vec3[] {
  const low = Math.min(arc.startAngle, arc.endAngle);
  const high = Math.max(arc.startAngle, arc.endAngle);
  const points = [arcPointAt(arc, arc.startAngle), arcPointAt(arc, arc.endAngle)];
  for (let quarter = Math.ceil(low / QUARTER_TURN); quarter * QUARTER_TURN <= high; quarter += 1) {
    points.push(arcPointAt(arc, quarter * QUARTER_TURN));
  }
  return points;
}

function loopBounds(loops: readonly Loop[]): Bounds {
  const points = loops.flat().flatMap((curve) => curve.kind === 'arc' ? arcExtremes(curve) : [curveStart(curve), curveEnd(curve)]);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 画面の数(px)を短く書く(0.01 px まで)。 */
function px(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 輪の最初の曲線の、次の曲線へつながらない側の端(輪を描き始める点)。 */
function loopStart(loop: Loop): Vec3 | undefined {
  const [first, next] = loop;
  if (first === undefined) return undefined;
  if (next === undefined) return curveStart(first);
  const touch = (point: Vec3): number => Math.min(distanceVec3(point, curveStart(next)), distanceVec3(point, curveEnd(next)));
  return touch(curveEnd(first)) <= touch(curveStart(first)) ? curveStart(first) : curveEnd(first);
}

/** 円弧の 1 区間の SVG の A の命令。y を下向きへ直すので、反時計回り(掃く量が正)は SVG の負の向き(sweep 0)になる。 */
function arcCommand(arc: ResolvedArc, from: number, to: number, place: (point: Vec3) => string, radius: string): string {
  const sweep = to - from;
  const large = sweep > Math.PI || sweep < -Math.PI ? '1' : '0';
  return `A ${radius} ${radius} 0 ${large} ${sweep > 0 ? '0' : '1'} ${place(arcPointAt(arc, to))}`;
}

/** 曲線 1 つを、今の点から遠い側の端へ描く命令(輪の中で向きが逆の曲線も描ける)。全周の円は半円 2 つに分ける。 */
function curveCommands(curve: ResolvedCurve, current: Vec3, place: (point: Vec3) => string, scale: number):
{ readonly commands: readonly string[]; readonly end: Vec3 } {
  const forward = distanceVec3(current, curveStart(curve)) <= distanceVec3(current, curveEnd(curve));
  const end = forward ? curveEnd(curve) : curveStart(curve);
  if (curve.kind !== 'arc') return { commands: [`L ${place(end)}`], end };
  const radius = px(curve.radius * scale);
  const [from, to] = forward ? [curve.startAngle, curve.endAngle] : [curve.endAngle, curve.startAngle];
  if (!isFullCircle(curve)) return { commands: [arcCommand(curve, from, to, place, radius)], end };
  const middle = from + (to - from) / 2;
  return { commands: [arcCommand(curve, from, middle, place, radius), arcCommand(curve, middle, to, place, radius)], end };
}

function loopPath(loop: Loop, place: (point: Vec3) => string, scale: number): string {
  let current = loopStart(loop);
  if (current === undefined) return '';
  const parts = [`M ${place(current)}`];
  for (const curve of loop) {
    const drawn = curveCommands(curve, current, place, scale);
    parts.push(...drawn.commands);
    current = drawn.end;
  }
  return [...parts, 'Z'].join(' ');
}

/** 外形の幅(下)と高さ(右)の寸法線。外形の箱は px。 */
function dimensionLines(box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number },
  widthMm: number, heightMm: number): { readonly widthLine: DimensionLine; readonly heightLine: DimensionLine } {
  const { x0, y0, x1, y1 } = box;
  const y = y1 + DIMENSION_GAP;
  const x = x1 + DIMENSION_GAP;
  return {
    widthLine: { valueMm: widthMm, textX: (x0 + x1) / 2, textY: y + 14, path: [
      `M ${px(x0)} ${px(y1 + TICK)} L ${px(x0)} ${px(y + TICK)}`, `M ${px(x1)} ${px(y1 + TICK)} L ${px(x1)} ${px(y + TICK)}`,
      `M ${px(x0)} ${px(y)} L ${px(x1)} ${px(y)}`].join(' ') },
    heightLine: { valueMm: heightMm, textX: x + 6, textY: (y0 + y1) / 2 + 4, path: [
      `M ${px(x1 + TICK)} ${px(y0)} L ${px(x + TICK)} ${px(y0)}`, `M ${px(x1 + TICK)} ${px(y1)} L ${px(x + TICK)} ${px(y1)}`,
      `M ${px(x)} ${px(y0)} L ${px(x)} ${px(y1)}`].join(' ') },
  };
}

/** 部品文書の線図。描けない時は null。 */
function partOutline(document: PartDocument): PartOutline | null {
  const loops = profileLoops(document);
  if (loops === null) return null;
  const bounds = loopBounds(loops);
  const widthMm = bounds.maxX - bounds.minX;
  const heightMm = bounds.maxY - bounds.minY;
  const scale = Math.min(widthMm > 0 ? FIGURE_BOX.width / widthMm : Infinity, heightMm > 0 ? FIGURE_BOX.height / heightMm : Infinity);
  if (!Number.isFinite(scale)) return null;
  const place = (point: Vec3): string =>
    `${px(MARGIN.left + (point[0] - bounds.minX) * scale)} ${px(MARGIN.top + (bounds.maxY - point[1]) * scale)}`;
  const box = { x0: MARGIN.left, y0: MARGIN.top, x1: MARGIN.left + widthMm * scale, y1: MARGIN.top + heightMm * scale };
  return {
    viewWidth: Math.ceil(box.x1 + MARGIN.right), viewHeight: Math.ceil(box.y1 + MARGIN.bottom),
    paths: loops.map((loop) => loopPath(loop, place, scale)), ...dimensionLines(box, widthMm, heightMm),
  };
}

const outlines = new Map<string, PartOutline | null>();

/**
 * 鍵ごとに 1 回だけ部品文書を作って線図にする(窓は描き直すたびに呼ぶ)。最後の数件だけを覚える。
 * 鍵は、同じ鍵なら同じ部品文書になる物(族・行・指定の値、または分類・呼び・寸法系・ねじの系)にする。
 */
export function cachedPartOutline(key: string, build: () => PartDocument | null): PartOutline | null {
  if (outlines.has(key)) return outlines.get(key) ?? null;
  const document = build();
  const outline = document === null ? null : partOutline(document);
  outlines.set(key, outline);
  const oldest = outlines.size > CACHE_SIZE ? outlines.keys().next().value : undefined;
  if (oldest !== undefined) outlines.delete(oldest);
  return outline;
}
