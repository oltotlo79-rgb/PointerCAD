/**
 * 材質別の鋼材の断面の形の振り分け。r1 の断面（等辺山形・溝形・H 形）は steelSectionProfiles.ts の
 * steelSectionProfile をそのまま使い、r2 で足した断面（角形鋼管・不等辺山形鋼・I 形鋼、2026-11-15 の軽量形鋼 6 つ・
 * CT 形鋼）はここで作る。
 *
 * steelSectionProfiles.ts は既存の検査が本文を固定している（凍結）ので、角を丸める計算はここに別に持つ
 * （同じ考え方: 多角形の角を、隣り合う辺に接する円弧で置き換える）。寸法は資料の表の値だけを使い、
 * 資料に無い丸み・勾配は足さない。
 */
import { crossVec2 as cross } from '../../../sketch/vec2.js';
import { G3192_CT_ROWS } from '../steelRows/g3192CtRows.js';
import { G3192_I_BEAM_ROWS, G3192_UNEQUAL_ANGLE_ROWS } from '../steelRows/g3192ExtraRows.js';
import {
  G3350_HAT_ROWS, G3350_LIGHT_ANGLE_ROWS, G3350_LIGHT_CHANNEL_ROWS, G3350_LIGHT_Z_ROWS, G3350_LIP_CHANNEL_ROWS,
  G3350_LIP_Z_ROWS,
} from '../steelRows/g3350Rows.js';
import { G3466_RECT_TUBE_ROWS } from '../steelRows/g3466Rows.js';
import {
  steelSectionProfile, type SteelProfilePoint, type SteelProfileSegment, type SteelSectionProfile,
} from '../steelSectionProfiles.js';

/** 中空の断面の内側の輪(holes)を持てる断面。areaMm2 は外の輪から内の輪を引いた正味の面積。 */
export interface SteelCatalogProfile extends SteelSectionProfile {
  readonly holes: readonly (readonly SteelProfileSegment[])[];
}

const distance = (a: SteelProfilePoint, b: SteelProfilePoint): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** 多角形の頂点ごとの半径で角を丸めた閉じた輪。半径 0 の角はそのまま。円弧の向きで凹凸を保つ。 */
function roundedLoop(vertices: readonly SteelProfilePoint[], radii: readonly number[]): readonly SteelProfileSegment[] {
  const corners = vertices.map((point, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    const next = vertices[(index + 1) % vertices.length];
    const incoming = distance(previous, point), outgoing = distance(point, next);
    const u: SteelProfilePoint = [(point[0] - previous[0]) / incoming, (point[1] - previous[1]) / incoming];
    const v: SteelProfilePoint = [(next[0] - point[0]) / outgoing, (next[1] - point[1]) / outgoing];
    const turn = Math.atan2(cross(u, v), u[0] * v[0] + u[1] * v[1]);
    const radius = radii[index];
    const tangent = radius * Math.tan(Math.abs(turn) / 2);
    if (!Number.isFinite(tangent) || radius < 0 || incoming <= 0 || outgoing <= 0) {
      throw new Error('Invalid sourced steel profile corner.');
    }
    const from: SteelProfilePoint = [point[0] - u[0] * tangent, point[1] - u[1] * tangent];
    const to: SteelProfilePoint = [point[0] + v[0] * tangent, point[1] + v[1] * tangent];
    const center: SteelProfilePoint = [from[0] - u[1] * Math.sign(turn) * radius, from[1] + u[0] * Math.sign(turn) * radius];
    const startAngle = Math.atan2(from[1] - center[1], from[0] - center[0]);
    return { from, to, center, radius, tangent, incoming, startAngle, endAngle: startAngle + turn };
  });
  const segments: SteelProfileSegment[] = [];
  corners.forEach((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length];
    if (previous.tangent + corner.tangent > corner.incoming + 1e-10) throw new Error('Overlapping sourced steel profile radii.');
    if (distance(previous.to, corner.from) > 1e-10) segments.push({ kind: 'line', from: previous.to, to: corner.from });
    if (corner.radius > 0) {
      segments.push({ kind: 'arc', from: corner.from, to: corner.to, center: corner.center, radius: corner.radius,
        startAngle: corner.startAngle, endAngle: corner.endAngle });
    }
  });
  return segments;
}

