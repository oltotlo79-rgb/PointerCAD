/** ツールバーで選べるスケッチの道具(FR-301〜309)。ストアの activeTool の型でもある。 */
export type SketchToolId = 'select' | 'point' | 'line' | 'arc' | 'pointArray' | 'face';

/**
 * 数値を聞くソリッドの道具(FR-401〜403、P3 で加工6種+ばねを追加)。
 * ブーリアン(和・差・積)は選んで押すだけで数値を聞かないので含めない(§2.11 の表)。
 */
export type SolidToolId =
  | 'extrude'
  | 'revolve'
  | 'sew'
  | 'hole'
  | 'threadHole'
  | 'fillet'
  | 'chamfer'
  | 'linearPattern'
  | 'circularPattern'
  /** ばね(FR-414)。2段で聞く(§2.11)。 */
  | 'spring'
  /*
    基本形状5種(FR-429、P5 タスク18、§2.15 の段の表)。押し出し・回転・縫合・ばねと同じ
    「新しいボディを1つ作る」道具で、対象を消費しない(§0.a-0.19)ので加工には入れない。
    **何も選ばなくても置ける**(中心の既定は原点、NFR-UX-4)ので押せない条件を持たない。
  */
  | 'sphere'
  | 'box'
  | 'cylinder'
  | 'cone'
  | 'torus'
  /**
   * 球面上の点(FR-431、P5 タスク22)。**立体ではなく 3D スケッチの点を 1 つ作る**道具だが、
   * 「球を選んでから押し、1 段だけ数値を聞いて確定する」流れが基本形状とまったく同じなので、
   * 道具の一覧・段の表・ツールバーの「作る」を基本形状と共有する(利用者から見ても
   * 球のとなりに並んでいるほうが探しやすい)。作る先だけが違うので、確定は
   * `solidCommands.ts` から `sketchCommands.ts` の `commitSphereGridPoint` へ回す。
   */
  | 'sphereGridPoint'
  /*
    面をつなぐ(罫線面、FR-430)とロフト(FR-410。P5 タスク27、§2.9)。どちらも
    「輪郭を選んでから 1 段だけ数値を聞き、新しいボディを作る」道具で、対象を消費しない
    (§0.a-0.27)。押し出し・回転と同じく**選んでから押す**道具なので、基本形状と違って
    押せない条件を持つ(`ruledCommands.ts` の `ruledToolReadiness` / `loftToolReadiness`)。
  */
  | 'ruled'
  | 'loft'
  /*
    P5 の Should / Could 群(FR-401、FR-409、FR-415〜428、FR-432。タスク49、§2.15 の段の表)。
    どれも「押すと段が 1 つ開き、確定で立体を 1 つ作る/変える」道具なのでここへ足す。
    コマンドの本体はタスク50(切断はタスク27e)で、いまは段と案内だけがある。

    **タスク50 で既存の段へ畳み直した(統括の決定 2026-09-06)**: タスク49 は
    「押し出しの終端・傾き」「薄板押し出し」「ざぐり/皿もみ」「可変半径の R 面取り」を
    独立した道具(`extrudeEnd` / `extrudeThin` / `counterbore` / `variableFillet`)に
    していたが、利用者から見て「押し出し」の 1 つの道具で終わり方・傾き・薄板を選べるのが
    自然なので、計画書 §2.15 の本来の形どおり**既存の押し出し・穴・R 面取りの段へ**
    選択肢・つまみ・欄として足した。足した欄は `visibleWhen` で伏せてあるので、**段を開いた
    ときの欄と値は P1〜P4 のときと 1 つも変わらない**(既存の検査は選択肢・つまみが増えた
    ぶんの追記だけで通る)。
  */
  /** 抜き勾配(FR-417)。 */
  | 'draft'
  /**
   * 立体のミラー(FR-419)。整形系の `mirror`(スケッチの鏡像複写、FR-324)と id が
   * ぶつかるので別の名前にしてある(`GUIDE_KEYS` も `isEditTool` も道具の id 1 本で
   * 引くため、同じ文字列にすると立体の道具がスケッチの道具として扱われる)。
   */
  | 'mirrorSolid'
  /** 移動/回転(FR-424)。2 段(動かす量 → 回す角度)。 */
  | 'transform'
  /** 拡大縮小(FR-424)。 */
  | 'scale'
  /** スイープ(FR-409)。 */
  | 'sweep'
  /** リブ(FR-420)。 */
  | 'rib'
  /** エンボス(FR-421)。 */
  | 'emboss'
  /** 外ねじ(FR-423)。 */
  | 'threadShaft'
  /** 点集合パターン(FR-425)。数値を 1 つも聞かないが、確定の合図として段を持つ。 */
  | 'pointPattern'
  /** 曲面(FR-428)。 */
  | 'surface'
  /** くり抜き(シェル、FR-418)。 */
  | 'shell'
  /** 平面による切断(FR-432)。 */
  | 'cut';

