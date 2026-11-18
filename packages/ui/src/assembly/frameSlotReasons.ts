/**
 * フレームの溝への締結(J-02 P6b・P7)の断りの文。利用者に code や鍵の名前を見せず、理由と次の手の文を出す。
 *
 * - 穴を結び付けられない時: 輪の穴を通し穴と読めない理由はこの窓の文、締結と同じ断り(穴の面が見つからない・版が古い など)は
 *   締結の窓の文をそのまま使う(`boltedJointReasonKey`。同じ意味の文を二重に持たない)。
 * - 計画の断り: 元の断り(置き場所が読めない・ボルトの長さが合わない)がある時は締結の窓の文、無い時は code ごとのこの窓の文。
 * code ごとの文の表は、足し忘れが型で落ちる形(`Record<code, 鍵>`)にする。
 */
import type { FrameSlotHoleFailure, ProfileHoleRejection } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import { boltedJointReasonKey } from './boltedJointDraft.js';
import type { FrameSlotHoleLabel } from './frameSlotFasteningDraft.js';

/** 計画の断りの code ごとの文(次の手を含む)。 */
const FRAME_SLOT_REASON_KEYS: Readonly<Record<FrameSlotHoleFailure['code'], MessageKey>> = {
  holeNotClearance: 'assembly.frameSlot.reason.holeNotClearance', holeNotPlaceable: 'assembly.frameSlot.reason.holeNotPlaceable',
  notOnSlotFace: 'assembly.frameSlot.reason.notOnSlotFace', offSlot: 'assembly.frameSlot.reason.offSlot',
  outsideSlotEnd: 'assembly.frameSlot.reason.outsideSlotEnd', slotWidthUnknown: 'assembly.frameSlot.reason.slotWidthUnknown',
  slotNominalUnknown: 'assembly.frameSlot.reason.slotNominalUnknown', boltWiderThanSlot: 'assembly.frameSlot.reason.boltWiderThanSlot',
  noSlotNut: 'assembly.frameSlot.reason.noSlotNut', slotPartHeightUnknown: 'assembly.frameSlot.reason.slotPartHeightUnknown',
  noBoltLength: 'assembly.frameSlot.reason.noBoltLength',
};

/** 輪の穴を通し穴と読めない理由ごとの文(次の手を含む)。 */
const PROFILE_HOLE_REASON_KEYS: Readonly<Record<ProfileHoleRejection, MessageKey>> = {
  notCylinder: 'assembly.frameSlot.profile.notCylinder', exteriorCylinder: 'assembly.frameSlot.profile.exteriorCylinder',
  partialCylinder: 'assembly.frameSlot.profile.partialCylinder', matingNotPlane: 'assembly.frameSlot.profile.matingNotPlane',
  matingNotPerpendicular: 'assembly.frameSlot.profile.matingNotPerpendicular', matingNotAtEnd: 'assembly.frameSlot.profile.matingNotAtEnd',
  oppositeEndMissing: 'assembly.frameSlot.profile.oppositeEndMissing', steppedHole: 'assembly.frameSlot.profile.steppedHole',
};

/** 文の {名前} を理由の数で埋める(数は画面の数の表し方)。 */
function filled(key: MessageKey, detail: FrameSlotHoleFailure['detail']): string {
  return Object.entries(detail).reduce((text, [name, value]) => text.split(`{${name}}`)
    .join(typeof value === 'number' ? displayNumber(value).text : value), t(key));
}

/** 穴 1 つの断りの文。結び付けの理由 → 計画の元の断り → 計画の code の順に読む。 */
export function frameSlotReasonText(failure: FrameSlotHoleFailure, label: FrameSlotHoleLabel | undefined): string {
  const bind = label?.bindFailure ?? null;
  if (bind !== null) return bind.kind === 'profile' ? t(PROFILE_HOLE_REASON_KEYS[bind.rejection]) : t(boltedJointReasonKey(bind.rejection));
  if (failure.cause !== undefined) return t(boltedJointReasonKey(failure.cause));
  return filled(FRAME_SLOT_REASON_KEYS[failure.code], failure.detail);
}
