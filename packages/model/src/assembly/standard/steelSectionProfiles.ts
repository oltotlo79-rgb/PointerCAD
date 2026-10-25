/** Nominal rolled-section profiles, not measured manufacturing tolerances. */
export type SteelProfilePoint = readonly [number, number];
export type SteelProfileSegment =
  | { readonly kind: 'line'; readonly from: SteelProfilePoint; readonly to: SteelProfilePoint }
  | { readonly kind: 'arc'; readonly from: SteelProfilePoint; readonly to: SteelProfilePoint;
      readonly center: SteelProfilePoint; readonly radius: number;
      readonly startAngle: number; readonly endAngle: number };
export interface SteelSectionProfile {
  readonly width: number;
  readonly height: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly taperDegrees: number;
  readonly segments: readonly SteelProfileSegment[];
  readonly areaMm2: number;
}

export const STEEL_PROFILE_EVIDENCE = {
  jfeAngle: {
    title: 'JFE条鋼 形鋼・平鋼・丸鋼 寸法表', edition: null,
    url: 'https://www.jfe-bs.co.jp/files/size_kata-hira-maru.pdf',
    locator: 'PDF p11（冊子p9）等辺山形鋼 AB：40×40×5、50×50×6、65×65×6 の r1/r2',
    sha256: '031d35df73d5681c7ad7cb721eea4838e80624c9ca7092a69c8e83641c5d65de',
    fetchedDate: '2026-10-10',
  },
  jfeChannel: {
    title: 'JFE条鋼 形鋼・平鋼・丸鋼 寸法表', edition: null,
    url: 'https://www.jfe-bs.co.jp/files/size_kata-hira-maru.pdf',
    locator: 'PDF p14（冊子p12）溝形鋼 CB：75・100・125 の r1/r2、95°図・t2測定位置',
    sha256: '031d35df73d5681c7ad7cb721eea4838e80624c9ca7092a69c8e83641c5d65de',
    fetchedDate: '2026-10-10',
  },
  yamatoH: {
    title: 'ヤマトスチール株式会社 会社案内', edition: '2025.12',
    url: 'https://www.yamatokogyo.co.jp/steel/en/catalog/pdf/company-brochureA3.pdf',
    locator: 'PDF p3（冊子p3/4）広幅H形鋼：150×150、200×200、300×300 の r',
    sha256: '69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22',
    fetchedDate: '2026-10-10',
  },
} as const;