/**
 * P4 で足す新しい図形の道具(FR-314〜318、FR-326)。
 *
 * 既存の `SketchToolId` へ足さないのは、`SketchToolId` がツールバーの「基本」区画の並び
 * (`Toolbar.tsx` の `SKETCH_TOOLS` と `FIRST_STEP`)と1対1に結び付いているため。
 * 新しい図形は タスク32 で畳んだ「作図」の一覧へ入るので、別の型にして区画の対応を崩さない。
 */
export type ShapeToolId =
  /** 円(中心+半径、FR-326)。model は既存の `arc` の全周として保存する。 */
  | 'circle'
  /** 2 点+半径の円弧(FR-326)。中心は 2 点と半径から求める(§0.a-0.18)。 */
  | 'twoPointArc'
  /**
   * 3 点(始点・終点・通過点)の円弧(FR-330、P4 タスク36、2026-09-04 追加要件)。
   * 3D スケッチ専用として追加した決定だが、通常の作図面上でも同じ道具で描ける
   * (道具そのものは平面に依らない)。
   */
  | 'threePointArc'
  | 'rectangle'
  | 'polygon'
  | 'slot'
  | 'ellipse'
  | 'spline';

/**
 * P4 で足す、既存要素を参照して整形する道具(FR-321〜324、タスク21〜24)。
 *
 * `ShapeToolId` と同じ理由で `SketchToolId` へは足さない(ツールバーの「基本」区画とは
 * 1対1に結び付かない)。タスク21 がオフセット、タスク24 がミラー・複写・直線配列・円形配列
 * (FR-324)を足した。フィレット/面取り(タスク23)もここへ足す(計画書ファイル構成)。
 */
export type EditToolId =
  | 'offset'
  /** 鏡像複写(FR-324)。鏡にするものを選ぶ 1 段だけ。 */
  | 'mirror'
  /** 平行移動の複写(FR-324)。移動量の 1 段だけ。 */
  | 'copy'
  /** 直線状の配列複写(FR-324)。向き+間隔 → 個数 の 2 段。 */
  | 'linearArray'
  /** 円形の配列複写(FR-324)。中心 → 角度+個数 の 2 段。 */
  | 'circularArray'
  /** スケッチの角の丸め(FR-323、タスク23)。角を指してから半径の 1 段。 */
  | 'sketchFillet'
  /** スケッチの角の面取り(FR-323、タスク23)。角を指してから距離の 1 段。 */
  | 'sketchChamfer';

/**
 * 整形系のうち、**角(端点を共有する 2 本の線分)を指してから数値を聞く**道具
 * (FR-323、タスク23)。
 *
 * オフセット・複製系は「選んでから道具」だけだが、この 2 つは**どちらの順でも成立させる**
 * (NFR-UX-1)。道具を先に選んだときはビューポートで角を指し、指した 2 本がそのまま選択に
 * 入って段が開く(`attachSketchInteraction.ts`)。2 本を先に選んでから道具を押したときは
 * その場で段が開く(`Toolbar.tsx` の `activateEditTool`)。どちらの道でも、確定が読むのは
 * 「選択に入っている 2 本」の 1 通りだけになる。
 */
const CORNER_EDIT_TOOLS: Readonly<Record<'sketchFillet' | 'sketchChamfer', true>> = {
  sketchFillet: true,
  sketchChamfer: true,
};

/** 角を指して使う整形系の道具かどうか。一覧は `CORNER_EDIT_TOOLS` の 1 か所だけ。 */
export type CornerEditToolId = keyof typeof CORNER_EDIT_TOOLS;

export function isCornerEditTool(tool: NumericInputToolId): tool is CornerEditToolId {
  return tool in CORNER_EDIT_TOOLS;
}

