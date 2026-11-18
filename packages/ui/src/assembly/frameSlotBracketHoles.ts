/**
 * 選んだブラケットの全部の穴への締結(J-02 P7)。ブラケットの部品の今の形から、穴(穴の壁の由来を持つ内側の円筒面か、断面の輪の穴の
 * 全周の内側の円筒面。資料のブラケットの族は輪の穴で作る)を集め、P6b と同じ合わせ面の選び方・予告・確定に渡す。
 * 穴径・番号・順では穴を選ばない。
 */
import {
  findComponent, holeWallOriginAt, profileHoleSpan, type AssemblyDocument, type PartLibrary, type SolidBody, type Vec3,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';
import {
  chooseFrameSlotPairs, faceTargetOf, matingFaceEntries, previewFrameSlotPairs, type AssemblyFrameSlotDraft, type FaceTarget,
  type FrameSlotHolePair, type FrameSlotNutData, type FrameSlotPreviewWithPairs,
} from './frameSlotFasteningDraft.js';

type FaceEntry = SolidBody['faces'][number];

/** 同じ穴の壁の小片(縫い目で分かれた円筒)を 1 つの穴とみなす、軸の向きのずれと、軸の上の点の距離(mm)。 */
const AXIS_PARALLEL_TOLERANCE = 1e-6;
const SAME_AXIS_TOLERANCE_MM = 1e-6;

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

/** 2 つの軸が同じ直線か(向きと、点の差が軸に沿うか)。 */
function sameAxis(left: FaceEntry, right: FaceEntry): boolean {
  const leftOrigin = left.axisOrigin ?? null, rightOrigin = right.axisOrigin ?? null;
  if (left.axis === null || right.axis === null || leftOrigin === null || rightOrigin === null) return false;
  if (1 - Math.abs(dot(left.axis, right.axis)) > AXIS_PARALLEL_TOLERANCE) return false;
  const gap: Vec3 = [rightOrigin[0] - leftOrigin[0], rightOrigin[1] - leftOrigin[1], rightOrigin[2] - leftOrigin[2]];
  const along = dot(gap, left.axis);
  return dot(gap, gap) - along ** 2 <= SAME_AXIS_TOLERANCE_MM ** 2;
}

/**
 * 穴の壁の円筒面: 穴のフィーチャーの由来を持つ内側の面と、断面の輪の穴を押し出した全周の内側の円筒(1 面か、半円 2 つのように全周を閉じる面の輪。model の profileHoleSpan。
 * 部分の円筒〔隅の丸み〕は帯の範囲を持たないので入れない)。縫い目で分かれた同じ穴の小片は、呼ぶ側で 1 つにまとめる。
 */
function holeWalls(body: SolidBody): FaceEntry[] {
  return body.faces.filter((face) => face.surfaceKind === 'cylinder' && face.cylinderExterior !== true
    && (holeWallOriginAt(body.origins, face.index).status === 'hole' || profileHoleSpan(face, body.faces, body.edges) !== null));
}

/** 選んだブラケットの全部の穴の、合わせ面の候補つきの組(穴ごとに 1 つ。候補の無い穴は空の並び)。 */
function bracketHoleCandidates(document: AssemblyDocument, view: AssemblyView, componentIds: readonly string[]):
readonly { readonly hole: FaceTarget; readonly pairs: readonly FrameSlotHolePair[] }[] {
  const holes: { readonly hole: FaceTarget; readonly pairs: readonly FrameSlotHolePair[] }[] = [];
  for (const componentId of componentIds) {
    if (findComponent(document, componentId) === undefined) continue;
    const key = view.resolved.partKeys.get(componentId);
    for (const body of (key === undefined ? undefined : view.bodies.get(key)) ?? []) {
      const taken: FaceEntry[] = [];
      for (const wall of holeWalls(body)) {
        // 縫い目で分かれた同じ穴は、参照を作れた最初の小片だけ(参照の作れない小片で穴を落とさない)。
        const hole = taken.some((other) => sameAxis(other, wall)) ? null : faceTargetOf(componentId, body, wall);
        if (hole === null) continue;
        taken.push(wall);
        holes.push({ hole, pairs: matingFaceEntries(body, wall).flatMap((face) => {
          const target = faceTargetOf(componentId, body, face);
          return target === null ? [] : [{ hole, face: target }];
        }) });
      }
    }
  }
  return holes;
}

/** P7 の予告: 選んだブラケットに穴が無い時は理由、ある時は穴ごとに合わせ面を選んだ組の予告。 */
export function previewBracketSlotFastening(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyFrameSlotDraft, nut: FrameSlotNutData | null): FrameSlotPreviewWithPairs {
  const candidates = bracketHoleCandidates(document, view, draft.bracketIds ?? []);
  if (candidates.length === 0) return { preview: { kind: 'issue', issue: 'needPicks' }, pairs: [] };
  const pairs = chooseFrameSlotPairs(document, view, library, draft, nut, candidates);
  return { preview: previewFrameSlotPairs(document, view, library, draft, nut, pairs), pairs };
}