const angles: Readonly<Record<string, readonly [number, number, number, number]>> = {
  'L 40×40×5': [40, 5, 4.5, 3],
  'L 50×50×6': [50, 6, 6.5, 4.5],
  'L 65×65×6': [65, 6, 8.5, 4],
  // JISF G 3192 原案 表8; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json.
  'L 120×120×8': [120, 8, 12, 5],
  'L 130×130×9': [130, 9, 12, 6],
  'L 130×130×12': [130, 12, 12, 8.5],
  'L 130×130×15': [130, 15, 12, 8.5],
  'L 150×150×12': [150, 12, 14, 7],
  'L 150×150×15': [150, 15, 14, 10],
  'L 150×150×19': [150, 19, 14, 10],
  'L 175×175×12': [175, 12, 15, 11],
  'L 175×175×15': [175, 15, 15, 11],
  'L 200×200×15': [200, 15, 17, 12],
  'L 200×200×20': [200, 20, 17, 12],
  'L 200×200×25': [200, 25, 17, 12],
  'L 250×250×25': [250, 25, 24, 12],
  'L 250×250×35': [250, 35, 24, 18],
};
const channels: Readonly<Record<string, readonly [number, number, number, number, number?, number?]>> = {
  '[ 75×40×5×7': [75, 40, 5, 7],
  '[ 100×50×5×7.5': [100, 50, 5, 7.5],
  '[ 125×65×6×8': [125, 65, 6, 8],
  // JISF G 3192 原案 表12; docs/standards/jis/channel-jis-g-3192.json, last eight rows.
  '[ 250×90×9×13': [250, 90, 9, 13, 14, 7],
  '[ 250×90×11×14.5': [250, 90, 11, 14.5, 17, 8.5],
  '[ 300×90×9×13': [300, 90, 9, 13, 14, 7],
  '[ 300×90×10×15.5': [300, 90, 10, 15.5, 19, 9.5],
  '[ 300×90×12×16': [300, 90, 12, 16, 19, 9.5],
  '[ 380×100×10.5×16': [380, 100, 10.5, 16, 18, 9],
  '[ 380×100×13×16.5': [380, 100, 13, 16.5, 18, 9],
  '[ 380×100×13×20': [380, 100, 13, 20, 24, 12],
};
const beams: Readonly<Record<string, readonly [number, number, number, number, number]>> = {
  'H 150×150×7×10': [150, 150, 7, 10, 8],
  'H 200×200×8×12': [200, 200, 8, 12, 13],
  'H 300×300×10×15': [300, 300, 10, 15, 13],
  // W7 JISF G 3192 原案 表15; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json.
  'H 100×100×6×8': [100, 100, 6, 8, 8],
  'H 125×125×6.5×9': [125, 125, 6.5, 9, 8],
  'H 175×175×7.5×11': [175, 175, 7.5, 11, 13],
  'H 250×250×9×14': [250, 250, 9, 14, 13],
  'H 100×50×5×7': [100, 50, 5, 7, 8],
  'H 125×60×6×8': [125, 60, 6, 8, 8],
  'H 150×75×5×7': [150, 75, 5, 7, 8],
  'H 148×100×6×9': [148, 100, 6, 9, 8],
  'H 175×90×5×8': [175, 90, 5, 8, 8],
  'H 198×99×4.5×7': [198, 99, 4.5, 7, 8],
  'H 200×100×5.5×8': [200, 100, 5.5, 8, 8],
  'H 194×150×6×9': [194, 150, 6, 9, 8],
  'H 248×124×5×8': [248, 124, 5, 8, 8],
  'H 250×125×6×9': [250, 125, 6, 9, 8],
  'H 244×175×7×11': [244, 175, 7, 11, 13],
  'H 298×149×5.5×8': [298, 149, 5.5, 8, 13],
  'H 300×150×6.5×9': [300, 150, 6.5, 9, 13],
  'H 294×200×8×12': [294, 200, 8, 12, 13],
  'H 346×174×6×9': [346, 174, 6, 9, 13],
  'H 350×175×7×11': [350, 175, 7, 11, 13],
  'H 340×250×9×14': [340, 250, 9, 14, 13],
  'H 350×350×12×19': [350, 350, 12, 19, 13],
  'H 396×199×7×11': [396, 199, 7, 11, 13],
  'H 400×200×8×13': [400, 200, 8, 13, 13],
  'H 390×300×10×16': [390, 300, 10, 16, 13],
  'H 400×400×13×21': [400, 400, 13, 21, 22],
  'H 414×405×18×28': [414, 405, 18, 28, 22],
  'H 428×407×20×35': [428, 407, 20, 35, 22],
  'H 458×417×30×50': [458, 417, 30, 50, 22],
  'H 498×432×45×70': [498, 432, 45, 70, 22],
  'H 446×199×8×12': [446, 199, 8, 12, 13],
  'H 450×200×9×14': [450, 200, 9, 14, 13],
  'H 440×300×11×18': [440, 300, 11, 18, 13],
  'H 496×199×9×14': [496, 199, 9, 14, 13],
  'H 500×200×10×16': [500, 200, 10, 16, 13],
  'H 482×300×11×15': [482, 300, 11, 15, 13],
  'H 488×300×11×18': [488, 300, 11, 18, 13],
  'H 596×199×10×15': [596, 199, 10, 15, 13],
  'H 600×200×11×17': [600, 200, 11, 17, 13],
  'H 582×300×12×17': [582, 300, 12, 17, 13],
  'H 588×300×12×20': [588, 300, 12, 20, 13],
  'H 594×302×14×23': [594, 302, 14, 23, 13],
  'H 692×300×13×20': [692, 300, 13, 20, 18],
  'H 700×300×13×24': [700, 300, 13, 24, 18],
  'H 792×300×14×22': [792, 300, 14, 22, 18],
  'H 800×300×14×26': [800, 300, 14, 26, 18],
  'H 890×299×15×23': [890, 299, 15, 23, 18],
  'H 900×300×16×28': [900, 300, 16, 28, 18],
  'H 912×302×18×34': [912, 302, 18, 34, 18],
  'H 918×303×19×37': [918, 303, 19, 37, 18],
};
const cross = (a: SteelProfilePoint, b: SteelProfilePoint): number => a[0] * b[1] - a[1] * b[0];
const distance = (a: SteelProfilePoint, b: SteelProfilePoint): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Replace selected polygon corners with tangent circular arcs; signed sweep retains concavity. */
function roundedBoundary(vertices: readonly SteelProfilePoint[], radii: readonly number[]): readonly SteelProfileSegment[] {
  const corners = vertices.map((point, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    const next = vertices[(index + 1) % vertices.length];
    const incoming = distance(previous, point);
    const outgoing = distance(point, next);
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
    const center: SteelProfilePoint = [from[0] - u[1] * Math.sign(turn) * radius,
      from[1] + u[0] * Math.sign(turn) * radius];
    const startAngle = Math.atan2(from[1] - center[1], from[0] - center[0]);
    return { from, to, center, radius, tangent, incoming, startAngle, endAngle: startAngle + turn };
  });
  const result: SteelProfileSegment[] = [];
  corners.forEach((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length];
    if (previous.tangent + corner.tangent > corner.incoming + 1e-10) {
      throw new Error('Overlapping sourced steel profile radii.');
    }
    if (distance(previous.to, corner.from) > 1e-10) result.push({ kind: 'line', from: previous.to, to: corner.from });
    if (corner.radius > 0) result.push({ kind: 'arc', from: corner.from, to: corner.to,
      center: corner.center, radius: corner.radius, startAngle: corner.startAngle, endAngle: corner.endAngle });
  });
  return result;
}

