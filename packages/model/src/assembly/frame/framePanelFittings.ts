import { withinMagnitude } from '../../numericTolerance.js';
import { addVec3, crossVec3, scaleVec3, type Vec3 } from '../../sketch/vec3.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import type { PlacedFrameMember } from './frameJoints.js';
import { frameMemberRange, openingFrame, openingPoint, type FrameOpening } from './framePanelOpening.js';

const SUPPORT_TOLERANCE_MM = 0.01;
const ORIENTATION_TOLERANCE = 1e-9;

interface PanelHolder {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

interface FittingOptions {
  readonly gap: number;
  readonly thickness: number;
  readonly flip: boolean;
  readonly holder: PanelHolder | null;
  readonly connector: boolean;
}

type FittingPlan =
  | { readonly ok: true; readonly holders: readonly RigidPlacement[]; readonly connectors: readonly RigidPlacement[] }
  | { readonly ok: false; readonly reason: 'holderNoRoom' | 'connectorNoRoom' };

interface HolderEdge {
  readonly along: number;
  readonly up: number;
  readonly direction: Vec3;
}

function holderOnEdge(frame: FrameOpening, holder: PanelHolder, normal: Vec3, edge: HolderEdge): RigidPlacement | null {
  const rotation = quaternionFromBasis(crossVec3(normal, edge.direction), normal, edge.direction, ORIENTATION_TOLERANCE);
  if (rotation === null) return null;
  const center = openingPoint(frame, edge.along, edge.up);
  return { position: addVec3(center, scaleVec3(edge.direction, -holder.height / 2)), rotation };
}

/** Holder envelopes straddle the gap at the middle of each edge. */
function planHolders(frame: FrameOpening, options: FittingOptions): readonly RigidPlacement[] | null {
  const { holder, gap, thickness } = options;
  if (holder === null) return [];
  const [left, right] = frame.width, [bottom, top] = frame.height;
  if (![holder.width, holder.depth, holder.height].every((size) => Number.isFinite(size) && size > 0)
    || holder.width <= gap || holder.depth < thickness
    || holder.height >= Math.min(right - left, top - bottom) - 2 * gap) return null;
  const normal = scaleVec3(frame.n, options.flip ? -1 : 1);
  const edges = [
    { along: (left + right) / 2, up: bottom + gap / 2, direction: frame.u },
    { along: (left + right) / 2, up: top - gap / 2, direction: frame.u },
    { along: left + gap / 2, up: (bottom + top) / 2, direction: frame.v },
    { along: right - gap / 2, up: (bottom + top) / 2, direction: frame.v },
  ];
  const placements = edges.map((edge) => holderOnEdge(frame, holder, normal, edge));
  return placements.every((entry) => entry !== null) ? placements : null;
}

/** Connector envelopes bridge the frame corners on the side opposite the board face. */
function planConnectors(frame: FrameOpening, members: readonly PlacedFrameMember[], flip: boolean): readonly RigidPlacement[] | null {
  const sign = flip ? 1 : -1;
  const extent = members.map((member) => frameMemberRange(member, frame.n)[flip ? 1 : 0]);
  const plane = flip ? Math.max(...extent) : Math.min(...extent);
  if (!Number.isFinite(plane) || !extent.every((value) => withinMagnitude(plane - value, SUPPORT_TOLERANCE_MM))) return null;
  const rotation = quaternionFromBasis(frame.u, scaleVec3(frame.v, sign), scaleVec3(frame.n, sign), ORIENTATION_TOLERANCE);
  if (rotation === null) return null;
  return frame.width.flatMap((along) => frame.height.map((up) =>
    ({ position: openingPoint(frame, along, up, plane - frame.level), rotation })));
}

/** Fittings are planned without constructing any component documents. */
export function planFramePanelFittings(members: readonly PlacedFrameMember[], options: FittingOptions): FittingPlan {
  if (options.holder === null && !options.connector) return { ok: true, holders: [], connectors: [] };
  const frame = openingFrame(members);
  if (typeof frame === 'string') return { ok: false, reason: 'holderNoRoom' };
  const holders = planHolders(frame, options);
  if (holders === null) return { ok: false, reason: 'holderNoRoom' };
  const connectors = options.connector ? planConnectors(frame, members, options.flip) : [];
  return connectors === null ? { ok: false, reason: 'connectorNoRoom' } : { ok: true, holders, connectors };
}