/**
 * 整形系のうち、**数値をひとつも聞かない**道具(FR-322、タスク22)。
 *
 * トリム・延長は「道具を選んで、消したい部分/伸ばしたい端の近くをクリック」で決まる
 * (§0.a-0.26 の利用者の決定 2026-09-04)。距離も角度も聞かないので `EDIT_TOOL_STEPS`
 * には入れず、段を持たない道具として別の型にしてある(段の表へ嘘の段を書かないため)。
 * ツールバーの「編集」の一覧には `EditToolId` と一緒に並ぶ。
 */
export type ClickEditToolId = 'trim' | 'extend';

/**
 * 整形系のうち、**数値を聞かず、ビューポートで立体の一部を押して決まる**道具
 * (FR-325、タスク27)。
 *
 * 投影は「立体の面の外周・辺を、いまの作図面へ写す」、断面(交差)は「立体と作図面が
 * 交わってできる線を取り込む」道具で、どちらも距離も角度も聞かない。`ClickEditToolId`
 * (トリム・延長)と分けてあるのは、**押す相手がスケッチの曲線ではなく立体の部分形状・
 * 立体そのもの**だからで、当たり判定も選択の種類の切替(`selectionKindForTool`)も
 * 別の道を通る。ツールバーの「編集」の一覧には他の整形系と一緒に並ぶ。
 */
export type PickEditToolId = 'projectedCurve' | 'planeSection';

/** ツールバーの「編集」の一覧に並ぶ道具(段のあるものと、クリックだけのもの)。 */
export type EditMenuToolId = EditToolId | ClickEditToolId | PickEditToolId;

/** 一覧の正本。`EDIT_TOOL_STEPS` と同じ役目で、こちらは段を持たない側。 */
const CLICK_EDIT_TOOLS: Readonly<Record<ClickEditToolId, true>> = {
  trim: true,
  extend: true,
};

/** クリックだけで決まる整形系の道具かどうか。一覧は `CLICK_EDIT_TOOLS` の 1 か所だけ。 */
export function isClickEditTool(tool: NumericInputToolId): tool is ClickEditToolId {
  return tool in CLICK_EDIT_TOOLS;
}

/** 一覧の正本。立体の一部を押して決まる側(タスク27)。 */
const PICK_EDIT_TOOLS: Readonly<Record<PickEditToolId, true>> = {
  projectedCurve: true,
  planeSection: true,
};

/** 立体を押して決まる整形系の道具かどうか。一覧は `PICK_EDIT_TOOLS` の 1 か所だけ。 */
export function isPickEditTool(tool: NumericInputToolId): tool is PickEditToolId {
  return tool in PICK_EDIT_TOOLS;
}

/**
 * P4 タスク13 で足す基準ジオメトリの道具(FR-328 の任意の作業平面、FR-329 の基準軸・
 * 基準点・座標系)。
 *
 * 作った平面・軸・点・座標系は**スケッチではなく部品文書**の `references` へ積む
 * (`referenceCommands.ts`)。既存の面からのオフセットのように立体を見ないと決まらない
 * 決め方があり、スケッチ 1 本は立体を知らないため(model 側タスク9 の判断)。
 *
 * 平面は 4 つの道具に分けてある。決め方によって**置く点の個数そのものが違う**ので、
 * 1 つの道具の選択肢で切り替えると欄と段の並びが大きく変わり、その場で決められなくなる
 * (NFR-UX-2)。7 通りの決め方(`PlaneSpec`)との対応は次のとおり。
 *
 *   3 点                 → referencePlaneThreePoints(threePoints)
 *   面/基準面のオフセット → referencePlaneOffset(face / workPlane)
 *   基準面を軸で傾ける    → referencePlaneTilted(tilted)
 *   点+辺/面/軸          → referencePlaneThroughPoint(pointAndEdge / pointAndParallelFace / pointAndAxis)
 */
export type ReferenceToolId =
  | 'referencePlaneThreePoints'
  | 'referencePlaneOffset'
  | 'referencePlaneTilted'
  | 'referencePlaneThroughPoint'
  | 'referenceAxis'
  | 'referencePoint'
  | 'referenceCoordinateSystem';