function profile(width: number, height: number, rootRadius: number, tipRadius: number, taperDegrees: number,
  vertices: readonly SteelProfilePoint[], radii: readonly number[]): SteelSectionProfile {
  const segments = roundedBoundary(vertices, radii);
  const areaMm2 = segments.reduce((area, segment) => area + (segment.kind === 'line'
    ? cross(segment.from, segment.to) / 2
    : (segment.center[0] * (segment.to[1] - segment.from[1])
      - segment.center[1] * (segment.to[0] - segment.from[0])
      + segment.radius ** 2 * (segment.endAngle - segment.startAngle)) / 2), 0);
  return { width, height, rootRadius, tipRadius, taperDegrees, segments, areaMm2 };
}

/** Only the nine source-backed material-aware rows; never infer radii for legacy catalog sizes. */
export function steelSectionProfile(catalog: string, size: string): SteelSectionProfile | undefined {
  if (catalog === 'equalAngle') {
    const row = Object.hasOwn(angles, size) ? angles[size] : undefined;
    if (row === undefined) return undefined;
    const [a, t, root, tip] = row;
    return profile(a, a, root, tip, 0, [[0, 0], [a, 0], [a, t], [t, t], [t, a], [0, a]],
      [0, 0, tip, root, tip, 0]);
  }
  if (catalog === 'channel') {
    const row = Object.hasOwn(channels, size) ? channels[size] : undefined;
    if (row === undefined) return undefined;
    const [h, b, tw, tf, root = 8, tip = 4] = row;
    // The drawing gives 95° at the web, i.e. 5° flange taper, not a 5% gradient.
    // t2 is measured at the midpoint of the outstand (B-t1)/2.
    const offset = Math.tan(5 * Math.PI / 180) * (b - tw) / 2;
    return profile(b, h, root, tip, 5,
      [[0, 0], [b, 0], [b, tf - offset], [tw, tf + offset],
        [tw, h - tf - offset], [b, h - tf + offset], [b, h], [0, h]],
      [0, 0, tip, root, root, tip, 0, 0]);
  }
  if (catalog === 'hBeam') {
    const row = Object.hasOwn(beams, size) ? beams[size] : undefined;
    if (row === undefined) return undefined;
    const [h, b, tw, tf, root] = row;
    const left = (b - tw) / 2;
    const right = (b + tw) / 2;
    // No tip radius is specified in this drawing; only the four root radii are modeled.
    return profile(b, h, root, 0, 0,
      [[0, 0], [b, 0], [b, tf], [right, tf], [right, h - tf], [b, h - tf],
        [b, h], [0, h], [0, h - tf], [left, h - tf], [left, tf], [0, tf]],
      [0, 0, 0, root, root, 0, 0, 0, 0, root, root, 0]);
  }
  return undefined;
}
