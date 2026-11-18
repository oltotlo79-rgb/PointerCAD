/**
 * フレームの溝への締結の断りの文の検査: 計画の code・輪の穴の理由・締結と同じ断りの code の全部について、利用者に見せる文が
 * 鍵の名前や code のままでなく、{名前} が残らない事。code の一覧は型から作る(model に code を足すと、この表が型で落ちる)。
 */
import type { BoltedJointRejectionCode, FrameSlotHoleFailure, ProfileHoleRejection } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { frameSlotReasonText } from './frameSlotReasons.js';

/** 計画の code の全部と、文が使う数(code の文に {名前} があれば全部をここに持つ)。 */
const PLAN_CODES = {
  holeNotClearance: {}, holeNotPlaceable: {}, notOnSlotFace: {}, offSlot: { offsetMm: 3, allowedMm: 0.6 },
  outsideSlotEnd: { alongMm: 2, slotLengthMm: 500 }, slotWidthUnknown: {}, slotNominalUnknown: {}, boltWiderThanSlot: { thread: 'M8', openingMm: 6 },
  noSlotNut: { slot: 6, thread: 'M5' },
  slotPartHeightUnknown: { nut: 'T 溝用ナット 溝幅 6 M5（後入れ・ボール付き・鋼）' }, noBoltLength: {},
} satisfies Record<FrameSlotHoleFailure['code'], FrameSlotHoleFailure['detail']>;

const PROFILE_REJECTIONS = {
  notCylinder: true, exteriorCylinder: true, partialCylinder: true, matingNotPlane: true, matingNotPerpendicular: true,
  matingNotAtEnd: true, oppositeEndMissing: true, steppedHole: true,
} satisfies Record<ProfileHoleRejection, true>;

/** 締結と同じ断りの code の全部(結び付け・置き場所・頭・ボルトの長さの元の理由になる物を含む)。 */
const FASTENING_CODES = {
  componentMissing: true, componentSuppressed: true, componentNotPlaceable: true, sameComponent: true,
  staleSource: true, missingSourceRevision: true, invalidPlacement: true, invalidWorldFrame: true,
  holeFeatureMissing: true, holeFaceMissing: true, holeFaceMismatch: true, matingFaceMissing: true,
  holeNotOnMatingFace: true, threadEntryUnknown: true, alignmentBlocked: true, unsupportedHole: true,
  invalidDimension: true, invalidAxis: true, axisNotNormalized: true, faceAxisMismatch: true,
  axesNotOpposed: true, axesNotCoaxial: true, facesNotInContact: true, facesOverlap: true,
  bothHolesThreaded: true, unknownThread: true, pitchNotInCatalog: true, nominalMismatch: true, pitchMismatch: true,
  boltSizeUnspecified: true, boltRowMissing: true, nutRowMissing: true, washerRowMissing: true,
  insufficientClearance: true, holeLargerThanBearing: true, washerDoesNotFit: true,
  washerOnTappedSide: true, engagementRequired: true, engagementExceedsThread: true,
  blindClearanceRequired: true, blindBottoming: true, protrusionRequired: true,
  lengthAvailabilityMissing: true, noStandardLengthFits: true,
  existingConstraintConflict: true, existingConstraintUnresolved: true,
} satisfies Record<BoltedJointRejectionCode, true>;

/** 利用者に見せてよい文か(鍵の名前・code・埋め残しの {名前} が無い)。 */
function expectReadable(text: string, code: string): void {
  expect(text.length, code).toBeGreaterThan(0);
  expect(text, code).not.toContain('assembly.');
  expect(text, code).not.toContain(code);
  expect(text, code).not.toMatch(/[{}]/u);
}

describe('フレームの溝への締結の断りの文', () => {
  it('計画の code の全部に、次の手を含む文がある(数は埋める)', () => {
    for (const [code, detail] of Object.entries(PLAN_CODES)) {
      if (!isPlanCode(code)) throw new Error(code);
      expectReadable(frameSlotReasonText({ holeIndex: 0, code, detail }, undefined), code);
    }
  });

  it('輪の穴を通し穴と読めない理由の全部に、この窓の文がある', () => {
    for (const rejection of Object.keys(PROFILE_REJECTIONS).filter(isProfileRejection)) {
      expectReadable(frameSlotReasonText({ holeIndex: 0, code: 'holeNotPlaceable', detail: {} },
        { component: '板', bindFailure: { kind: 'profile', rejection } }), rejection);
    }
  });

  it('締結と同じ断りの code の全部は、結び付けの理由でも計画の元の理由でも、締結の窓の文で出る', () => {
    for (const code of Object.keys(FASTENING_CODES).filter(isFasteningCode)) {
      const rejection = { code, detail: {} };
      expectReadable(frameSlotReasonText({ holeIndex: 0, code: 'holeNotPlaceable', detail: {} },
        { component: '板', bindFailure: { kind: 'fastening', rejection } }), code);
      expectReadable(frameSlotReasonText({ holeIndex: 0, code: 'noBoltLength', detail: {}, cause: rejection }, undefined), code);
    }
  });
});

function isPlanCode(value: string): value is FrameSlotHoleFailure['code'] {
  return Object.hasOwn(PLAN_CODES, value);
}
function isProfileRejection(value: string): value is ProfileHoleRejection {
  return Object.hasOwn(PROFILE_REJECTIONS, value);
}
function isFasteningCode(value: string): value is BoltedJointRejectionCode {
  return Object.hasOwn(FASTENING_CODES, value);
}
