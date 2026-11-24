/**
 * 面だけのボディの機能の失敗の文は画面の側の一覧が持つ(2026-11-20 の利用者の回答)。計算部は理由の符号だけを返す。
 * 期待の文は製品の一覧を読まずに書く(計算部の表にあった文と同じ)。
 */
import { plainText } from '@pointercad/model';
import { failureMessage } from '../i18n/failureMessage.js';
import type { PartRecomputeError, SolidFailureReason } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { localizedPartErrors, partErrorMessage } from './surfaceBodyFailureText.js';

const THICKEN = '閉じた立体を作れませんでした。厚さや厚みを付ける側を見直してください。';
const OFFSET = '面を離せませんでした。距離の大きさや向きを見直してください。';
const CASES: readonly (readonly [SolidFailureReason, string])[] = [
  ['faceted-function-surface', '平らな三角形の集まりでできた関数曲面には厚みを付けられません。式か許容差を見直して滑らかな面にするか、平らな面は押し出しか箱で作ってください。'],
  ['invalid-surface-body', '面だけのボディを 1 つ選んでください。'],
  ['invalid-thickness', '厚さには 0 より大きい値を入力してください。'],
  ['invalid-side', '厚みを付ける側を選び直してください。'],
  ['invalid-offset-distance', '離す距離には 0 以外の値を入力してください。'],
  ['offset-failed', OFFSET],
  ['invalid-offset-surface', OFFSET],
  ['thicken-failed', THICKEN],
  ['open-thick-solid', THICKEN],
  ['invalid-thick-solid', THICKEN],
  ['non-positive-volume', THICKEN],
  ['boundary-required', '面の境界として一方の側だけに面がある辺を選んでください。'],
  ['no-tangent', '選んだ辺で面に沿う横の接線を求められません。'],
  ['blend-failed', 'つなぎ面を作れませんでした。'],
  ['invalid-blend-face', 'つなぎ面の形が不正です。'],
  ['outside-tolerance', '辺からの離れか、接線または接平面の角度が許容差を超えました。重みや選んだ辺を見直してください。'],
];

function failed(reason: SolidFailureReason): PartRecomputeError {
  return { featureId: `feature-${reason}`, code: 'kernelFailed', text: plainText(reason), reason };
}

/** 0b-2 で kernel の 3 表(面による切断・面の縫い合わせ・辺からの距離の穴)から移した文。kernel の表にあった文と 1 文字も違わない事を見る。 */
const MOVED: readonly (readonly [SolidFailureReason, string])[] = [
  ['non-finite-input', '切断の座標・方向・範囲には有限な数を指定してください。'],
  ['invalid-blade', '切断には向きのそろった開いた曲線または面が必要です。'],
  ['non-planar-profile', '切断の曲線が指定したスケッチ平面に載っていません。'],
  ['self-intersection', '切断の曲線または面が自分自身と交わっています。'],
  ['no-intersection', '切断面が対象に届いていません。位置と範囲を見直してください。'],
  ['touch-only', '切断面が対象に接するだけで、ソリッドを分けられません。'],
  ['incomplete-cut', '切断面の端が対象の中で止まるため、ソリッドを完全に分けられません。'],
  ['ambiguous-side', '切断面に対する断片の側を一意に決められません。'],
  ['invalid-target', '切断する対象には有効な正の体積のソリッドが必要です。'],
  ['boolean-failed', '面による切断を計算できませんでした。形と範囲を見直してください。'],
  ['volume-mismatch', '切断前後の体積が必要な精度で一致しませんでした。'],
  ['insufficient-faces', 'ソリッドにするには面が 2 枚以上必要です。'],
  ['invalid-tolerance', 'つなぎ目の許容量は 0 より大きい有限の数にしてください。'],
  ['invalid-face', '縫い合わせる面が正しくありません。面を選び直してください。'],
  ['duplicate-face', '同じ面が重複しています。面を選び直してください。'],
  ['open-shell', '面のつながりに隙間があるため、ソリッドにできませんでした。'],
  ['non-manifold', '面のつなぎ目に 3 枚以上の面が重なっています。'],
  ['multiple-shells', '面が 2 つ以上の閉じた殻に分かれています。面を選び直してください。'],
  ['invalid-solid', '面が閉じた 1 つのソリッドになっていません。面を選び直してください。'],
  ['sewing-failed', '面を縫い合わせられませんでした。面と許容量を見直してください。'],
  ['missing-face', '縫い合わせる面が見つかりません。面を選び直してください。'],
  ['combination', '辺からの距離と中心点・円筒配置は同時に指定できません。'],
  ['distance', '辺からの距離には1つ以上の有限な距離を指定してください。'],
  ['notLine', '辺からの距離には直線の辺を選んでください。'],
  ['notOnFace', '辺からの距離には選んだ面の縁の辺を選んでください。'],
  ['degenerate', '辺からの距離には選んだ面の縁の辺を選んでください。'],
  ['side', '辺からの距離には選んだ面の縁の辺を選んでください。'],
  ['parallel', '辺からの距離には平行でない2本の辺を選んでください。'],
  ['outside', '辺からの距離の位置が選択面の内側にありません。'],
];