/** 輪の符号つき面積(反時計回りが正)。円弧は中心からの扇形と三角形の和で数える。 */
function loopArea(segments: readonly SteelProfileSegment[]): number {
  return segments.reduce((area, segment) => area + (segment.kind === 'line'
    ? cross(segment.from, segment.to) / 2
    : (segment.center[0] * (segment.to[1] - segment.from[1]) - segment.center[1] * (segment.to[0] - segment.from[0])
      + segment.radius ** 2 * (segment.endAngle - segment.startAngle)) / 2), 0);
}

function catalogProfile(base: Omit<SteelCatalogProfile, 'areaMm2'>): SteelCatalogProfile {
  const areaMm2 = loopArea(base.segments) - base.holes.reduce((sum, hole) => sum + loopArea(hole), 0);
  return { ...base, areaMm2 };
}

function rowsBySize<Row>(rows: readonly Row[], size: (row: Row) => string): ReadonlyMap<string, Row> {
  return new Map(rows.map((row) => [size(row), row]));
}

const rectTubes = rowsBySize(G3466_RECT_TUBE_ROWS, ([a, b, t]) => `□ ${a}×${b}×${t}`);
const unequalAngles = rowsBySize(G3192_UNEQUAL_ANGLE_ROWS, ([a, b, t]) => `L ${a}×${b}×${t}`);
const iBeams = rowsBySize(G3192_I_BEAM_ROWS, ([h, b, t1, t2]) => `I ${h}×${b}×${t1}×${t2}`);

/**
 * JIS G 3466 表5・表6 の注a: 角部の外側の半径 2t・内側の半径 t。外の輪は B×A、内の輪は (B−2t)×(A−2t) で、
 * 角の円弧は同じ中心を持つ（注a の断面積の式 s = [2t(A−4t)+2t(B−4t)+3πt²]/100 と同じ形）。
 * 注a の IXA = 2t(A−4t)³/12 のとおり辺 A は X 軸に直角（y の向き）なので、高さを A、幅を B に置く。
 */
