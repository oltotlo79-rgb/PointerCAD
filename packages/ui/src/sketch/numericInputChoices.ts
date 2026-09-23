/** 道具の段に出す選択肢と既定値。計算・入力遷移・文書更新は持たない。 */
import {
  DEFAULT_EXTRUDE_END,
  DEFAULT_HOLE_ENTRY,
  DEFAULT_MIRROR_PLANE_ID,
  DEFAULT_RIB_SIDE,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  DEFAULT_THICKNESS_SIDE,
  DEFAULT_THREAD_DESIGNATION,
  DEFAULT_THREAD_SHAFT_FROM_END,
  METRIC_THREAD_DESIGNATIONS,
  RULED_SPHERE_SEGMENT_CHOICES,
  type RuledSphereSegments,
  type SketchLineRef,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { NumericChoice, NumericChoiceOption, NumericInputOptions, RevolveAxisChoice } from './numericInput.js';
import type { NumericInputStep } from './numericInputTools.js';

/**
 * なめらかさ(球へつなぐときの接点の数、§0.a-0.74)の選択肢。
 *
 * 値は model の `RULED_SPHERE_SEGMENT_CHOICES`(= カーネルの `SphereSegmentCount`)から
 * 組み立てるので、選べる数の正本は 1 か所しかない。見出しだけをここで日本語に付け替える
 * (24 / 48 / 72 という数そのものは利用者にとって意味が無く、「どれくらい細かいか」だけが
 * 伝わればよい。24b の文言案、docs/報告記録.md 2026-09-05 17:23)。
 */
const RULED_SPHERE_SEGMENT_LABEL_KEYS: Readonly<Record<RuledSphereSegments, MessageKey>> = {
  24: 'numericInput.choice.ruledSphereSegments24',
  48: 'numericInput.choice.ruledSphereSegments48',
  72: 'numericInput.choice.ruledSphereSegments72',
};

function ruledSphereSegmentsChoice(): NumericChoice {
  return {
    key: 'ruledSphereSegments',
    labelKey: 'numericInput.choice.ruledSphereSegments',
    value: String(DEFAULT_RULED_SPHERE_SEGMENTS),
    options: RULED_SPHERE_SEGMENT_CHOICES.map((count) => ({
      value: String(count),
      labelKey: RULED_SPHERE_SEGMENT_LABEL_KEYS[count],
    })),
  };
}

/** ワールドの X / Y / Z 軸(+選んだ線分)の選択肢。回転軸・円形パターン・ばねの軸で共用する。 */
const WORLD_AXIS_OPTIONS: readonly NumericChoiceOption[] = [
  { value: 'x', labelKey: 'numericInput.axis.x' },
  { value: 'y', labelKey: 'numericInput.axis.y' },
  { value: 'z', labelKey: 'numericInput.axis.z' },
];

/** 選んだ線分を軸にする選択肢の見出し(P2 タスク21 で専用のキーを追加した)。 */
const AXIS_LINE_LABEL_KEY: MessageKey = 'numericInput.axis.line';

function axisLikeOptions(axisLine: SketchLineRef | undefined): readonly NumericChoiceOption[] {
  return axisLine === undefined
    ? WORLD_AXIS_OPTIONS
    : [...WORLD_AXIS_OPTIONS, { value: 'line', labelKey: AXIS_LINE_LABEL_KEY }];
}

/** 回転軸の既定(§0.a-0.9)。XY 面にかいた断面を Z 軸まわりに回すのが最も多い。 */
export const DEFAULT_REVOLVE_AXIS: RevolveAxisChoice = 'z';

/** 回転・円形パターン・ばねの軸(見出しは「回転軸」で共用、§2.11)。 */
function axisChoice(axisLine: SketchLineRef | undefined, defaultValue: string): NumericChoice {
  return {
    key: 'axis',
    labelKey: 'numericInput.axisGroupLabel',
    value: defaultValue,
    options: axisLikeOptions(axisLine),
  };
}

/** 直線パターンの向き(§0.a-0.21。既定は X)。回転軸とは別のキー・見出しにする。 */
function patternDirectionChoice(axisLine: SketchLineRef | undefined): NumericChoice {
  return {
    key: 'patternDirection',
    labelKey: 'numericInput.choice.patternDirection',
    value: 'x',
    options: axisLikeOptions(axisLine),
  };
}

/** ねじ穴の呼び(M2〜M64)。ラベルは METRIC_THREAD_DESIGNATIONS の文字をそのまま使う(§2.11)。 */
function threadDesignationChoice(): NumericChoice {
  return {
    key: 'threadDesignation',
    labelKey: 'numericInput.choice.threadDesignation',
    value: DEFAULT_THREAD_DESIGNATION,
    options: METRIC_THREAD_DESIGNATIONS.map((designation) => ({ value: designation, label: designation })),
  };
}

/** ねじの系列(並目/細目)。既定は並目。 */
function threadSeriesChoice(): NumericChoice {
  return {
    key: 'threadSeries',
    labelKey: 'numericInput.choice.threadSeries',
    value: 'coarse',
    options: [
      { value: 'coarse', labelKey: 'numericInput.threadSeries.coarse' },
      { value: 'fine', labelKey: 'numericInput.threadSeries.fine' },
    ],
  };
}

/** C面取りの決め方。既定は距離(等距離)。 */
function chamferModeChoice(): NumericChoice {
  return {
    key: 'chamferMode',
    labelKey: 'numericInput.choice.chamferMode',
    value: 'equal',
    options: [
      { value: 'equal', labelKey: 'numericInput.chamferMode.equal' },
      { value: 'twoDistances', labelKey: 'numericInput.chamferMode.twoDistances' },
      { value: 'distanceAngle', labelKey: 'numericInput.chamferMode.distanceAngle' },
    ],
  };
}

/** ばねの巻き方向。既定は右巻き(§0.a-0.33)。 */
function springHandednessChoice(): NumericChoice {
  return {
    key: 'springHandedness',
    labelKey: 'numericInput.choice.springHandedness',
    value: 'right',
    options: [
      { value: 'right', labelKey: 'numericInput.springHandedness.right' },
      { value: 'left', labelKey: 'numericInput.springHandedness.left' },
    ],
  };
}

/** ばねの求める値(全長/ピッチ/巻数)。既定は全長(§0.a-0.30)。 */
function springDerivedChoice(): NumericChoice {
  return {
    key: 'springDerived',
    labelKey: 'numericInput.choice.springDerived',
    value: 'length',
    options: [
      { value: 'length', labelKey: 'numericInput.springDerived.length' },
      { value: 'pitch', labelKey: 'numericInput.springDerived.pitch' },
      { value: 'turns', labelKey: 'numericInput.springDerived.turns' },
    ],
  };
}

/**
 * 正多角形の半径の測り方(FR-315)。既定は外接(頂点を通る)。
 * 計画書タスク12 が「UI の既定値は 'circumscribed'(FR-315 の主要な指定方法)」と決めている。
 */
function polygonRadiusModeChoice(): NumericChoice {
  return {
    key: 'polygonRadiusMode',
    labelKey: 'numericInput.choice.polygonRadiusMode',
    value: 'circumscribed',
    options: [
      { value: 'circumscribed', labelKey: 'numericInput.polygonRadiusMode.circumscribed' },
      { value: 'inscribed', labelKey: 'numericInput.polygonRadiusMode.inscribed' },
    ],
  };
}

/** 点列の並べ方(FR-327)。既定は直線(P1 からの振る舞いをそのまま既定にする)。 */
function pointArrayLayoutChoice(): NumericChoice {
  return {
    key: 'pointArrayLayout',
    labelKey: 'numericInput.choice.pointArrayLayout',
    value: 'linear',
    options: [
      { value: 'linear', labelKey: 'numericInput.pointArrayLayout.linear' },
      { value: 'circular', labelKey: 'numericInput.pointArrayLayout.circular' },
      { value: 'grid', labelKey: 'numericInput.pointArrayLayout.grid' },
    ],
  };
}

/** スプラインの点の使い方(FR-317)。既定は通過点(指定した点を必ず通る)。 */
function splineModeChoice(): NumericChoice {
  return {
    key: 'splineMode',
    labelKey: 'numericInput.choice.splineMode',
    value: 'interpolate',
    options: [
      { value: 'interpolate', labelKey: 'numericInput.splineMode.interpolate' },
      { value: 'control', labelKey: 'numericInput.splineMode.control' },
    ],
  };
}

/**
 * 2 点+半径の円弧のふくらむ向き(FR-326)。1 点目から 2 点目へ進む向きに対して
 * 左右どちらへふくらむかで、2 つある中心のどちらを採るかが決まる(§0.a-0.18)。
 * どちらを選んでも短い方の弧(劣弧)になるので、既定は左でよい(NFR-UX-4)。
 */
function arcBulgeChoice(): NumericChoice {
  return {
    key: 'arcBulge',
    labelKey: 'numericInput.choice.arcBulge',
    value: 'left',
    options: [
      { value: 'left', labelKey: 'numericInput.arcBulge.left' },
      { value: 'right', labelKey: 'numericInput.arcBulge.right' },
    ],
  };
}

/* ---- P4 タスク21: 編集(オフセット)の選択肢(FR-321) ---- */

/**
 * オフセットのどちら側か(FR-321)。**値は常に `outside` / `inside`**(model の `OffsetSide`)
 * だが、見出しは閉じた輪郭なら「外/内」、開いた曲線なら「左/右」に替える
 * (`types.ts` の `OffsetSide` の注釈、開いた曲線は「進む向きから見た左が outside」)。
 * どちらへずらしても結果は見えるので、既定は外側(左)でよい(NFR-UX-4)。
 */
function offsetSideChoice(open: boolean): NumericChoice {
  return {
    key: 'offsetSide',
    labelKey: 'numericInput.choice.offsetSide',
    value: 'outside',
    options: open
      ? [
          { value: 'outside', labelKey: 'numericInput.offsetSide.left' },
          { value: 'inside', labelKey: 'numericInput.offsetSide.right' },
        ]
      : [
          { value: 'outside', labelKey: 'numericInput.offsetSide.outside' },
          { value: 'inside', labelKey: 'numericInput.offsetSide.inside' },
        ],
  };
}

/** オフセットの角の作り方(FR-321)。既定は丸め(NFR-UX-4、角のとがりを避ける方が安全)。 */
function offsetCornerChoice(): NumericChoice {
  return {
    key: 'offsetCorner',
    labelKey: 'numericInput.choice.offsetCorner',
    value: 'round',
    options: [
      { value: 'round', labelKey: 'numericInput.offsetCorner.round' },
      { value: 'sharp', labelKey: 'numericInput.offsetCorner.sharp' },
    ],
  };
}

/* ---- P4 タスク24: ミラーの選択肢(FR-324) ---- */

/**
 * ミラーで鏡にできるものの一覧(P4 タスク24)。ツールバーが選択と作図面から見込んで渡す
 * (`copyCommands.ts` の `mirrorAxisAvailability`)。渡されなければ「作図面の軸が使える」
 * として扱う(基準の 3 面の上でかいているのが普通のため)。
 */
export interface MirrorAxisOptions {
  /** 作図面の横軸・縦軸で折り返せるか。基準の 3 面(XY・XZ・YZ)のときだけ真。 */
  readonly planeAxes: boolean;
  /** 選択の中に、鏡にできる線分があるか。 */
  readonly selectedLine: boolean;
}

/** 何も渡されなかったときの見込み。基準の 3 面の上でかいている前提。 */
const DEFAULT_MIRROR_AXES: MirrorAxisOptions = { planeAxes: true, selectedLine: false };

/**
 * 鏡にするもの(FR-324)。
 *
 * 見出しを「作図面の X 軸 / Y 軸」ではなく「横軸 / 縦軸」にしてある。XZ 面の縦向きの軸は Z、
 * YZ 面の横向きの軸は Y なので、「Y 軸」と書くと作図面によっては嘘になるため(統括の指示
 * との違いとして報告する)。ヘルプでは「XY 面なら X 軸」と言い添える。
 */
function mirrorBasisChoice(axes: MirrorAxisOptions): NumericChoice {
  const options: NumericChoiceOption[] = [];
  if (axes.planeAxes) {
    options.push(
      { value: 'axisU', labelKey: 'numericInput.mirrorBasis.axisU' },
      { value: 'axisV', labelKey: 'numericInput.mirrorBasis.axisV' },
    );
  }
  if (axes.selectedLine) {
    options.push({ value: 'line', labelKey: 'numericInput.mirrorBasis.line' });
  }
  return {
    key: 'mirrorBasis',
    labelKey: 'numericInput.choice.mirrorBasis',
    // 使えるものの先頭を既定にする(押せない選択肢を初期値にしない、NFR-UX-5)。
    value: options[0]?.value ?? 'axisU',
    options,
  };
}

/* ---- P4 タスク13: 基準ジオメトリの選択肢(FR-328、FR-329) ---- */

/** 選択肢の値で「文書にある基準軸」を指すときの頭(`reference:基準軸-1` の形)。 */
export const REFERENCE_AXIS_VALUE_PREFIX = 'reference:';

/** ポップアップの軸の選択肢に並べる、文書にある基準軸(FR-329)。 */
export interface ReferenceAxisOption {
  readonly id: string;
  /** ツリーに出るのと同じ名前。ja.json に置けないので札の文字をそのまま使う。 */
  readonly name: string;
}

/**
 * 軸の選択肢。ワールドの X / Y / Z に、文書にある基準軸を足す(FR-329)。
 * 基準軸の名前は利用者が付け替えられるので `labelKey` ではなく `label` に入れる
 * (ねじの呼び径と同じ扱い、§2.11「手順3」)。
 */
function referenceAxisOptions(
  axes: readonly ReferenceAxisOption[] | undefined,
): readonly NumericChoiceOption[] {
  const named = (axes ?? []).map((axis) => ({
    value: `${REFERENCE_AXIS_VALUE_PREFIX}${axis.id}`,
    label: axis.name,
  }));
  return [...WORLD_AXIS_OPTIONS, ...named];
}

function referenceAxisChoice(
  key: 'referenceAxisSpec' | 'referenceCsXAxis' | 'referenceCsYAxis',
  labelKey: MessageKey,
  defaultValue: string,
  axes: readonly ReferenceAxisOption[] | undefined,
): NumericChoice {
  return { key, labelKey, value: defaultValue, options: referenceAxisOptions(axes) };
}

/**
 * オフセットのもとにする面(FR-328)。既定は「いまの作図面」で、Enter を続けて押すだけで
 * いま描いている面から離れた平面ができる(NFR-UX-4)。「選んだ面」は立体の平らな面を
 * 選んでいないときは確定で断る(NFR-UX-5。選択の有無で選択肢を出し分けると、
 * 選び直すたびに欄の並びが変わって落ち着かないため)。
 */
function referencePlaneBaseChoice(): NumericChoice {
  return {
    key: 'referencePlaneBase',
    labelKey: 'numericInput.choice.referencePlaneBase',
    value: 'current',
    options: [
      { value: 'current', labelKey: 'numericInput.referencePlaneBase.current' },
      { value: 'xy', labelKey: 'toolbar.plane.xy' },
      { value: 'xz', labelKey: 'toolbar.plane.xz' },
      { value: 'yz', labelKey: 'toolbar.plane.yz' },
      { value: 'face', labelKey: 'numericInput.referencePlaneBase.face' },
    ],
  };
}

/** 点を通る平面の決め方(FR-328)。既定は「辺に垂直」。 */
function referencePlaneThroughModeChoice(): NumericChoice {
  return {
    key: 'referencePlaneThroughMode',
    labelKey: 'numericInput.choice.referencePlaneThroughMode',
    value: 'perpendicularEdge',
    options: [
      { value: 'perpendicularEdge', labelKey: 'numericInput.referencePlaneThrough.perpendicularEdge' },
      { value: 'containingEdge', labelKey: 'numericInput.referencePlaneThrough.containingEdge' },
      { value: 'parallelFace', labelKey: 'numericInput.referencePlaneThrough.parallelFace' },
      { value: 'axis', labelKey: 'numericInput.referencePlaneThrough.axis' },
    ],
  };
}

/** 基準軸の決め方(FR-329)。既定は 2 点(何も選んでいなくても作れる)。 */
function referenceAxisKindChoice(): NumericChoice {
  return {
    key: 'referenceAxisKind',
    labelKey: 'numericInput.choice.referenceAxisKind',
    value: 'twoPoints',
    options: [
      { value: 'twoPoints', labelKey: 'numericInput.referenceAxisKind.twoPoints' },
      { value: 'edge', labelKey: 'numericInput.referenceAxisKind.edge' },
      { value: 'faceNormal', labelKey: 'numericInput.referenceAxisKind.faceNormal' },
      { value: 'faceIntersection', labelKey: 'numericInput.referenceAxisKind.faceIntersection' },
    ],
  };
}

/** 基準点の決め方(FR-329)。既定は座標(何も選んでいなくても作れる)。 */
function referencePointKindChoice(): NumericChoice {
  return {
    key: 'referencePointKind',
    labelKey: 'numericInput.choice.referencePointKind',
    value: 'coordinate',
    options: [
      { value: 'coordinate', labelKey: 'numericInput.referencePointKind.coordinate' },
      { value: 'vertex', labelKey: 'numericInput.referencePointKind.vertex' },
      { value: 'edgeMidpoint', labelKey: 'numericInput.referencePointKind.edgeMidpoint' },
      { value: 'faceCenter', labelKey: 'numericInput.referencePointKind.faceCenter' },
    ],
  };
}

/* ---- P4 タスク23: スケッチの角の面取りの選択肢(FR-323) ---- */

/**
 * スケッチの角の面取りの決め方(FR-323)。既定は等距離(Enter 連打で正方形の切り落とし、
 * NFR-UX-4)。選択肢の鍵と見出しは立体の C 面取り(`chamferModeChoice`)と同じものを使い、
 * 「距離と角度」だけを外す(`SKETCH_CHAMFER_FIELDS` の注釈)。
 */
function sketchChamferModeChoice(): NumericChoice {
  return {
    key: 'chamferMode',
    labelKey: 'numericInput.choice.chamferMode',
    value: 'equal',
    options: [
      { value: 'equal', labelKey: 'numericInput.chamferMode.equal' },
      { value: 'twoDistances', labelKey: 'numericInput.chamferMode.twoDistances' },
    ],
  };
}

/* ---- P5 タスク49: Should / Could 群の選択肢(§2.15 の段の表) ---- */

/*
  既定はすべて model の定数から引く(同じ値を 2 か所に書かない)。model に定数の無い
  2 つ(曲面の作り方・切断面の決め方)だけ、ここで「何も選ばなくても意味のある形になる」
  ものを既定にした(NFR-UX-4)。統括へ報告する判断点。
*/

/** 押し出しの終わり方(FR-415)。既定は model の `DEFAULT_EXTRUDE_END`(= 距離)。 */
function extrudeEndChoice(): NumericChoice {
  return {
    key: 'extrudeEnd',
    labelKey: 'numericInput.choice.extrudeEnd',
    value: DEFAULT_EXTRUDE_END.kind,
    options: [
      { value: 'distance', labelKey: 'numericInput.extrudeEnd.distance' },
      { value: 'toFace', labelKey: 'numericInput.extrudeEnd.toFace' },
      { value: 'toNext', labelKey: 'numericInput.extrudeEnd.toNext' },
    ],
  };
}

/** 薄板押し出しの厚みを付ける側(FR-416)。既定は内側(輪郭が壁の外の境界になる)。 */
function thicknessSideChoice(): NumericChoice {
  return {
    key: 'thicknessSide',
    labelKey: 'numericInput.choice.thicknessSide',
    value: DEFAULT_THICKNESS_SIDE,
    options: [
      { value: 'inner', labelKey: 'numericInput.thicknessSide.inner' },
      { value: 'outer', labelKey: 'numericInput.thicknessSide.outer' },
      { value: 'both', labelKey: 'numericInput.thicknessSide.both' },
    ],
  };
}

/**
 * ミラーの鏡にする面(FR-419、§0.a-0.36)。基準の 3 面と「選んだ面」の 4 つだけで、
 * 3 点指定のような決め方は持たない(§0.a-0.36 が認めた範囲。切断とはここが違う)。
 */
function mirrorPlaneChoice(): NumericChoice {
  return {
    key: 'mirrorPlane',
    labelKey: 'numericInput.choice.mirrorPlane',
    value: DEFAULT_MIRROR_PLANE_ID,
    options: [
      { value: 'xy', labelKey: 'numericInput.mirrorPlane.xy' },
      { value: 'xz', labelKey: 'numericInput.mirrorPlane.xz' },
      { value: 'yz', labelKey: 'numericInput.mirrorPlane.yz' },
      { value: 'face', labelKey: 'numericInput.mirrorPlane.face' },
    ],
  };
}

/** リブの厚みを付ける側(FR-420)。既定は両側へ半分ずつ(輪郭が壁の中心になる)。 */
function ribSideChoice(): NumericChoice {
  return {
    key: 'ribSide',
    labelKey: 'numericInput.choice.ribSide',
    value: DEFAULT_RIB_SIDE,
    options: [
      { value: 'both', labelKey: 'numericInput.ribSide.both' },
      { value: 'positive', labelKey: 'numericInput.ribSide.positive' },
      { value: 'negative', labelKey: 'numericInput.ribSide.negative' },
    ],
  };
}

/** 穴の入口の広げ方(FR-422)。既定は広げない(欄が 0 個の段になる)。 */
function holeEntryChoice(): NumericChoice {
  return {
    key: 'holeEntry',
    labelKey: 'numericInput.choice.holeEntry',
    value: DEFAULT_HOLE_ENTRY.kind,
    options: [
      { value: 'plain', labelKey: 'numericInput.holeEntry.plain' },
      { value: 'counterbore', labelKey: 'numericInput.holeEntry.counterbore' },
      { value: 'countersink', labelKey: 'numericInput.holeEntry.countersink' },
    ],
  };
}

/** 外ねじを切り始める端(FR-423)。既定は軸のパラメータが小さいほうの端。 */
function threadShaftEndChoice(): NumericChoice {
  return {
    key: 'threadShaftEnd',
    labelKey: 'numericInput.choice.threadShaftEnd',
    value: DEFAULT_THREAD_SHAFT_FROM_END,
    options: [
      { value: 'first', labelKey: 'numericInput.threadShaftEnd.first' },
      { value: 'last', labelKey: 'numericInput.threadShaftEnd.last' },
    ],
  };
}

/**
 * 曲面の作り方(FR-428)。値は model の `SurfaceOperation` の 6 種と同じ言葉にしてある
 * (同じ操作を 2 通りの名前で呼ばないため)。model に既定の定数が無いので、ここでは
 * 「輪郭 1 本からでも作れる」押し出しを既定にする(NFR-UX-4)。
 */
function surfaceOperationChoice(): NumericChoice {
  return {
    key: 'surfaceOperation',
    labelKey: 'numericInput.choice.surfaceOperation',
    value: 'extrude',
    options: [
      { value: 'extrude', labelKey: 'numericInput.surfaceOperation.extrude' },
      { value: 'revolve', labelKey: 'numericInput.surfaceOperation.revolve' },
      { value: 'planar', labelKey: 'numericInput.surfaceOperation.planar' },
      { value: 'loft', labelKey: 'numericInput.surfaceOperation.loft' },
      { value: 'face', labelKey: 'numericInput.surfaceOperation.face' },
      { value: 'offset', labelKey: 'numericInput.surfaceOperation.offset' },
    ],
  };
}

/**
 * 切断面の決め方(FR-432、§0.a-0.56)。基準の 3 面・選んだ面・3 点・点と辺・点と軸の 7 つ。
 * 値は model の `PlaneSpec` の種類(と作業平面の id)へそのまま読み替えられる言葉にしてある。
 * 既定は XY 面——何も選ばなくても切れる唯一の決め方だから(NFR-UX-4)。
 */
function cutPlaneKindChoice(): NumericChoice {
  return {
    key: 'cutPlaneKind',
    labelKey: 'numericInput.choice.cutPlaneKind',
    value: 'xy',
    options: [
      { value: 'xy', labelKey: 'numericInput.cutPlaneKind.xy' },
      { value: 'xz', labelKey: 'numericInput.cutPlaneKind.xz' },
      { value: 'yz', labelKey: 'numericInput.cutPlaneKind.yz' },
      { value: 'face', labelKey: 'numericInput.cutPlaneKind.face' },
      { value: 'threePoints', labelKey: 'numericInput.cutPlaneKind.threePoints' },
      { value: 'pointAndEdge', labelKey: 'numericInput.cutPlaneKind.pointAndEdge' },
      { value: 'pointAndAxis', labelKey: 'numericInput.cutPlaneKind.pointAndAxis' },
    ],
  };
}

/** 段階ごとの選択肢の並び。持たない段は空配列。 */
export function choicesFor(step: NumericInputStep, options: NumericInputOptions): readonly NumericChoice[] {
  switch (step) {
    case 'sweepOptions':
      return [{ key: 'sweepGuide', labelKey: 'numericInput.choice.sweepGuide', value: 'none', presentation: 'menu',
        options: [{ value: 'none', labelKey: 'numericInput.sweepGuide.none' }, ...(options.sweepGuides ?? [])] }];
    case 'sketchChamferSize':
      return [sketchChamferModeChoice()];
    case 'offsetDistance':
      return [offsetSideChoice(options.offsetOpenContour ?? false), offsetCornerChoice()];
    case 'mirrorBasis':
      return [mirrorBasisChoice(options.mirrorAxes ?? DEFAULT_MIRROR_AXES)];
    case 'referencePlaneOffset':
      return [referencePlaneBaseChoice()];
    case 'referencePlaneTilt':
      return [
        referenceAxisChoice(
          'referenceAxisSpec',
          'numericInput.choice.referenceAxisSpec',
          'x',
          options.referenceAxes,
        ),
      ];
    case 'referencePlaneThrough':
      return [
        referencePlaneThroughModeChoice(),
        referenceAxisChoice(
          'referenceAxisSpec',
          'numericInput.choice.referenceAxisSpec',
          'z',
          options.referenceAxes,
        ),
      ];
    case 'referenceAxisKind':
      return [referenceAxisKindChoice()];
    case 'referencePointKind':
      return [referencePointKindChoice()];
    case 'referenceCsAxes':
      return [
        referenceAxisChoice(
          'referenceCsXAxis',
          'numericInput.choice.referenceCsXAxis',
          'x',
          options.referenceAxes,
        ),
        referenceAxisChoice(
          'referenceCsYAxis',
          'numericInput.choice.referenceCsYAxis',
          'y',
          options.referenceAxes,
        ),
      ];
    case 'polygonShape':
      return [polygonRadiusModeChoice()];
    case 'pointArrayShape':
      return [pointArrayLayoutChoice()];
    case 'splineShape':
      return [splineModeChoice()];
    case 'twoPointArcRadius':
      return [arcBulgeChoice()];
    case 'revolveAngle':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS)];
    case 'threadSize':
      return [threadDesignationChoice(), threadSeriesChoice()];
    case 'chamferSize':
      return [chamferModeChoice()];
    case 'linearPattern':
      return [patternDirectionChoice(options.axisLine)];
    case 'circularPattern':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS)];
    case 'springShape':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS), springHandednessChoice()];
    case 'springLength':
      return [springDerivedChoice()];
    /*
      基本形状5種の向き(§2.15 の「つまみ」列)。回転軸(FR-402)と同じ `RevolveAxis` を
      流用するので選択肢も同じもの(X / Y / Z、線分が選ばれていれば「選んだ線分」)を使う
      (§0.a-0.16「同じものを2つ作らない」)。既定は Z(model の `DEFAULT_PRIMITIVE_AXIS`)。
      球とトーラスは向きを変えても見た目が変わらないが、種類ごとに出し分けない
      (5 種で同じ欄立てにしたほうが操作の勘が働く。model 側の型も5種で共通)。
    */
    case 'sphereSize':
    case 'boxSize':
    case 'cylinderSize':
    case 'coneSize':
    case 'torusSize':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS)];
    /*
      面をつなぐ(FR-430、タスク27)の「なめらかさ」(§0.a-0.74)。
      **球を含まない断面では形に効かない**(§0.a-0.87)ので、そのときは選択肢ごと伏せる。
      効かない欄を出すと「変えたのに形が変わらない」ことになり、利用者は理由を推し量れない
      (NFR-UX-5「できないことは示す」の裏返し)。球を含むかどうかはツールバーが選択から
      見込んで `ruledHasSphere` で渡す。ロフト(`loftTwist`)には球を置けないので選択肢は無い。
    */
    case 'ruledTwist':
      return options.ruledHasSphere === true ? [ruledSphereSegmentsChoice()] : [];
    /* ---- P5 タスク49: Should / Could 群(§2.15 の段の表) ---- */
    /*
      押し出し(FR-401、FR-415、FR-416)。タスク50 で終わり方と厚みの側をここへ畳んだ。
      どちらも選択肢なので**段を開いた直後から出る**が、欄は既定(終わり方＝距離、
      薄板にする＝切)では距離 1 つのままである。
    */
    case 'extrudeDistance':
      return [extrudeEndChoice(), thicknessSideChoice()];
    case 'mirrorPlane':
      return [mirrorPlaneChoice()];
    // 回す軸は回転・円形パターン・ばねと同じ選択肢を使い回す(§0.a-0.16)。既定も同じ Z。
    case 'transformRotation':
      return [axisChoice(options.axisLine, DEFAULT_REVOLVE_AXIS)];
    case 'ribThickness':
      return [ribSideChoice()];
    // 穴(FR-405、FR-422)。タスク50 で入口の広げ方をここへ畳んだ。
    case 'holeSize':
      return [holeEntryChoice()];
    // 呼びと系列はねじ穴とまったく同じ表を使う(規格表を 2 か所に持たない、FR-406)。
    case 'threadShaftSize':
      return [threadDesignationChoice(), threadSeriesChoice(), threadShaftEndChoice()];
    case 'surfaceShape':
      return [surfaceOperationChoice()];
    case 'cutPlane':
      return [cutPlaneKindChoice()];
    default:
      return [];
  }
}