describe('面だけのボディの失敗の文(画面の側の一覧)', () => {
  it('kernel の 3 表から移した符号も、kernel にあった文と同じ文にする(0b-2)', () => {
    const errors: PartRecomputeError[] = MOVED.map(([reason]) => ({ featureId: `feature-${reason}`, code: 'kernelFailed', text: plainText(reason), reason }));
    expect(localizedPartErrors(errors).map(error => failureMessage(error.text))).toEqual(MOVED.map(([, text]) => text));
  });

  it('計算部の符号ごとに、利用者へ見せる文に替える', () => {
    const errors = CASES.map(([reason]) => failed(reason));
    expect(localizedPartErrors(errors).map(error => failureMessage(error.text))).toEqual(CASES.map(([, text]) => text));
  });

  it('ほかの失敗の文はそのまま、替える物が無ければ同じ配列を返す', () => {
    const other: PartRecomputeError = { featureId: 'cut', code: 'kernelFailed', text: plainText('面で切れませんでした。') };
    const untouched = [other];
    expect(localizedPartErrors(untouched)).toBe(untouched);
    expect(localizedPartErrors([other, failed('thicken-failed')]).map(error => failureMessage(error.text))).toEqual(['面で切れませんでした。', THICKEN]);
  });

  it('誤り 1 件の文: 符号の一覧に文があればその文、無ければ計算部の文のまま(画面へ出す所は全部これを通す。0b-2a)', () => {
    expect(partErrorMessage(failed('thicken-failed'))).toBe(THICKEN);
    expect(partErrorMessage({ featureId: 'cut', code: 'kernelFailed', text: plainText('面で切れませんでした。') })).toBe('面で切れませんでした。');
    expect(partErrorMessage({ featureId: 'sketch-1', code: 'invalidValue', text: plainText('値が正しくありません。') })).toBe('値が正しくありません。');
  });

  it('鍵へ移した穴・ねじ穴・ざぐり・皿もみ・円筒の側面の穴・丸め・面取りの誤りの文は、移す前の model の文と 1 文字も違わない(0b3c-holes)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.counterbore.diameter', {}, 'ざぐりの径は穴の径より大きくしてください。'],
      ['partError.counterbore.depth', {}, 'ざぐりの深さは 0 より大きい数にしてください。'],
      ['partError.countersink.angle', {}, '皿もみの角度は 0 度より大きく 180 度未満にしてください。'],
      ['partError.countersink.diameter', {}, '皿もみの頭の径は穴の径より大きくしてください。'],
      ['partError.cylinderHole.notCylinder', {}, '円筒の側面の穴をあけられるのは円筒の面だけです。円筒の面を選び直してください。'],
      ['partError.cylinderHole.noLocation', {}, '円筒の側面の穴の位置(高さと角度)が 1 つもありません。'],
      ['partError.cylinderHole.locationNotFinite', {}, '円筒の側面の穴の高さと角度は数にしてください。'],
      ['partError.cylinderHole.unsupported', {}, '円筒の側面の穴では、中心の点・傾き・皿もみはまだ使えません。位置は高さと角度で指定してください。'],
      ['partError.hole.centerMissing', {}, '穴の中心にする点が見つかりません。スケッチで点を作ってからやり直してください。'],
      ['partError.hole.depth', {}, '穴の深さは 0 より大きい数にしてください。'],
      ['partError.hole.tiltAngle', {}, '傾きの角度は 0 以上 90 度未満にしてください。'],
      ['partError.hole.tiltAzimuth', {}, '傾ける向きの角度が数になっていません。'],
      ['partError.hole.planarConflict', {}, '面内X・Yと中心点・円筒配置は同時に指定できません。'],
      ['partError.hole.planarNotPlane', {}, '面内X・Yには平らな面を選んでください。'],
      ['partError.hole.planarLocations', {}, '面内X・Yには1つ以上の有限な位置を指定してください。'],
      ['partError.hole.faceNotTarget', {}, '穴をあける面は、加工するもとのソリッドの面にしてください。'],
      ['partError.hole.faceOnly', {}, '穴をあけられるのは面だけです。面を選び直してください。'],
      ['partError.hole.diameter', {}, '穴の直径は 0 より大きい数にしてください。'],
      ['partError.threadHole.drillDiameter', {}, '下穴の径は 0 より大きい数にしてください。'],
      ['partError.threadHole.drillTooLarge', {}, '下穴の径はねじの外径より小さくしてください。'],
      ['partError.threadHole.lengthOverDepth', {}, 'ねじ部の長さは、穴の深さ以下にしてください。'],
      ['partError.fillet.radius', {}, '丸める半径は 0 より大きい数にしてください。'],
      ['partError.chamfer.distance', {}, '面取りの距離は 0 より大きい数にしてください。'],
      ['partError.chamfer.angle', {}, '面取りの角度は 0 度より大きく 90 度より小さくしてください。'],
      ['partError.threadHole.unknownSize', {}, 'そのねじの呼びは使えません。一覧から選び直してください。'],
      ['partError.threadHole.pitch', {}, 'ねじのピッチは 0 より大きい数にしてください。'],
      ['partError.threadHole.length', {}, 'ねじ部の長さは 0 より大きい数にしてください。'],
      ['partError.machining.missingSubShape', {}, '加工するもとの面(辺)が見つかりません。形が大きく変わったため、選び直してください。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移したスケッチの面の穴・線のずらし・座標の解決・3D スケッチの断りの誤りの文は、移す前の model の文と 1 文字も違わない(0b3c-sketch-error-keys-1)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.sketchFaceHole.touchesHole', { label: '穴2' }, '穴2が別の穴に接するか交差しています。輪郭を離してください。'],
      ['partError.sketchFaceHole.holeSideUnknown', { label: '穴2' }, '穴2と別の穴の内外を判定できません。輪郭を確認してください。'],
      ['partError.sketchFaceHole.nested', { label: '穴2' }, '穴2が別の穴と重なっています。穴を入れ子にしないでください。'],
      ['partError.sketchFaceHole.outerPlaneUnknown', {}, '穴を置く外周の平面が決まりません。'],
      ['partError.sketchFaceHole.notSamePlane', { label: '穴2' }, '穴2が外周と同じ平面にありません。'],
      ['partError.sketchFaceHole.touchesOuter', { label: '穴2' }, '穴2が外周に接するか交差しています。輪郭を離してください。'],
      ['partError.sketchFaceHole.outerSideUnknown', { label: '穴2' }, '穴2が外周の内側にあるか判定できません。輪郭を確認してください。'],
      ['partError.sketchFaceHole.outsideOuter', { label: '穴2' }, '穴2が外周の外にはみ出しています。'],
      ['partError.sketchOffset.noSelection', {}, 'ずらす線・円弧が選ばれていません。'],
      ['partError.sketchOffset.missingSource', { id: 'line-1' }, 'ずらすもとの線が見つかりません: line-1'],
      ['partError.sketchOffset.missingSourceIndex', { index: '3', id: 'line-1' }, 'ずらすもとの線が見つかりません: line-1#3'],
      ['partError.sketchOffset.degenerateDirection', {}, 'ずらすもとの線の向きが定まりません。'],
      ['partError.sketchOffset.notClosed', {}, '選んだ線・円弧の端がつながっていません。'],
      ['partError.sketchOffset.distance', {}, 'ずらす距離は 0 以上の数で指定してください。'],
      ['partError.sketchOffset.emptyResult', {}, 'ずらした結果が空になりました。'],
      ['partError.coordinate.functionPointUnresolved', {}, '関数上の点を確定できません。親の関数と既知座標を確認し、候補を選び直してください。'],
      ['partError.coordinate.noPrevious', {}, '基準になる直前の点がありません。'],
      ['partError.coordinate.pointIdClash', { id: 'point-1' }, '基準の点 point-1 がスケッチの点と部品の基準点の両方の内部の id になっています。表示の名前を変えても id は変わらないので、スケッチの点を消してから「基準点に点を置く」で置き直してください(新しい点には別の id が付きます)。'],
      ['partError.coordinate.missingPoint', { id: 'point-99' }, '基準の点が見つかりません: point-99'],
      ['partError.coordinate.missingVertex', { id: 'line-1' }, '基準の端点が見つかりません: line-1'],
      ['partError.coordinate.missingSubShape', {}, '基準にするソリッドの形が見つかりません。形が大きく変わったため、選び直してください。'],
      ['partError.coordinate.notFinite', { label: '緯度' }, '緯度の値が数になっていません。'],
      ['partError.coordinate.polarNeedsPlane', {}, '3D スケッチでは角度と距離での指定は使えません。座標かずれで指定してください。'],
      ['partError.sketchState.needsWorkPlane', { label: 'オフセット' }, '3D スケッチではオフセットを作れません。作図面を選んでから作ってください。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移した面の縫い合わせ・ばねの誤りの文は、移す前の model の文と 1 文字も違わない(0b3c-sewspring)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.sew.mixedFaces', {}, 'スケッチの面とソリッド・曲面の面は一緒に縫い合わせられません。'],
      ['solidFailure.sewFaces.insufficientFaces', {}, 'ソリッドにするには面が 2 枚以上必要です。'],
      ['partError.sew.reselectFaces', {}, '縫い合わせる面を選び直してください。'],
      ['partError.sew.tolerance', {}, 'つなぎ目の許容量は 0 より大きい数にしてください。'],
      ['partError.sew.missingProfile', {}, '縫い合わせるもとの面が見つかりません。スケッチで面を張ってからやり直してください。'],
      ['partError.sew.withHoles', {}, '穴つきの面は縫合に対応していません。穴のない面を選んでください。'],
      ['partError.spring.missingStart', {}, 'ばねの始点にする点が見つかりません。スケッチで点を作ってからやり直してください。'],
      ['partError.spring.missingAxis', {}, 'ばねの軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。'],
      ['partError.spring.coilDiameter', {}, 'コイル径は 0 より大きい数にしてください。'],
      ['partError.spring.wireDiameter', {}, '線径は 0 より大きい数にしてください。'],
      ['springError.wireTooThick', {}, '線径はコイル径より小さくしてください。'],
      ['partError.spring.turns', {}, '巻数は 0 より大きく 200 以下にしてください。'],
      ['springError.pitchTooSmall', {}, 'ピッチは線径より大きくしてください。隣どうしの線がぶつかります。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移したスケッチの複製・鏡・並べの断りの誤りの文は、移す前の model の文と 1 文字も違わない(0b3c-sketch-error-keys-copymath)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.sketchCopy.noSelection', {}, '複製するもとの要素が選ばれていません。'],
      ['partError.sketchCopy.missingElement', { id: 'line-1#2' }, '複製するもとの要素が見つかりません: line-1#2'],
      ['partError.sketchCopy.missingPoint', { id: 'line-1#2' }, '複製するもとの点が見つかりません: line-1#2'],
      ['partError.sketchCopy.mixed', {}, '点と線を混ぜて複製することはできません。'],
      ['partError.sketchCopy.count', { min: '2', max: '100' }, '並べる個数は 2 以上 100 以下の整数にしてください。'],
      ['partError.sketchMirror.missingPlane', { id: 'plane-1' }, '鏡にする平面が見つかりません: plane-1'],
      ['partError.sketchMirror.lineAxisIn3d', {}, '3D スケッチでは線を軸にした鏡像は作れません。鏡にする平面を選んでください。'],
      ['partError.sketchMirror.missingAxis', { id: 'line-1#2' }, '鏡にする軸の線が見つかりません: line-1#2'],
      ['partError.sketchMirror.axisNotLine', {}, '鏡にできるのは線分だけです。まっすぐな線を選んでください。'],
      ['partError.sketchMirror.axisDirection', {}, '鏡にする軸の向きが定まりません。'],
      ['partError.sketchPattern.zeroMove', {}, '移動量が 0 です。動かす向きと距離を入れてください。'],
      ['partError.sketchPattern.direction', {}, '並べる向きが定まりません。'],
      ['partError.sketchPattern.spacing', {}, '並べる間隔は 0 より大きい数にしてください。'],
      ['partError.sketchPattern.circularIn3d', {}, '3D スケッチでは円形に並べられません。作図面を選んでから作ってください。'],
      ['partError.sketchPattern.angle', {}, '並べる角度は 0 より大きく 360 以下にしてください。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移したスケッチの矩形・長穴・点列・グリッド・3D の円弧・作図面・線分・円弧の誤りの文は、移す前の model の文と 1 文字も違わない(0b3c-sketch-error-keys-sketcharray)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.sketchRect.zeroSize', {}, '矩形の幅・高さが 0 です。'],
      ['partError.sketchSlot.sameCenters', {}, '長穴の 2 つの中心が同じ位置です。'],
      ['partError.sketchSlot.tooNarrow', {}, '長穴の幅が小さすぎます。'],
      ['partError.sketchPointArray.count', { min: '1', max: '1000' }, '個数は 1 以上 1000 以下の整数にしてください。'],
      ['partError.sketchPointArray.zeroSpacing', {}, '間隔に 0 は指定できません。'],
      ['partError.sketchPointArray.angleNotNumber', {}, '方向の角度が数になっていません。'],
      ['partError.sketchShape.radiusPositive', {}, '半径は 0 より大きい必要があります。'],
      ['partError.sketchPointArray.radiusTooSmall', {}, '半径が小さすぎて点列になりません。'],
      ['partError.sketchGrid.axisCount', { label: '行' }, '行の個数は 1 以上の整数にしてください。'],
      ['partError.sketchGrid.totalCount', { max: '1000' }, '点の合計数は 1000 個以下にしてください。'],
      ['partError.sketchGrid.rowSpacing', {}, '行の間隔に 0 は指定できません。'],
      ['partError.sketchGrid.colSpacing', {}, '列の間隔に 0 は指定できません。'],
      ['partError.sketchArc3d.needsOrientation', {}, '3D スケッチの円弧には向きの指定が必要です。法線と角度 0 の向きを決めてください。'],
      ['partError.sketchArc3d.zeroNormal', {}, '円弧の向き(法線)の長さが 0 です。'],
      ['partError.sketchArc3d.parallelReference', {}, '角度 0 の向きが法線と平行です。法線と違う向きを指定してください。'],
      ['partError.sketchPlane.missing', { id: 'referencePlane-9' }, '作図面が見つかりません: referencePlane-9'],
      ['partError.sketchLine.zeroLength', {}, '線分の長さが 0 です。'],
      ['partError.sketchArc.radiusTooSmall', {}, '半径が小さすぎて円弧になりません。'],
      ['partError.sketchShape.angleNotNumber', {}, '角度の値が数になっていません。'],
      ['partError.sketchShape.sameAngles', {}, '開始角と終了角が同じです。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移したロフトと罫線面・鏡・移動と回転と拡大・並べ・読み込んだ形の誤りの文は、移す前の model の文と 1 文字も違わない(0b3c-loftmirror)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.thruSections.tooFew', {}, 'つなぐ面を 2 つ選んでください。'],
      ['partError.thruSections.missingFace', {}, 'つなぐもとの面が見つかりません。スケッチで面を張ってからやり直してください。'],
      ['partError.thruSections.missingSphere', {}, 'つなぐもとの球が見つかりません。球を選び直してください。'],
      ['partError.thruSections.twoSpheres', {}, '球どうしを直線でつなぐことはできません。'],
      ['partError.thruSections.twistNotInteger', {}, 'ねじれの補正は整数にしてください。'],
      ['partError.thruSections.notFace', {}, '輪郭にできるのはソリッドの面だけです。面を選び直してください。'],
      ['partError.thruSections.missingBody', {}, 'つなぐもとのソリッドが見つかりません。ソリッドを選び直してください。'],
      ['partError.mirror.missingBody', {}, '鏡に映すもとのソリッドが見つかりません。ソリッドを選び直してください。'],
      ['partError.mirror.missingPlane', {}, '鏡にする平面が見つかりません。平面を選び直してください。'],
      ['partError.mirror.notFace', {}, '鏡にできるのはソリッドの平らな面だけです。面を選び直してください。'],
      ['partError.mirror.notFlat', {}, '鏡にできるのは平らな面だけです。平らな面を選び直してください。'],
      ['partError.scale.missingOrigin', {}, '拡大縮小の中心にする点が見つかりません。点を選び直してください。'],
      ['partError.pattern.missingSource', {}, '並べるもとのソリッドが見つかりません。'],
      ['partError.pattern.invalidSource', {}, '並べる立体、穴・ねじ穴・リブ、または作成行と対になった結合・切り抜きの行を選び直してください。'],
      ['partError.pattern.missingTarget', {}, '結合・切り抜きの相手のソリッドが見つかりません。'],
      ['partError.pattern.missingTool', {}, '並べる工具のソリッドが見つかりません。'],
      ['partError.pattern.selfReference', {}, '並べる対象の参照が自分自身へ戻っています。'],
      ['partError.thruSections.withHoles', {}, '穴つきの面はロフト・罫線面に対応していません。穴のない断面を選んでください。'],
      ['partError.transform.moveNotNumber', {}, '移動の量は数にしてください。'],
      ['partError.transform.angleNotNumber', {}, '回転の角度が数になっていません。'],
      ['partError.importedSolid.missing', {}, '読み込んだ形が見つかりません。ファイルを読み込み直してください。'],
      ['loftError.sphere', {}, 'ロフトには球を使えません。「面をつなぐ」を使ってください。'],
      ['ruledError.sphereOrigin', {}, '中心をソリッドの頂点で決めた球は、まだ面をつなぐ相手にできません。球の中心を座標かスケッチの点で決めてください。'],
      ['partError.revolve.missingAxis', {}, '回転の軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移した書き出しの定数 5 つ(球・緯度・3D スケッチの拘束・解けない拘束・読み込んだ三角形の形)の文は、移す前の model の文と 1 文字も違わない(0b-xc)', () => {
    // 右の文は、道具が移す前の model の定数(MISSING_SPHERE_MESSAGE など)の文字から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['partError.coordinate.missingSphere', {}, '球が見つかりません。球を選び直してください。'],
      ['partError.coordinate.latitudeRange', {}, '緯度は −90 度から 90 度の間で指定してください。'],
      ['partError.sketchConstraint.freeSketch', {}, '3D スケッチには拘束を付けられません。作図面の上のスケッチで使ってください。'],
      ['partError.sketchConstraint.unsolved', {}, '拘束を満たす形が見つかりませんでした。拘束をいくつか外して試してください。'],
      ['partError.importedMesh.notMachinable', {}, '読み込んだ三角形の形には、穴あけや面取りはできません。'],
    ];
    expect(cases.map(([key, parameters]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters } })))
      .toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移した押し出し・回転・結合と切り抜き・基本形状の誤りの文は、移す前の model の文と 1 文字も違わない(0b-3b)', () => {
    // 右の文は、道具が移す前の model の文字(resolvePart.ts の定数と呼び出しの文字)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, string])[] = [
    ['partError.extrude.toFaceMissing', '押し出す先の面が見つかりません。形が大きく変わったため、選び直してください。'],
    ['partError.extrude.toFaceNotFlat', '押し出す先にできるのは平らな面だけです。面を選び直してください。'],
    ['partError.extrude.toFaceParallel', '押し出す向きと面が平行です。別の面を選ぶか、押し出す向きを変えてください。'],
    ['partError.extrude.toFaceBehind', '押し出す向きの先に面がありません。向きを反転するか、別の面を選んでください。'],
    ['partError.extrude.toNextMissing', '押し出す先にソリッドがありません。'],
    ['partError.extrude.throughTargetMissing', '貫いて切る対象のソリッドが見つかりません。切るソリッドを選び直してください。'],
    ['partError.extrude.throughTargetConsumed', '貫いて切る対象のソリッドは、すでに別のところで使われています。切るソリッドを選び直してください。'],
    ['partError.boolean.profileCutPair', '対になっている切断には、同じソリッドと輪郭、反対の残す側が必要です。'],
    ['partError.primitive.missingPoint', '中心にする点が見つかりません。点を選び直してください。'],
    ['partError.primitive.originNotVertex', '中心にできるのはソリッドの頂点だけです。頂点を選び直してください。'],
    ['partError.primitive.missingVertex', '中心にする頂点が見つかりません。形が大きく変わったため、選び直してください。'],
    ['partError.primitive.missingAxis', '向きにする線分が見つかりません。スケッチで線分をかいてから選び直してください。'],
    ['partError.extrude.missingProfile', '押し出すもとの面が見つかりません。スケッチで面を張ってからやり直してください。'],
    ['partError.extrude.distance', '押し出す長さは 0 より大きい数にしてください。'],
    ['partError.extrude.notPlanar', '押し出す向きが決まりません。面の形が平らになっているか確かめてください。'],
    ['partError.extrude.thinWithHoles', '穴つきの面は薄板の押し出しに対応していません。中実の押し出しを選んでください。'],
    ['partError.extrude.taper', '側面の傾きは 0 以上 60 度以下にしてください。'],
    ['partError.extrude.thinWall', '壁の厚みは 0 より大きい数にしてください。'],
    ['partError.revolve.missingProfile', '回転させるもとの面が見つかりません。スケッチで面を張ってからやり直してください。'],
    ['partError.revolve.withHoles', '穴つきの面は回転に対応していません。穴のない面を選んでください。'],
    ['partError.revolve.missingAxis', '回転の軸にする線分が見つかりません。スケッチで線分をかいてから選び直してください。'],
    ['partError.boolean.sameBody', '同じソリッドどうしは組み合わせられません。別のソリッドを選んでください。'],
    ['partError.boolean.missingBody', '組み合わせるもとのソリッドが見つかりません。'],
    ['partError.machining.missingBody', '加工するもとのソリッドが見つかりません。'],
    ['partError.revolve.angle', '回転の角度は 0 より大きく 360 以下にしてください。'],
    ['partError.body.consumedTwice', 'そのソリッドはすでに別のところで使われています。'],
    ];
    expect(cases.map(([key]) => partErrorMessage({ featureId: 'f', code: 'invalidValue', text: { key, parameters: {} } })))
      .toEqual(cases.map(([, before]) => before));
  });

  it('鍵へ移した部品とスケッチの誤りの文は、移す前の model の文と 1 文字も違わない(0b-3a)', () => {
    const reason = plainText('投影のもとになるソリッドが見つかりません。');
    const cases: readonly (readonly [PartRecomputeError, string])[] = [
      [{ featureId: 'part', code: 'invalidValue', text: { key: 'partError.mathUnavailable', parameters: {} } },
        '数学計算部を準備できません。数式の再計算後に作図してください。'],
      [{ featureId: 'pj1', code: 'circularReference', text: { key: 'partError.circularDependency', parameters: { ids: ['pj1', 'pj2'].join('、') } } },
        `参照・投影の依存が循環しています: ${['pj1', 'pj2'].join('、')}`],
      [{ featureId: 'pj1', code: 'missingBody', text: { key: 'partError.dependencyStopped', parameters: { id: 'pj1', reason: '' } } },
        '参照・投影の依存を解決できず、再計算を停止しました: pj1'],
      [{ featureId: 'pj1', code: 'missingBody', text: { key: 'partError.dependencyStopped',
        parameters: { id: 'pj1', reason: { key: 'partError.followingReason', parameters: { reason } } } } },
        '参照・投影の依存を解決できず、再計算を停止しました: pj1' + '。投影のもとになるソリッドが見つかりません。'],
      [{ featureId: 'e1', code: 'missingSubShape', text: { key: 'partError.reselectionStopped', parameters: { id: 'e1' } } },
        '部分形状の選び直しが収束せず、再計算を停止しました: e1'],
      [{ featureId: 'face', code: 'notClosed', text: { key: 'partError.numberedHole', parameters: { index: String(1 + 1), text: plainText('輪郭が閉じていません。') } } },
        `穴${String(1 + 1)}: 輪郭が閉じていません。`],
      [{ featureId: 'f', code: 'kernelFailed', text: plainText('面を作れませんでした: {text} を含む計算部の文') },
        '面を作れませんでした: {text} を含む計算部の文'],
    ];
    expect(cases.map(([error]) => partErrorMessage(error))).toEqual(cases.map(([, before]) => before));
  });
});