/**
 * 外観の道具(FR-1106〜1110、P5 タスク11)。
 *
 * 数値を 1 つも聞かない(色・材質はプロパティの「外観」節で選ぶ)ので段の表には入れず、
 * トリム・延長(`ClickEditToolId`)や投影・断面(`PickEditToolId`)と同じく別の型にする。
 * 立体か面を選んでから色を付ける道具なので、選ぶ種類は面になる
 * (`solid/subShapeSelection.ts` の `selectionKindForTool`)。
 */
export type AppearanceToolId = 'appearance';

/**
 * 測る道具(FR-1101、FR-1102、P5 タスク32)。
 *
 * 外観と同じく数値を 1 つも聞かない(測る種類は選んでいるものから決まる)ので段の表には
 * 入れず、別の型にする。**選ぶ種類を切り替えない**唯一の道具でもある(§2.15 の表、
 * `solid/subShapeSelection.ts` の `keepsSelectionKind`)。いま選んでいるものをそのまま
 * 測るので、押した瞬間に選択が消えては何も測れないため。
 */
export type MeasureToolId = 'measure';

/**
 * 図形の測定値の道具(GR-30。Q1=A4「ツールバーの新しい道具」、
 * scratchpad/claude/plans/geomref-plan.md §4(a))。
 *
 * 測ると同じく数値を1つも聞かない(選んだ点・辺・面・立体から作れる量は選択そのものから
 * 決まる)ので段の表には入れず、別の型にする。**選ぶ種類を切り替えない**唯一でない道具に
 * なる(`solid/subShapeSelection.ts` の `keepsSelectionKind`。測ると同じ理由 — いま
 * 選んでいるものをそのまま測るので、押した瞬間に選択が消えては何も測れない)。
 * 「測る」との違いは、名前を付けて文書に保存し、係数の式から使えること(§4(a))。
 */
export type MathGeometryToolId = 'mathGeometry';

/** ポップアップを開ける道具。スケッチの道具より広い。 */
export type NumericInputToolId =
  | SketchToolId
  | 'text'
  | SolidToolId
  | ShapeToolId
  | ReferenceToolId
  | EditToolId
  | ClickEditToolId
  | PickEditToolId
  | AppearanceToolId
  | MeasureToolId
  | MathGeometryToolId;

/** 座標の指定方法(FR-301〜303)。 */
export type CoordinateMode = 'absolute' | 'relative' | 'polar';

/** 座標を1点聞く段階。線分は始点→終点、円弧は中心→形の2段階になる(FR-304、FR-307)。 */
export type CoordinateNumericInputStep =
  | 'point'
  | 'lineStart'
  | 'lineEnd'
  | 'arcCenter'
  | 'pointArrayBase'
  /** 円の中心(FR-326)。 */
  | 'circleCenter'
  /** 2 点+半径の円弧の 1 点目・2 点目(FR-326)。 */
  | 'twoPointArcStart'
  | 'twoPointArcEnd'
  /** 3 点の円弧の始点・終点・通過点(FR-330、タスク36)。欄は無く、3 クリックで確定する。 */
  | 'threePointArcStart'
  | 'threePointArcEnd'
  | 'threePointArcVia'
  /** 矩形の対角 2 点(FR-314)。 */
  | 'rectangleCorner1'
  | 'rectangleCorner2'
  /** 正多角形の中心(FR-315)。 */
  | 'polygonCenter'
  /** 長穴の 2 つの中心(FR-316)。 */
  | 'slotCenter1'
  | 'slotCenter2'
  /** 楕円の中心(FR-318)。 */
  | 'ellipseCenter'
  /**
   * スプラインの通過点・制御点(FR-317)。確定するたびに同じ段が開き直り、点が積み上がる
   * (下書きは `SplineDraft`。積んだ点を曲線にするのは `splineFinishStateFrom` が開く
   * `splineShape` の段)。
   */
  | 'splinePoint';

/** 座標ではなく形の値を聞く段階(FR-305、FR-308、P4 で FR-314〜318 / FR-326 / FR-327 を追加)。 */
export type ShapeNumericInputStep =
  | 'arcShape'
  | 'pointArrayShape'
  /** 格子状の点列の 2 段目(列の間隔・列数、FR-327)。 */
  | 'pointArrayGridColumns'
  | 'circleRadius'
  | 'twoPointArcRadius'
  | 'polygonShape'
  | 'slotShape'
  /** 楕円の長半径・短半径(FR-318)。 */
  | 'ellipseShape'
  /** 楕円の傾きと、「一部だけ(楕円弧)」のつまみ(FR-318)。 */
  | 'ellipseAngles'
  /** 楕円弧の開始角・終了角(FR-318)。「一部だけ」を入にしたときだけ通る。 */
  | 'ellipseArcAngles'
  /** スプラインの決め方(通過点/制御点・閉じる・構築線)。欄は持たない(FR-317)。 */
  | 'splineShape';