function rectTubeProfile(size: string): SteelCatalogProfile | undefined {
  const row = rectTubes.get(size);
  if (row === undefined) return undefined;
  const [a, b, t] = row.slice(0, 3).map(Number);
  const box = (x0: number, y0: number, x1: number, y1: number): readonly SteelProfilePoint[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return catalogProfile({ width: b, height: a, rootRadius: t, tipRadius: 2 * t, taperDegrees: 0,
    segments: roundedLoop(box(0, 0, b, a), [2 * t, 2 * t, 2 * t, 2 * t]),
    holes: [roundedLoop(box(t, t, b - t, a - t), [t, t, t, t])] });
}

/**
 * JIS G 3192 表9: 等辺山形鋼と同じ作り（r1 は内の隅、r2 は 2 つの脚の先の内側の角）。表9 の図のとおり、
 * 長い脚 A を縦（y）、脚 B を横（x）に置く。
 */
function unequalAngleProfile(size: string): SteelCatalogProfile | undefined {
  const row = unequalAngles.get(size);
  if (row === undefined) return undefined;
  const [a, b, t, root, tip] = row.slice(0, 5).map(Number);
  return catalogProfile({ width: b, height: a, rootRadius: root, tipRadius: tip, taperDegrees: 0,
    segments: roundedLoop([[0, 0], [b, 0], [b, t], [t, t], [t, a], [0, a]], [0, 0, tip, root, tip, 0]), holes: [] });
}

/**
 * JIS G 3192 表11 の図: ウェブとフランジの内面の角度は 98°（フランジの内面の勾配 8°）、t2 はフランジの出
 * (B−t1)/2 の中央で測る。内面の角(r1)とフランジの先の内側の角(r2)を丸め、外の角は丸めない。
 */
function iBeamProfile(size: string): SteelCatalogProfile | undefined {
  const row = iBeams.get(size);
  if (row === undefined) return undefined;
  const [h, b, tw, tf, root, tip] = row.slice(0, 6).map(Number);
  const offset = Math.tan(8 * Math.PI / 180) * (b - tw) / 4;
  const left = (b - tw) / 2, right = (b + tw) / 2;
  return catalogProfile({ width: b, height: h, rootRadius: root, tipRadius: tip, taperDegrees: 8,
    segments: roundedLoop([[0, 0], [b, 0], [b, tf - offset], [right, tf + offset], [right, h - tf - offset],
      [b, h - tf + offset], [b, h], [0, h], [0, h - tf + offset], [left, h - tf - offset], [left, tf + offset], [0, tf - offset]],
    [0, 0, tip, root, root, tip, 0, 0, tip, root, root, tip]), holes: [] });
}

/** 薄肉の曲げの断面の頂点と、その角の半径（外側の曲げは 2t・内側の曲げは t・端の角は 0）。 */
type BentOutline = readonly (readonly [number, number, 'outer' | 'inner' | 'sharp'])[];

/**
 * JIS G 3350 8.1: 角部の曲率半径は厚さ（t）の中心線で 1.5t。外側の面は 2t・内側の面は t の同じ中心の円弧になる
 * （表12 の断面積の式の係数 1.644・3.287・6.574 は、曲げ 1 つごとに寸法の和から (4 − 0.75π)t を引いた値。
 * ハットの 4.575 は、つばの寸法 C をウェブの外の面から測るので 2t 少ない）。
 */
function bentProfile(t: number, width: number, height: number, outline: BentOutline): SteelCatalogProfile {
  const radius = { outer: 2 * t, inner: t, sharp: 0 } as const;
  return catalogProfile({ width, height, rootRadius: t, tipRadius: 2 * t, taperDegrees: 0,
    segments: roundedLoop(outline.map(([x, y]): SteelProfilePoint => [x, y]), outline.map(([, , kind]) => radius[kind])),
    holes: [] });
}

const lightChannels = rowsBySize(G3350_LIGHT_CHANNEL_ROWS, ([, h, a, b, t]) => `[ ${h}×${a}×${b}×${t}`);
const lightZs = rowsBySize(G3350_LIGHT_Z_ROWS, ([, h, a, b, t]) => `Z ${h}×${a}×${b}×${t}`);
const lightAngles = rowsBySize(G3350_LIGHT_ANGLE_ROWS, ([, a, b, t]) => `L ${a}×${b}×${t}`);
const lipChannels = rowsBySize(G3350_LIP_CHANNEL_ROWS, ([, h, a, c, t]) => `C ${h}×${a}×${c}×${t}`);
const lipZs = rowsBySize(G3350_LIP_Z_ROWS, ([, h, a, c, t]) => `Z ${h}×${a}×${c}×${t}`);
const hats = rowsBySize(G3350_HAT_ROWS, ([, h, a, c, t]) => `ハット ${h}×${a}×${c}×${t}`);
const cts = rowsBySize(G3192_CT_ROWS, ([h, b, t1, t2]) => `CT ${h}×${b}×${t1}×${t2}`);

/** 表5 の図: ウェブが左、上のフランジ A・下のフランジ B が右に出る（H は y）。 */
function lightChannelProfile(size: string): SteelCatalogProfile | undefined {
  const row = lightChannels.get(size);
  if (row === undefined) return undefined;
  const [h, a, b, t] = row.slice(1, 5).map(Number);
  return bentProfile(t, Math.max(a, b), h, [[0, 0, 'outer'], [b, 0, 'sharp'], [b, t, 'sharp'], [t, t, 'inner'],
    [t, h - t, 'inner'], [a, h - t, 'sharp'], [a, h, 'sharp'], [0, h, 'outer']]);
}

/** 表6 の図: 上のフランジ A は左へ、下のフランジ B は右へ出る。ウェブの外の面は x = A − t と x = A。 */
function lightZProfile(size: string): SteelCatalogProfile | undefined {
  const row = lightZs.get(size);
  if (row === undefined) return undefined;
  const [h, a, b, t] = row.slice(1, 5).map(Number);
  const web = a - t;
  return bentProfile(t, web + b, h, [[web, 0, 'outer'], [web + b, 0, 'sharp'], [web + b, t, 'sharp'], [a, t, 'inner'],
    [a, h, 'outer'], [0, h, 'sharp'], [0, h - t, 'sharp'], [web, h - t, 'inner']]);
}

/** 表7 の図: 脚 A は縦（y）、脚 B は横（x）。 */
function lightAngleProfile(size: string): SteelCatalogProfile | undefined {
  const row = lightAngles.get(size);
  if (row === undefined) return undefined;
  const [a, b, t] = row.slice(1, 4).map(Number);
  return bentProfile(t, b, a, [[0, 0, 'outer'], [b, 0, 'sharp'], [b, t, 'sharp'], [t, t, 'inner'], [t, a, 'sharp'],
    [0, a, 'sharp']]);
}

/** 表8 の図: ウェブが左、フランジ A が右に出て、その先のリップ C が内へ折れる（C はフランジの外の面から）。 */
function lipChannelProfile(size: string): SteelCatalogProfile | undefined {
  const row = lipChannels.get(size);
  if (row === undefined) return undefined;
  const [h, a, c, t] = row.slice(1, 5).map(Number);
  return bentProfile(t, a, h, [[0, 0, 'outer'], [a, 0, 'outer'], [a, c, 'sharp'], [a - t, c, 'sharp'],
    [a - t, t, 'inner'], [t, t, 'inner'], [t, h - t, 'inner'], [a - t, h - t, 'inner'], [a - t, h - c, 'sharp'],
    [a, h - c, 'sharp'], [a, h, 'outer'], [0, h, 'outer']]);
}

/** 表9 の図: 上のフランジ A は左へ出て先のリップ C が下へ、下のフランジ A は右へ出て先のリップ C が上へ折れる。 */
function lipZProfile(size: string): SteelCatalogProfile | undefined {
  const row = lipZs.get(size);
  if (row === undefined) return undefined;
  const [h, a, c, t] = row.slice(1, 5).map(Number);
  const web = a - t, right = 2 * a - t;
  return bentProfile(t, right, h, [[web, 0, 'outer'], [right, 0, 'outer'], [right, c, 'sharp'], [right - t, c, 'sharp'],
    [right - t, t, 'inner'], [a, t, 'inner'], [a, h, 'outer'], [0, h, 'outer'], [0, h - c, 'sharp'], [t, h - c, 'sharp'],
    [t, h - t, 'inner'], [web, h - t, 'inner']]);
}

/**
 * 表10 の図: 下のつば C が左右へ出て、2 つのウェブが立ち、上の面 A で閉じる。H はつばの下の面から上の面まで、
 * A は上の面の外の幅、C はウェブの外の面からつばの先まで（表12 の式 t(2H+A+2C−4.575t) と同じ置き方）。
 */
function hatProfile(size: string): SteelCatalogProfile | undefined {
  const row = hats.get(size);
  if (row === undefined) return undefined;
  const [h, a, c, t] = row.slice(1, 5).map(Number);
  const right = c + a;
  return bentProfile(t, right + c, h, [[0, 0, 'sharp'], [c + t, 0, 'outer'], [c + t, h - t, 'inner'],
    [right - t, h - t, 'inner'], [right - t, 0, 'outer'], [right + c, 0, 'sharp'], [right + c, t, 'sharp'],
    [right, t, 'inner'], [right, h, 'outer'], [c, h, 'outer'], [c, t, 'inner'], [0, t, 'sharp']]);
}

/**
 * JIS G 3192 表17 の図: フランジ B×t2 が上（フランジの外の面が y = H）、ウェブ t1 は幅の中央から下へ伸びる。
 * フランジは一定の厚さ（t2 は B/4 の位置で測る）。根元の 2 つの角だけを r で丸め、ほかの角は丸めない
 * （表6 の断面積の式 t1(H−t2)+Bt2+0.429r² と同じ形）。
 */
function ctProfile(size: string): SteelCatalogProfile | undefined {
  const row = cts.get(size);
  if (row === undefined) return undefined;
  const [h, b, tw, tf, root] = row.slice(0, 5).map(Number);
  const left = (b - tw) / 2, right = (b + tw) / 2, under = h - tf;
  return catalogProfile({ width: b, height: h, rootRadius: root, tipRadius: 0, taperDegrees: 0,
    segments: roundedLoop([[left, 0], [right, 0], [right, under], [b, under], [b, h], [0, h], [0, under], [left, under]],
      [0, 0, root, 0, 0, 0, 0, root]), holes: [] });
}

const SOURCED_PROFILES: Readonly<Record<string, (size: string) => SteelCatalogProfile | undefined>> = {
  rectTube: rectTubeProfile, unequalAngle: unequalAngleProfile, iBeam: iBeamProfile,
  lightChannel: lightChannelProfile, lightZ: lightZProfile, lightAngle: lightAngleProfile,
  lipChannel: lipChannelProfile, lipZ: lipZProfile, hatSection: hatProfile, ctSection: ctProfile,
};

/** 材質別の鋼材の断面。資料で形が決まる行だけを返し、それ以外は undefined（推測で形を作らない）。 */
export function steelCatalogProfile(catalog: string, size: string): SteelCatalogProfile | undefined {
  const sourced = Object.hasOwn(SOURCED_PROFILES, catalog) ? SOURCED_PROFILES[catalog] : undefined;
  if (sourced !== undefined) return sourced(size);
  const legacy = steelSectionProfile(catalog, size);
  return legacy === undefined ? undefined : { ...legacy, holes: [] };
}
