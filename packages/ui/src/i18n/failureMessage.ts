/**
 * 計算部(model)が返した失敗の文の鍵と差し込む値から、画面の文を作る(D4「失敗の文は画面の側の一覧に持つ」)。
 * 文は文言の表(ja/*.json)が鍵ごとに 1 つ持ち、model は文を持たない。鍵が表に無い時(作る側の誤り)は、内部の鍵を
 * 画面に出さず、共通の 1 つの文(assembly.error.internal)にする(統括の決定 2026-11-20 18:4x の D4-1)。
 */
import type { FailureText, SolidBodyFailure } from '@pointercad/model';

import { MESSAGE_KEYS, t, type MessageKey } from './t.js';

/** 文言の表の差し込みの目印(名前は英字と数字だけ)。 */
const PLACEHOLDER = /\{([A-Za-z0-9]+)\}/gu;

type GeometryCode = NonNullable<NonNullable<SolidBodyFailure['parameters']>['geometryCode']>;
const GEOMETRY_KEYS: Readonly<Record<GeometryCode, MessageKey>> = {
  'geometry-open-solid': 'solidFailure.boolean.openSolid',
  'geometry-union-count': 'solidFailure.boolean.unionCount',
  'geometry-nothing-left': 'solidFailure.boolean.nothingLeft',
  'geometry-profile-no-removal': 'solidFailure.boolean.profileNoRemoval',
  'geometry-profile-no-inside': 'solidFailure.boolean.profileNoInside',
  'geometry-profile-no-outside': 'solidFailure.boolean.profileNoOutside',
  'geometry-pattern-detached': 'solidFailure.pattern.detached',
  'geometry-transform-not-finite': 'solidFailure.transform.notFinite',
  'geometry-transform-axis': 'solidFailure.transform.axis',
  'geometry-plane-not-finite': 'solidFailure.transform.planeNotFinite',
  'geometry-mirror-normal': 'solidFailure.transform.mirrorNormal',
  'geometry-scale-factor': 'solidFailure.transform.scaleFactor',
  'geometry-scale-choice': 'solidFailure.transform.scaleChoice',
  'geometry-placement-not-finite': 'solidFailure.placement.notFinite',
  'geometry-placement-rotation': 'solidFailure.placement.rotation',
  'geometry-loft-segments': 'solidFailure.loft.segments',
  'geometry-loft-open-profile': 'solidFailure.loft.openProfile',
  'geometry-loft-two-spheres': 'solidFailure.loft.twoSpheres',
  'geometry-loft-sphere-profile': 'solidFailure.loft.sphereProfile',
  'geometry-loft-sphere-tangent': 'solidFailure.loft.sphereTangent',
  'geometry-loft-build': 'solidFailure.loft.build',
  'geometry-loft-not-solid': 'solidFailure.loft.notSolid',
  'geometry-loft-twist': 'solidFailure.loft.twist',
  'geometry-loft-sphere-radius': 'solidFailure.loft.sphereRadius',
  'geometry-loft-missing-face': 'solidFailure.loft.missingFace',
  'geometry-loft-unusable-face': 'solidFailure.loft.unusableFace',
  'geometry-loft-face-with-holes': 'solidFailure.loft.faceWithHoles',
  'geometry-loft-sections': 'solidFailure.loft.sections',
  'geometry-pathSweep-path-disconnected': 'solidFailure.pathSweep.pathDisconnected',
  'geometry-pathSweep-profile-disconnected': 'solidFailure.pathSweep.profileDisconnected',
  'geometry-pathSweep-guide-disconnected': 'solidFailure.pathSweep.guideDisconnected',
  'geometry-pathSweep-no-path': 'solidFailure.pathSweep.noPath',
  'geometry-pathSweep-no-profile': 'solidFailure.pathSweep.noProfile',
  'geometry-pathSweep-open-profile': 'solidFailure.pathSweep.openProfile',
  'geometry-pathSweep-non-planar-profile': 'solidFailure.pathSweep.nonPlanarProfile',
  'geometry-pathSweep-self-intersecting-profile': 'solidFailure.pathSweep.selfIntersectingProfile',
  'geometry-pathSweep-no-tangent': 'solidFailure.pathSweep.noTangent',
  'geometry-pathSweep-build': 'solidFailure.pathSweep.build',
  'geometry-pathSweep-not-solid': 'solidFailure.pathSweep.notSolid',
  'geometry-pathSweep-incomplete': 'solidFailure.pathSweep.incomplete',
  'geometry-pathSweep-tight': 'solidFailure.pathSweep.tight',
  'geometry-pathSweep-law-with-guide': 'solidFailure.pathSweep.lawWithGuide',
  'geometry-pathSweep-guide-interval': 'solidFailure.pathSweep.guideInterval',
  'geometry-pathSweep-guide-degenerate': 'solidFailure.pathSweep.guideDegenerate',
  'geometry-pathSweep-guide-contact': 'solidFailure.pathSweep.guideContact',
  'geometry-pathSweep-guide-change': 'solidFailure.pathSweep.guideChange',
  'geometry-pathSweep-guide-section': 'solidFailure.pathSweep.guideSection',
  'geometry-pathSweep-law-frame': 'solidFailure.pathSweep.lawFrame',
  'geometry-pathSweep-law-joint': 'solidFailure.pathSweep.lawJoint',
  'geometry-pathSweep-law-closed': 'solidFailure.pathSweep.lawClosed',
  'geometry-pathSweep-law-twist': 'solidFailure.pathSweep.lawTwist',
  'geometry-pathSweep-law-scale': 'solidFailure.pathSweep.lawScale',
  'geometry-pathSweep-hole-disconnected': 'solidFailure.pathSweep.holeDisconnected',
  'geometry-pathSweep-offset-disconnected': 'solidFailure.pathSweep.offsetDisconnected',
  'geometry-pathSweep-wall-with-holes': 'solidFailure.pathSweep.wallWithHoles',
  'geometry-pathSweep-wall-value': 'solidFailure.pathSweep.wallValue',
  'geometry-pathSweep-wall-too-thick': 'solidFailure.pathSweep.wallTooThick',
  'geometry-pathSweep-hollow-cut': 'solidFailure.pathSweep.hollowCut',
  'geometry-surface-direction': 'solidFailure.surface.direction',
  'geometry-surface-extrude-distance': 'partError.extrude.distance',
  'geometry-surface-revolve-angle': 'solidFailure.surface.revolveAngle',
  'geometry-surface-axis': 'solidFailure.revolve.axis',
  'geometry-surface-build': 'solidFailure.surface.build',
  'geometry-surface-face-required': 'solidFailure.surface.faceRequired',
  'geometry-surface-solid-result': 'solidFailure.surface.solidResult',
  'geometry-surface-offset-distance': 'solidFailure.surface.offsetDistance',
  'geometry-surface-offset-build': 'solidFailure.surface.offsetBuild',
  'geometry-profile-faceNoCurves': 'partError.sketchKernel.faceNoCurves',
  'geometry-profile-notConnected': 'partError.sketchKernel.notConnected',
  'geometry-profile-faceOpen': 'partError.sketchKernel.faceOpen',
  'geometry-profile-faceNotPlanar': 'partError.sketchKernel.faceNotPlanar',
  'geometry-profile-faceSelfIntersection': 'partError.sketchKernel.faceSelfIntersection',
  'geometry-profile-segmentEdge': 'partError.sketchKernel.segmentEdge',
  'geometry-profile-arcEdge': 'partError.sketchKernel.arcEdge',
  'geometry-profile-arcRadius': 'partError.sketchKernel.arcRadius',
  'geometry-internal': 'assembly.error.internal',
};