/** スケッチの段階。確定結果 NumericInputCommit の step はここに限る。 */
export type SketchNumericInputStep = CoordinateNumericInputStep | ShapeNumericInputStep;

/** ソリッドの段階(P2 タスク19、P3 タスク24)。ばね以外はいずれも1段で終わる。 */
export type SolidNumericInputStep =
  | 'extrudeDistance'
  | 'revolveAngle'
  | 'sewTolerance'
  | 'holeSize'
  | 'threadSize'
  | 'filletRadius'
  | 'chamferSize'
  | 'linearPattern'
  | 'circularPattern'
  /** ばねの1段目(形)。確定すると springLength へ進む(§2.11)。 */
  | 'springShape'
  /** ばねの2段目(長さ)。確定でようやく閉じる。 */
  | 'springLength'
  /*
    基本形状5種の寸法の段(FR-429、§2.15 の段の表)。どれも1段で終わる。
    **箱(3欄)と円錐(3欄)だけが欄3つ**で、P4 の「1段2欄まで」の目安を広げてある
    (§2.15「3 つまでは 1 行に収まる」。座標の段が X / Y / Z の3欄で成立しているのと同じ)。
    4欄が要る道具は従来どおり段を分ける(ばねの前例)。
  */
  | 'sphereSize'
  | 'boxSize'
  | 'cylinderSize'
  | 'coneSize'
  | 'torusSize'
  /**
   * 球面上の点の緯度・経度(FR-431、タスク22、§2.15 の段の表)。1 段・欄 2 つで終わる。
   * ビューポートで案内の交点に吸い付くと、この 2 欄が吸い付いた先の値で埋まる。
   */
  | 'sphereGridPoint'
  /*
    面をつなぐ・ロフトのねじれの段(FR-430、FR-410。P5 タスク27、§2.15 の段の表)。
    どちらも 1 段で終わる。罫線面だけは「なめらかさ」の選択肢を添えるが、**球を含まない
    断面では効かない**(§0.a-0.87)ので欄ごと伏せる(`ruledHasSphere`)。

    計画書 §2.15 の表はロフトの段を `loftOptions`(「閉じる」のつまみ)と書いていたが、
    `closed` は常に true で文書にも UI にも出さない決まりになった(タスク25 の統括の決定、
    docs/報告記録.md 2026-09-05 18:15)ので、残る欄はねじれ 1 つだけである。中身と名前を
    合わせて `loftTwist` にした(判断に迷った点として報告する)。
  */
  | 'ruledTwist'
  | 'loftTwist'
  /*
    P5 の Should / Could 群の段(タスク49、§2.15 の段の表)。**欄は 1 段 3 つまで**で、
    4 つ以上が要るものは段を分ける(移動/回転だけが 2 段。ばね・配列複写の前例)。
    出したり隠したりする欄は `NumericFieldDefinition.visibleWhen` で切り替える。

    **押し出しの終わり方・傾き・薄板、穴の入口、可変半径の R 面取りは段を持たない**
    (タスク50 で既存の `extrudeDistance` / `holeSize` / `filletRadius` へ畳んだ。
    統括の決定 2026-09-06)。
  */
  /** 抜き勾配の角度。 */
  | 'draftAngle'
  /** ミラーの鏡にする面。欄は持たない。 */
  | 'mirrorPlane'
  /** 移動/回転の 1 段目(X / Y / Z へ動かす量。**欄 3 つ**)。 */
  | 'transformTranslation'
  /** 移動/回転の 2 段目(回す角度と軸)。確定でようやく閉じる。 */
  | 'transformRotation'
  /** 拡大縮小の倍率。つまみ「軸ごと」で欄が 1 つ ↔ 3 つに変わる。 */
  | 'scaleAmount'
  /** スイープの向きの決め方。欄は持たない。 */
  | 'sweepOptions'
  /** リブの厚みと厚みを付ける側。 */
  | 'ribThickness'
  /** エンボスの高さ(彫るときは深さ)。 */
  | 'embossHeight'
  /** 外ねじのピッチと長さ。 */
  | 'threadShaftSize'
  /** 点集合パターン。欄もつまみも選択肢も持たない(確定の合図だけ)。 */
  | 'pointPattern'
  /** 曲面の作り方。選んだ作り方で欄が入れ替わる。 */
  | 'surfaceShape'
  /** くり抜きの壁の厚さ。 */
  | 'shellThickness'
  /** 切断面の決め方。「点と軸」のときだけ傾きの欄が出る。 */
  | 'cutPlane';

