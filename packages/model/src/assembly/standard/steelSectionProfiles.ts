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
};
const channels: Readonly<Record<string, readonly [number, number, number, number]>> = {
  '[ 75×40×5×7': [75, 40, 5, 7],
  '[ 100×50×5×7.5': [100, 50, 5, 7.5],
  '[ 125×65×6×8': [125, 65, 6, 8],
};
const beams: Readonly<Record<string, readonly [number, number, number, number, number]>> = {
  'H 150×150×7×10': [150, 150, 7, 10, 8],
  'H 200×200×8×12': [200, 200, 8, 12, 13],
  'H 300×300×10×15': [300, 300, 10, 15, 13],
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
    const [h, b, tw, tf] = row;
    // The drawing gives 95° at the web, i.e. 5° flange taper, not a 5% gradient.
    // t2 is measured at the midpoint of the outstand (B-t1)/2.
    const offset = Math.tan(5 * Math.PI / 180) * (b - tw) / 2;
    return profile(b, h, 8, 4, 5,
      [[0, 0], [b, 0], [b, tf - offset], [tw, tf + offset],
        [tw, h - tf - offset], [b, h - tf + offset], [b, h], [0, h]],
      [0, 0, 4, 8, 8, 4, 0, 0]);
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