function geometryMessageKey(text: FailureText): MessageKey | undefined {
  if (text.key !== 'partError.plainText') return undefined;
  const code = text.parameters.geometryCode;
  return typeof code === 'string' ? GEOMETRY_MESSAGE_KEYS.get(code) : undefined;
}

const GEOMETRY_MESSAGE_KEYS: ReadonlyMap<string, MessageKey> = new Map(Object.entries(GEOMETRY_KEYS));

/**
 * 鍵の文の目印 {名前} を、差し込む値で 1 回で置き換える(0b-3h2)。差し込んだ値の中の {…}(利用者の名前・計算部の文の波かっこ)は
 * 読み直さないので、別の値に置き換わらない。値の無い目印はそのまま残す。
 */
export function failureMessage(text: FailureText): string {
  const key = geometryMessageKey(text)
    ?? MESSAGE_KEYS.find((candidate) => candidate === text.key)
    ?? 'assembly.error.internal';
  return t(key).replace(PLACEHOLDER, (placeholder: string, name: string) => {
    const value = Object.hasOwn(text.parameters, name) ? text.parameters[name] : undefined;
    if (value === undefined) return placeholder;
    return typeof value === 'string' ? value : failureMessage(value);
  });
}

/** 鍵と差し込む値の組を、画面の文にする(値が無い時は鍵の文のまま)。読めなかった理由の知らせ(FileMessage・復元の案内)が使う。 */
export function messageText(message: { readonly key: MessageKey; readonly parameters?: Readonly<Record<string, string>> | undefined }): string {
  return message.parameters === undefined ? t(message.key) : failureMessage({ key: message.key, parameters: message.parameters });
}

/**
 * 合致の断りの文(文字。合致の道を鍵へ移す D4 の 0c までは model の文)と、組立の誤りの鍵と値が混ざる一覧を、画面の文にする。
 * 0c で合致の道も鍵になったら消す。
 */
export function mixedFailureMessages(items: readonly (string | FailureText)[]): string[] {
  return items.map((item) => typeof item === 'string' ? item : failureMessage(item));
}

/**
 * 梁の解析の断り(AnalysisIssue か、投げられた InputIssue)の英語の診断の文の目印 {failures} の所へ、組立の誤りの文を「; 」で
 * つないで入れる(統括の決定 2026-11-20 19:4x。並びと区切りは鍵へ移す前の `solved.messages.join('; ')` と同じ)。
 * 目印を含む文を画面・診断へ出す所は、全部この口を通す(通していない所が無い事は、0a の束の README の道具で確かめる)。
 */
export function issueMessage(issue: { readonly message: string; readonly failures?: readonly (string | FailureText)[] | undefined }): string {
  if (issue.failures === undefined) return issue.message;
  return issue.message.split('{failures}').join(mixedFailureMessages(issue.failures).join('; '));
}