/**
 * 基準ジオメトリで座標を 1 点聞く段(P4 タスク13、FR-328・FR-329)。
 *
 * スケッチの段(`CoordinateNumericInputStep`)とは別の型にしてある。積む先が
 * スケッチではなく部品文書なので、確定の受け取り手(`referenceCommands.ts`)も
 * `sketchCommands.ts` / `shapeCommands.ts` とは別になるため。
 */
export type ReferenceCoordinateStep =
  /** 3 点で決める平面の 1〜3 点目。 */
  | 'referencePlanePoint1'
  | 'referencePlanePoint2'
  | 'referencePlanePoint3'
  /** 点+辺/面/軸で決める平面が通る点。 */
  | 'referencePlaneBasePoint'
  /** 2 点で決める基準軸の 1 点目・2 点目。 */
  | 'referenceAxisStart'
  | 'referenceAxisEnd'
  /** 座標で決める基準点。 */
  | 'referencePointAt'
  /** 基準座標系の原点。 */
  | 'referenceCsOrigin';

/** 基準ジオメトリで座標以外(距離・角度・決め方)を聞く段(P4 タスク13)。 */
export type ReferenceShapeStep =
  /** もとにする面と、そこから離す距離。 */
  | 'referencePlaneOffset'
  /** 傾ける軸と角度。もとにする平面はいまの作図面。 */
  | 'referencePlaneTilt'
  /** 点を通る平面の決め方(辺に垂直/辺を含む/面に平行/軸に垂直)。 */
  | 'referencePlaneThrough'
  /** 基準軸の決め方(2 点/辺/面の法線/2 面の交線)。 */
  | 'referenceAxisKind'
  /** 基準点の決め方(座標/頂点/辺の中点/面の中心)。 */
  | 'referencePointKind'
  /** 基準座標系の 2 軸の向き。 */
  | 'referenceCsAxes';

/** 基準ジオメトリの段。確定結果 `ReferenceInputCommit` の step はここに限る。 */
export type ReferenceNumericInputStep = ReferenceCoordinateStep | ReferenceShapeStep;

/**
 * 整形系の道具の段(P4 タスク21〜24、FR-321〜324)。オフセットは「距離」の 1 段だけで
 * 終わる(選択はすでに済んでいる前提。§0.a-0.10「複製系」)。
 *
 * 複製系(タスク24、FR-324)は**欄を 1 段あたり 2 個まで**にする統括の指示に合わせ、
 * 配列複写だけ 2 段に分けてある(直線は「向き+間隔」→「個数」、円形は「中心」→「角度+個数」)。
 */
export type EditNumericInputStep =
  | 'offsetDistance'
  /** ミラーの鏡にするもの(作図面の横軸/縦軸/選んだ線)。欄は持たない。 */
  | 'mirrorBasis'
  /** 複写の移動量(作図面の 2 軸ぶん。3D スケッチでは 3 つ目の欄も出る)。 */
  | 'copyDelta'
  /** 直線配列の 1 段目(向き・間隔)。 */
  | 'linearArrayDirection'
  /** 直線配列の 2 段目(個数)。 */
  | 'linearArrayCount'
  /** 円形配列の 1 段目(中心の座標)。 */
  | 'circularArrayCenter'
  /** 円形配列の 2 段目(角度・個数・全周)。 */
  | 'circularArrayShape'
  /** スケッチの角を丸める半径(FR-323)。 */
  | 'sketchFilletRadius'
  /** スケッチの角の面取りの距離(FR-323)。等距離なら 1 欄、2 距離なら 2 欄。 */
  | 'sketchChamferSize';

/** ポップアップの段階。 */
export type NumericInputStep =
  | SketchNumericInputStep
  | SolidNumericInputStep
  | ReferenceNumericInputStep
  | EditNumericInputStep;
