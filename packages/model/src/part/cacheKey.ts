/**
 * ソリッドの計算結果を覚えておく形状キャッシュの鍵(計画書 docs/plans/P2-ソリッド基礎.md
 * §2.5、§0.a-0.20)。
 *
 * フィーチャーの解決済みパラメータ(座標・向き・角度・許容誤差)と、参照する上流ボディの
 * 鍵とを1本の文字列にまとめ、FNV-1a 32bit を2本(開始点が違う)回して16桁の16進文字列に
 * する(`hash64`)。ブーリアンの材料は対象・相手フィーチャーの鍵をそのまま含む
 * (`BooleanKeyMaterial.targetKey` / `toolKey`)ので、上流の鍵が変わればそれを material に
 * 積んだ下流のブーリアンの鍵も必ず変わる(鍵の連鎖、NFR-PF-3)。
 *
 * 64ビット相当の鍵なので、200フィーチャー規模で衝突する確率は誕生日近似で
 * およそ 200 × 199 / 2 / 2^64 ≈ 1.08e-15 であり、無視できるほど小さい。
 *
 * 材料の型はこのファイルで定義し、`packages/model/src/index.ts` から輸出する(タスク12 で追加。
 * タスク17 以降の ui が鍵の材料を組み立てるときに使う)。タスク11 の `resolvePart.ts` が作る
 * `SolidStepPlan` とは別物のままにする(統括の決定: docs/報告記録.md 2026-09-03 07:35 の④
 * 「タスク10 は鍵関数の入力型を自ファイルに置く」)。欄名は `packages/kernel/src/types.ts` の
 * `ExtrudeStepSpec` 等と揃えてあるので、タスク11・12 は解決済みの値をそのままここへ渡せる。
 *
 * BigInt は使わない(1フィーチャーの再計算のたびに何度も呼ばれる経路があり、型と性能の
 * 両方で不利なため)。`Math.imul` で32ビット同士の乗算を正確に(オーバーフローなく)行う。
 *
 * P3(docs/plans/P3-加工フィーチャー.md タスク14)で、加工フィーチャー(穴・ねじ穴・R 面取り・
 * C 面取り)とばねの材料を足した。**既存の4種類(押し出し・回転・縫合・ブーリアン)の
 * 文字列は1文字も変えていない**(変えると P2 で作った鍵がすべて変わり、形状キャッシュが
 * 全滅するため)。パターン(FR-411 / FR-412)は独立の材料を持たない: パターンは穴・ねじ穴の
 * 工具を並べるだけなので、材料は穴・ねじの `transforms` に乗る(§0.a-0.20)。
 *
 * 部分形状(面・辺)の指紋は、この場で組み立てずに `part/subShapeRef.ts` の
 * `fingerprintKeyText` が作った文字列をそのまま受け取る(`KeySubShape`)。丸めの規則
 * (`keyNumber`、9桁・-0 は 0)を2か所に書かないための決めで、依存の向きも
 * `subShapeRef.ts → cacheKey.ts` の一方向のままになる(逆向きに import すると循環する)。
 *
 * P5(docs/plans/P5-高度なソリッド・外観と測定.md タスク44)で Should 群・Could 群の
 * 11 種(抜き勾配・ミラー・移動回転・拡大縮小・スイープ・リブ・エンボス・外ねじ・曲面・
 * 切断・くり抜き)の材料を足し、既存の押し出し(終端・テーパ・薄板)・穴とねじ穴(入口)・
 * R 面取り(可変半径)の欄を広げた。守った決めは3つ:
 *
 * 1. **上流の鍵(`targetKey`)を必ず混ぜる。** 対象を**消費しない**種類(ミラー・曲面の
 *    `face`・押し出しの `toNext`)も混ぜる。消費するかどうかと、上流が変わったら鍵が
 *    変わるかどうかは別の話である。混ぜないと上流を編集しても鍵が変わらず、古い形が
 *    キャッシュから返る(NFR-PF-3 の鍵の連鎖)。
 * 2. **外観(色・材質・柄)は1つも混ぜない。** 外観は形に影響しない(FR-1106、P5 §2.2.3)。
 *    材料の型に外観の欄が無いので、混ぜようとしても混ぜられない(§2.3 の二重の保証の片方。
 *    もう片方は `part/documentChange.ts` の `affectsShape`)。
 * 3. **省略できる欄は「既定なら文字列に出さない」。** タスク43 が押し出しの5欄と穴の
 *    `entry` を省略できる欄にしたので、`createPartDocument.ts` の `extrudeShapingOf` /
 *    `holeEntryOf` を通した値がそのまま材料に来る。既定を明示した材料と省略した材料が
 *    別の鍵になると、**同じ形に2つの鍵ができて**キャッシュが当たらなくなるため、
 *    既定のときは P2 / P3 のときと1文字も違わない文字列にする(既存の鍵も壊れない)。
 */

/** 鍵の材料に使う3要素ベクトル。mm 単位(NFR-RE-3)。 */
export type KeyVec3 = readonly [number, number, number];

/** 2点を結ぶ線分(kernel の `SegmentSpec` と同じ形)。 */
export interface KeySegment {
  readonly kind: 'segment';
  readonly from: KeyVec3;
  readonly to: KeyVec3;
}

/** 円弧(kernel の `ArcSpec` と同じ形)。 */
export interface KeyArc {
  readonly kind: 'arc';
  readonly center: KeyVec3;
  readonly normal: KeyVec3;
  readonly xAxis: KeyVec3;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * 楕円・楕円弧(FR-318、P4 タスク5)。model の `ResolvedEllipse` と同じ欄名。
 * 角度は**径数方程式のパラメータ角**(ラジアン)で、方位角からの変換は解決の側で済んでいる。
 */
export interface KeyEllipse {
  readonly kind: 'ellipse';
  readonly center: KeyVec3;
  readonly normal: KeyVec3;
  readonly majorAxis: KeyVec3;
  readonly majorRadius: number;
  readonly minorRadius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * スプライン(FR-317、P4 タスク5)。model の `ResolvedSpline` と同じ欄名。
 * 極ではなく通過点・制御点をそのまま材料にするのは、極は点から一意に決まるので
 * 点が同じなら形も同じになり、鍵として点で足りるため(解き直しの費用も掛からない)。
 */
export interface KeySpline {
  readonly kind: 'spline';
  readonly mode: 'interpolate' | 'control';
  readonly points: readonly KeyVec3[];
  readonly closed: boolean;
}

/** 断面・面を作る曲線(kernel の `CurveSpec` と同じ形)。 */
export type KeyCurve = KeySegment | KeyArc | KeyEllipse | KeySpline;

/**
 * 押し出しの終端(FR-415、P5 タスク44)の鍵の材料。
 * 4 種と欄名は kernel の `ExtrudeEndSpec`(`occt/makeSolidSweep.ts`)と同じにしてある。
 * 距離はすべて mm で、`toFace` は model が面までの距離を計算済みの値を持つ。
 */
export type ExtrudeEndKeyMaterial =
  | { readonly kind: 'distance'; readonly distance: number }
  | { readonly kind: 'symmetric'; readonly forward: number; readonly backward: number }
  | { readonly kind: 'toFace'; readonly distance: number }
  /** 次にぶつかる面まで。長さは相手の形で決まるので、`ExtrudeKeyMaterial.targetKey` が要る。 */
  | { readonly kind: 'toNext' };

/**
 * 薄板押し出し(FR-416)の鍵の材料。kernel の `ThinExtrudeSpec` と同じ欄名。
 * `side` を `string` にしてあるのは、選択肢の union を model の型と2か所に書かないため
 * (`ChamferKeyMaterial.mode`・`SpringKeyMaterial.handedness` と同じ決め、
 * `docs/報告記録.md` 2026-09-04 01:40 の①)。
 */
export interface ThinExtrudeKeyMaterial {
  /** 壁の厚み(mm)。 */
  readonly thickness: number;
  /** 'inner' | 'outer' | 'both'。 */
  readonly side: string;
}

/**
 * 押し出し(FR-401)の鍵の材料。断面+向き+長さ(平行移動と反転は model 側で計算済み、§0.a-0.8)。
 *
 * P5 タスク44 で終端(FR-415)・テーパ(FR-401)・薄板(FR-416)の欄を足した。
 * **足した5欄はすべて省略でき、省略と既定は同じ鍵になる**(このファイル冒頭の決め 3)。
 * 「既定」は P2 からの押し出しそのもの、すなわち
 * `end` が `{ kind: 'distance', distance }`(= この材料の `distance` と同じ長さ)、
 * テーパ 0・内向き、薄板なし、上流なし、である。
 */
export interface ExtrudeKeyMaterial {
  readonly kind: 'extrude';
  readonly profile: readonly KeyCurve[];
  readonly direction: KeyVec3;
  readonly distance: number;
  /** どこまで押し出すか(FR-415)。省略は `{ kind: 'distance', distance }` と同じ。 */
  readonly end?: ExtrudeEndKeyMaterial;
  /**
   * 側面の傾き(**ラジアン**。段の依頼 `ExtrudeStepSpec.taperAngle` と同じ単位)。
   * 大きさだけを持ち、向きは `taperOutward` が持つ。省略・0 は「傾けない」。
   */
  readonly taperAngle?: number;
  /** true で押し出すほど外へ広がり、false(既定)で内へ絞る。 */
  readonly taperOutward?: boolean;
  /** 薄板にするときの厚みと向き(FR-416)。省略・null は中身の詰まった押し出し。 */
  readonly thin?: ThinExtrudeKeyMaterial | null;
  /**
   * 「次の面まで」の相手の立体の段の鍵。**この段は相手を消費しない**が、
   * 相手を動かせば押し出しの長さが変わるので**鍵には必ず混ぜる**(NFR-PF-3 の鍵の連鎖)。
   * `end.kind !== 'toNext'` のときは null(または省略)。
   */
  readonly targetKey?: string | null;
}

/** 回転(FR-402)の鍵の材料。断面+軸+角度。 */
export interface RevolveKeyMaterial {
  readonly kind: 'revolve';
  readonly profile: readonly KeyCurve[];
  readonly axisOrigin: KeyVec3;
  readonly axisDirection: KeyVec3;
  readonly angle: number;
}

/** 縫合(FR-403)の鍵の材料。面ごとの曲線列+許容誤差。 */
export interface SewKeyMaterial {
  readonly kind: 'sew';
  readonly profiles: readonly (readonly KeyCurve[])[];
  readonly tolerance: number;
}

/**
 * ブーリアン(FR-404)の鍵の材料。操作+対象の鍵+相手の鍵。
 * `targetKey` / `toolKey` は上流フィーチャーを `cacheKeyFor` に通した戻り値をそのまま渡す。
 * これが「上流の鍵を材料に含める」の実体で、上流が変わればこの鍵も必ず変わる。
 */
export interface BooleanKeyMaterial {
  readonly kind: 'boolean';
  readonly operation: 'union' | 'subtract' | 'intersect';
  readonly targetKey: string;
  readonly toolKey: string;
}

/**
 * 工具全体にかける剛体変換1つ(パターン、FR-411 / FR-412、§0.a-0.20)。
 * `rotationAngle` はラジアン。0 なら平行移動だけになる。
 * kernel の `RigidTransformSpec`・model の `RigidTransform` と同じ欄名にしてあるので、
 * 解決済みの値をそのまま詰め替えられる。
 */
export interface KeyTransform {
  readonly translation: KeyVec3;
  readonly rotationOrigin: KeyVec3;
  readonly rotationAxis: KeyVec3;
  /** 回転角(ラジアン)。度からの変換は呼び出し側(resolvePart)で済ませる。 */
  readonly rotationAngle: number;
}

/**
 * 部分形状(面・辺・頂点)の指紋を鍵へ混ぜるための文字列。
 * `part/subShapeRef.ts` の `fingerprintKeyText(reference)` が作った文字列をそのまま持つ。
 * ここで指紋の欄を組み立て直さないのは、丸め(`keyNumber`)の規則を2か所に書かないため。
 */
export type KeySubShape = string;

/**
 * 穴・ねじ穴の入口の形(ざぐり・皿もみ。FR-422、P5 §0.a-0.39、タスク44)の鍵の材料。
 *
 * 3 種と欄名は kernel の `HoleEntrySpec`(`occt/makeHole.ts`)と同じ。
 * **皿もみの `angle` はラジアン**で、段の依頼とまったく同じ単位である
 * (文書は度で持ち、換算は解決(タスク46)が行う。model の `HoleEntry` の注釈)。
 * 単位を段と揃えるのは、鍵の材料を組み立てる側が段の依頼から欄を写すだけで済むようにするため。
 *
 * 皿もみの円錐の深さは頭径・穴の径・角度からカーネルが導くので、材料には持たない
 * (導出できるものは混ぜない。`SpringKeyMaterial` の全長と同じ理由)。
 */
export type HoleEntryKeyMaterial =
  /** 広げない(既定)。この材料は鍵の文字列に出さない(省略と同じ鍵にするため)。 */
  | { readonly kind: 'plain' }
  | { readonly kind: 'counterbore'; readonly diameter: number; readonly depth: number }
  /** `angle` は**ラジアン**(段の依頼と同じ単位)。 */
  | { readonly kind: 'countersink'; readonly diameter: number; readonly angle: number };

/**
 * 穴(FR-405)の鍵の材料。
 *
 * `centers` の**並びも鍵に効く**(並べ替えると別の鍵になる)。カーネルは中心点の順に円柱を
 * 作って1つのコンパウンドにまとめるので、並びは形の作り方の一部である。model 側は
 * 「利用者が選んだ順」を保ったまま渡し、勝手に並べ替えない(並べ替えるなら常に並べ替える)。
 *
 * `transforms` は**空とすることと恒等を1つ入れることを区別する**。カーネルは
 * 「空なら恒等1つ」として同じ形を作るが、鍵は文字列が違えば違う鍵になる。
 * したがって **model は必ずどちらかに揃える**(パターンでない穴は必ず空にする)。
 */
export interface HoleKeyMaterial {
  readonly kind: 'hole';
  /** 対象のボディの鍵。上流が変われば必ず変わる(鍵の連鎖、NFR-PF-3)。 */
  readonly targetKey: string;
  /** 穴をあける面の指紋(`fingerprintKeyText` の出力)。 */
  readonly face: KeySubShape;
  /** 中心にする点(mm)。面への投影はカーネルが行うので、投影前の座標を混ぜる。 */
  readonly centers: readonly KeyVec3[];
  readonly diameter: number;
  /** 貫通なら null。止まり穴の深さ 0 とは別の鍵になる。 */
  readonly depth: number | null;
  /** 面の法線からの傾き(ラジアン)。 */
  readonly tiltAngle: number;
  /** 傾ける向き(面内の方位角、ラジアン)。 */
  readonly tiltAzimuth: number;
  /**
   * 工具の並べ方(パターン、FR-411 / FR-412 / FR-425)。
   *
   * **点の集まりへ複製(FR-425、P5 §0.a-0.42)も、独立の欄を持たずにここへ乗る。**
   * 解決(タスク46)が点それぞれを平行移動 1 つへ直すので、点の一覧はこの並びに
   * そのまま現れる。点の座標を材料へ二重に持たせないのは、同じ形に2つの鍵ができるのを
   * 避けるためである(カーネルの段も点集合のための欄を持たない。報告記録 9/5 19:10)。
   */
  readonly transforms: readonly KeyTransform[];
  /**
   * 入口の形(ざぐり・皿もみ。FR-422)。省略と `{ kind: 'plain' }` は同じ鍵になる
   * (このファイル冒頭の決め 3)。
   */
  readonly entry?: HoleEntryKeyMaterial;
}

/**
 * ねじ穴(FR-406)の鍵の材料。穴に、ねじの規格から決まる値と表示方法を足したもの。
 * `modeled` は実らせん形状(true)か簡略表示(false)かで、**形そのものが変わる**ので混ぜる
 * (簡略表示は下穴だけを掘り、実らせんはさらにらせんを差し引く。§0.a-0.15、§0.a-0.16)。
 */
export interface ThreadKeyMaterial {
  readonly kind: 'thread';
  readonly targetKey: string;
  readonly face: KeySubShape;
  readonly centers: readonly KeyVec3[];
  /** 下穴の径(mm、= めねじ内径 D1)。 */
  readonly drillDiameter: number;
  /** おねじの外径 d(mm)。実らせんの掃引半径と簡略表示の印に効く。 */
  readonly majorDiameter: number;
  readonly pitch: number;
  /** ねじ部の長さ(mm)。 */
  readonly threadLength: number;
  readonly depth: number | null;
  /** 実らせん形状なら true、簡略表示なら false。 */
  readonly modeled: boolean;
  readonly tiltAngle: number;
  readonly tiltAzimuth: number;
  /** 並べ方。点集合(FR-425)も平行移動として乗る(`HoleKeyMaterial.transforms` の注釈)。 */
  readonly transforms: readonly KeyTransform[];
  /** 入口の形(FR-422)。穴とまったく同じ扱いで、省略と `plain` は同じ鍵になる。 */
  readonly entry?: HoleEntryKeyMaterial;
}

/**
 * 丸める半径(FR-407、可変半径は FR-426、§0.a-0.48)。
 * 数1つなら一定半径、2値なら辺の始点側 `start` から終点側 `end` へ変える可変半径。
 * kernel の `FilletRadiusSpec` と同じ形にしてある。
 */
export type FilletRadiusKeyMaterial = number | { readonly start: number; readonly end: number };

/**
 * R 面取り(FR-407)の鍵の材料。
 * `targets` は辺・頂点の指紋の並びで、**並びが違えば違う鍵**になる。
 * そのため **model は必ず通し番号の昇順に並べてから渡す**(タスク16 の `planFillet`)。
 * 同じ辺の集合を選んだのに選んだ順で鍵が変わると、キャッシュが当たらなくなるため。
 *
 * P5 タスク44 で半径を可変(FR-426)にも広げた。一定半径の文字列は P3 のまま変えていない
 * (数1つのときは `keyNumber` の出力そのもので、可変のときだけ `variable(…)` を出す)。
 */
export interface FilletKeyMaterial {
  readonly kind: 'fillet';
  readonly targetKey: string;
  readonly targets: readonly KeySubShape[];
  readonly radius: FilletRadiusKeyMaterial;
}

/**
 * C 面取り(FR-408)の鍵の材料。`targets` の扱いは `FilletKeyMaterial` と同じ(昇順)。
 * 大きさの指定は3通り(等距離・2距離・距離+角度)あるが、鍵では
 * 「種類 + 数値2つ」に平らへ均して持つ(材料の型を3つに割らない)。
 */
export interface ChamferKeyMaterial {
  readonly kind: 'chamfer';
  readonly targetKey: string;
  readonly targets: readonly KeySubShape[];
  /** 'equal' | 'twoDistances' | 'distanceAngle'。 */
  readonly mode: string;
  /** 等距離・2距離の1つ目・距離+角度の距離(mm)。 */
  readonly distance1: number;
  /** 2距離の2つ目、または距離+角度の角度(ラジアン)。等距離では 0。 */
  readonly distance2: number;
  readonly swapReferenceFace: boolean;
}

/**
 * ばね(FR-414、§2.7b)の鍵の材料。
 * 対象のボディを消費しないので `targetKey` を持たない(§0.a-0.36)。
 *
 * **全長(`length`)と `derived` は材料に混ぜない。** 形を決めるのは `pitch` と `turns` の2つで、
 * 全長は `length = pitch × turns` で導ける値だからである。混ぜると「ピッチ5・巻数4」と
 * 「全長20から導いたピッチ5・巻数4」に別々の鍵ができ、同じ形なのにキャッシュが当たらなくなる。
 */
export interface SpringKeyMaterial {
  readonly kind: 'spring';
  /** らせんの軸の始点(mm)。 */
  readonly origin: KeyVec3;
  /** 軸の向き(単位ベクトル)。傾きを適用した後の値。 */
  readonly direction: KeyVec3;
  /** コイルの中心径(mm)。 */
  readonly coilDiameter: number;
  /** 線径(mm)。 */
  readonly wireDiameter: number;
  /** 1巻きあたりの軸方向の進み(mm)。 */
  readonly pitch: number;
  /** 巻数。`derived` を解決した後の値。 */
  readonly turns: number;
  /** 'right' | 'left'。 */
  readonly handedness: string;
}

/**
 * 基本形状(FR-429)の寸法の材料。欄名は kernel の `PrimitiveShapeSpec`・model の
 * `PrimitiveShape` と同じにしてあるので、解決済みの数値をそのまま詰め替えられる。
 */
export type PrimitiveShapeKeyMaterial =
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'box'; readonly sizeX: number; readonly sizeY: number; readonly sizeZ: number }
  | { readonly kind: 'cylinder'; readonly radius: number; readonly height: number }
  | {
      readonly kind: 'cone';
      readonly bottomRadius: number;
      readonly topRadius: number;
      readonly height: number;
    }
  | { readonly kind: 'torus'; readonly majorRadius: number; readonly minorRadius: number };

/**
 * 基本形状(FR-429、P5 §2.7)の鍵の材料。形の種類と寸法・基準点・向き。
 *
 * 対象のボディを消費しない「作る」フィーチャーなので、ばねと同じく普段は上流を持たない
 * (§0.a-0.19)。ただし**基準点に立体の頂点を指したときだけ** `originQuery`(頂点の指紋)と
 * `targetKey`(その頂点を持つ立体の段の鍵)が入る。
 *
 * **この2つを材料へ必ず含める**(P5 タスク14b の申し送り)。含めないと、上流の押し出しを
 * 伸ばして頂点が動いても段の鍵が変わらず、**古い位置の形がキャッシュから返る**。
 * 鍵の連鎖(NFR-PF-3)は「材料が変われば鍵が変わる」ことに全面的に頼っているので、
 * 位置を決める材料が鍵の外にあってはならない。消費しないことと鍵に混ぜることは別の話で、
 * `targetKey` を持つからといって対象を食べるわけではない。
 *
 * `origin` は、`originQuery` があるときは**頂点からのオフセット**、無いときは世界座標
 * (kernel の `PrimitiveStepSpec.origin` と同じ約束)。どちらでも形を決める値なので混ぜる。
 */
export interface PrimitiveKeyMaterial {
  readonly kind: 'primitive';
  /** 基準点(mm)。球・箱・トーラスは中心、円柱・円錐は底面の中心(§0.a-0.17)。 */
  readonly origin: KeyVec3;
  /** 向き(単位ベクトル)。`gp_Ax2` の Z 方向になる。 */
  readonly axis: KeyVec3;
  readonly shape: PrimitiveShapeKeyMaterial;
  /** 基準点にする頂点の指紋(`fingerprintKeyText` の出力)。座標・スケッチの点なら null。 */
  readonly originQuery: KeySubShape | null;
  /** その頂点を持つ立体の段の鍵。`originQuery` が null なら null。 */
  readonly targetKey: string | null;
}

/**
 * 罫線面・ロフト(FR-430、FR-410、P5 §2.9)の断面 1 つぶんの鍵の材料。
 *
 * 種類は kernel の `ThruSectionSpec` と同じ 3 通りにしてある。輪郭は解決済みの数値
 * (`KeyCurve`)を、球は中心と半径を、立体の面は**指紋の文字列と対象の段の鍵**を混ぜる。
 * 立体の面で指紋と鍵の両方を混ぜるのは、基本形状の頂点(`PrimitiveKeyMaterial`)と同じ理由で、
 * **上流の立体が変われば必ず鍵が変わるようにする**ため(NFR-PF-3 の鍵の連鎖)。
 */
export type ThruSectionKeyMaterial =
  | { readonly kind: 'curves'; readonly curves: readonly KeyCurve[] }
  | { readonly kind: 'sphere'; readonly center: KeyVec3; readonly radius: number }
  | {
      readonly kind: 'faceQuery';
      /** 面を持つ立体の段の鍵。**消費はしない**(§0.a-0.27)が鍵には必ず混ぜる。 */
      readonly targetKey: string;
      /** 面の指紋(`fingerprintKeyText` の出力)。 */
      readonly query: KeySubShape;
    };

/**
 * 罫線面・ロフト(FR-430、FR-410、P5 §2.9)の鍵の材料。
 *
 * 対象のボディを消費しない「作る」段なので、ばね・基本形状と同じく上流の `targetKey` を
 * 段そのものは持たない(輪郭に立体の面を使ったときだけ、その断面の中に鍵が入る)。
 *
 * **断面の数値をすべて混ぜる。** スケッチの面を動かすと輪郭の座標が変わるので、輪郭を
 * 混ぜておけば上流の変化がそのまま鍵に伝わる(押し出しの `profile` と同じ考え方)。
 * `ruled` は直線で結ぶ(罫線面)かなめらかに結ぶ(ロフト)かで**形が変わる**ので混ぜ、
 * `twist` と `sphereSegments` も形を変えるので混ぜる(§0.a-0.28、§0.a-0.74)。
 */
export interface ThruSectionsKeyMaterial {
  readonly kind: 'thruSections';
  readonly sections: readonly ThruSectionKeyMaterial[];
  readonly ruled: boolean;
  readonly closed: boolean;
  readonly twist: number;
  /** 球の近似の点の数(24 / 48 / 72)。球を使わない段でも段の欄として常に混ぜる。 */
  readonly sphereSegments: number;
}

// ---------------------------------------------------------------------------
// P5 の Should 群・Could 群の材料(FR-417〜FR-428、FR-432。計画書 §2.11、タスク44)。
//
// 欄の名前と単位は `packages/kernel/src/types.ts` の段の型(`DraftStepSpec` ほか)と
// 揃えてある。**角度はどれもラジアン**(段の依頼と同じ単位)で、度からの換算は解決の
// 担当である(`docs/報告記録.md` 2026-09-04 00:30 の③(c))。
//
// **対象を消費するかどうかにかかわらず、上流を指す種類は `targetKey` を必ず持つ。**
// 消費しないのはミラー(§0.a-0.36)と曲面の `face`(§0.a-0.45)だが、どちらも上流の形が
// 変われば結果の形が変わるので、鍵の連鎖(NFR-PF-3)には同じように参加する。
// ---------------------------------------------------------------------------

/**
 * 抜き勾配(FR-417、§2.11)の鍵の材料。**対象を消費する。**
 * `faces` の並びは指紋の並びのまま持つ(`FilletKeyMaterial.targets` と同じ約束)。
 */
export interface DraftKeyMaterial {
  readonly kind: 'draft';
  /** 傾ける立体の段の鍵。 */
  readonly targetKey: string;
  /** 傾ける面の指紋。1枚以上。 */
  readonly faces: readonly KeySubShape[];
  /** 基準にする平らな面(中立面)の指紋。 */
  readonly neutralFace: KeySubShape;
  /** 傾きの大きさ(ラジアン)。向きは `reversed` が持つ。 */
  readonly angle: number;
  readonly reversed: boolean;
}

/**
 * ミラー(FR-419、§0.a-0.36)の鍵の材料。
 *
 * **対象を消費しないが `targetKey` は必ず混ぜる。** 鏡に映す立体が変われば鏡像も変わるので、
 * 混ぜないと元を編集しても鏡像の鍵が変わらず、古い形がキャッシュから返る(NFR-PF-3)。
 * 鏡の平面は、基準平面・作業平面・立体の平らな面のどれであっても
 * 解決が「通る点+法線」の数値へ直してから渡す(kernel の `MirrorStepSpec` と同じ形)。
 */
export interface MirrorKeyMaterial {
  readonly kind: 'mirror';
  /** 鏡に映す立体の段の鍵。**消費しない**が必ず混ぜる。 */
  readonly targetKey: string;
  /** 鏡の平面が通る点(mm)。 */
  readonly origin: KeyVec3;
  /** 鏡の平面の法線。 */
  readonly normal: KeyVec3;
}

/**
 * 移動/回転(FR-424、§0.a-0.41)の鍵の材料。**対象を消費する。**
 * 欄名は `KeyTransform`(パターンの剛体変換)と同じで、回転角はラジアン。
 */
export interface TransformKeyMaterial {
  readonly kind: 'transform';
  readonly targetKey: string;
  readonly translation: KeyVec3;
  readonly rotationOrigin: KeyVec3;
  readonly rotationAxis: KeyVec3;
  /** 回転角(ラジアン)。0 なら平行移動だけ。 */
  readonly rotationAngle: number;
}

/**
 * 拡大縮小(FR-424、§0.a-0.41)の鍵の材料。**対象を消費する。**
 *
 * `uniform` と `perAxis` は**どちらか一方だけ**が入る(kernel の `ScaleStepSpec` と同じ約束)。
 * 両方を材料の欄として持つのは、全体倍率 2 と軸ごと (2,2,2) が**同じ形**でも
 * 別の指定であることを鍵の上でも区別できるようにするためではなく、段の依頼をそのまま
 * 写せるようにするためである(同じ形に2つの鍵ができるのは、解決が常にどちらか一方の
 * 書き方に正規化することで防ぐ。判断はタスク45)。
 */
export interface ScaleKeyMaterial {
  readonly kind: 'scale';
  readonly targetKey: string;
  /** 拡大縮小の中心(mm)。この点は動かない。 */
  readonly origin: KeyVec3;
  /** 全体の倍率。軸ごとに変えるときは null。 */
  readonly uniform: number | null;
  /** 軸ごとの倍率(X, Y, Z)。全体の倍率のときは null。 */
  readonly perAxis: KeyVec3 | null;
}

/**
 * スイープ(FR-409、§0.a-0.43)の鍵の材料。
 * **対象を取らない「作る」段**なので `targetKey` を持たない(押し出し・ばねと同じ)。
 * 断面も経路も解決済みの座標なので、スケッチを直せばそのまま鍵が変わる。
 */
export interface SweepKeyMaterial {
  readonly kind: 'sweep';
  /** 掃く断面の閉ループ。 */
  readonly profile: readonly KeyCurve[];
  /** 経路。並びが意味を持つ。 */
  readonly path: readonly KeyCurve[];
  /** true で Frenet、false で「ねじれを抑える」。形が変わるので混ぜる。 */
  readonly frenet: boolean;
}

/**
 * リブ(FR-420、§0.a-0.37)の鍵の材料。**対象を消費する。**
 * 欄名は kernel の `RibStepSpec` と同じ。`direction`(材料へ向かう向き)は
 * 「材料に届くまで伸ばすか」を解決が向きへ直した後の値である。
 */
export interface RibKeyMaterial {
  readonly kind: 'rib';
  readonly targetKey: string;
  /** 壁にする輪郭(閉じていなくてよい)。 */
  readonly profile: readonly KeyCurve[];
  /** 輪郭の平面の法線。厚みはこの向きへ付く。 */
  readonly normal: KeyVec3;
  readonly thickness: number;
  /** 両側へ付けるか(false なら法線の側だけ)。 */
  readonly symmetric: boolean;
  /** 伸ばす向き。 */
  readonly direction: KeyVec3;
}

/**
 * エンボス(FR-421、§0.a-0.38)の鍵の材料。**対象を消費する。**
 * 彫る(差)か浮き出す(和)かで形が変わるので `raised` も混ぜる。
 */
export interface EmbossKeyMaterial {
  readonly kind: 'emboss';
  readonly targetKey: string;
  /** 相手の平らな面の指紋。 */
  readonly face: KeySubShape;
  /** 面の上に置く閉じた輪郭。並びが意味を持つ。 */
  readonly profiles: readonly (readonly KeyCurve[])[];
  /** 面から測った深さ(mm)。 */
  readonly depth: number;
  readonly raised: boolean;
}

/**
 * 外ねじ(FR-423、§0.a-0.40)の鍵の材料。**対象を消費する。**
 *
 * 簡略表示(`modeled: false`)と実らせん(true)は**形そのものが変わる**ので混ぜる
 * (ねじ穴の `ThreadKeyMaterial.modeled` と同じ理由。簡略表示は B-rep に触れない)。
 * `fromEnd` を `string` にしてあるのは選択肢の union を2か所に書かないため。
 */
export interface ThreadShaftKeyMaterial {
  readonly kind: 'threadShaft';
  readonly targetKey: string;
  /** ねじを切る円柱面の指紋。 */
  readonly face: KeySubShape;
  /** 呼び径 d(mm)。 */
  readonly majorDiameter: number;
  readonly pitch: number;
  /** ねじ部の長さ(mm)。 */
  readonly length: number;
  /** 'first' | 'last'。軸のどちらの端から切り始めるか。 */
  readonly fromEnd: string;
  readonly modeled: boolean;
}

/**
 * 曲面の作り方(FR-428、§0.a-0.45)の鍵の材料。5 種の中身をすべて持つ。
 * 種類と欄名は kernel の `SurfaceInput`(`occt/makeSurface.ts`)と同じにしてある。
 * 角度はラジアン。
 */
export type SurfaceShapeKeyMaterial =
  | {
      readonly kind: 'extrude';
      readonly profile: readonly KeyCurve[];
      readonly direction: KeyVec3;
      readonly distance: number;
    }
  | {
      readonly kind: 'revolve';
      readonly profile: readonly KeyCurve[];
      readonly axisOrigin: KeyVec3;
      readonly axisDirection: KeyVec3;
      /** 回転角(ラジアン)。 */
      readonly angle: number;
    }
  | { readonly kind: 'planar'; readonly profile: readonly KeyCurve[] }
  | {
      readonly kind: 'loft';
      readonly sections: readonly (readonly KeyCurve[])[];
      /** true なら直線で結ぶ(罫線)、false ならなめらかに結ぶ。 */
      readonly ruled: boolean;
    }
  /** すでにある立体の面 1 枚。指紋と、段の `targetKey` の**両方**が鍵に効く。 */
  | { readonly kind: 'face'; readonly face: KeySubShape }
  /**
   * すでにある立体の面を距離だけ離した殻(カーネルの `SurfaceInput` の 6 種目、タスク42b)。
   * `face` と同じく指紋と `targetKey` の両方が鍵に効き、距離も形を変えるので混ぜる。
   */
  | { readonly kind: 'offset'; readonly face: KeySubShape; readonly distance: number };

/**
 * 曲面(FR-428、§0.a-0.45)の鍵の材料。面だけのボディを作る。
 *
 * **`face` の作り方でも対象を消費しない**(面を貸した立体は画面に残る)が、
 * `targetKey` は必ず混ぜる。混ぜないと上流を編集しても鍵が変わらず、古い面の形が
 * キャッシュから返る(罫線面の `faceQuery`・基本形状の頂点とまったく同じ。NFR-PF-3)。
 */
export interface SurfaceKeyMaterial {
  readonly kind: 'surface';
  readonly shape: SurfaceShapeKeyMaterial;
  /** 面を借りる立体の段の鍵。`shape.kind !== 'face'` なら null。**消費しない。** */
  readonly targetKey: string | null;
}

/**
 * 平面による切断(FR-432、§2.9b。分割 FR-424 もこれで満たす、§0.a-0.60)の鍵の材料。
 * **対象を消費する。**
 *
 * **model のフィーチャーの型(`CutFeature`)はタスク27c が後で足す**ので、ここでは
 * 段の依頼 `CutStepSpec` に合わせた形だけを用意してある(欄名・単位とも同じ)。
 * 切断面は解決が「通る点+単位法線」の数値へ直してから渡す。
 */
export interface CutKeyMaterial {
  readonly kind: 'cut';
  readonly targetKey: string;
  /** 切断面が通る点(mm)。 */
  readonly origin: KeyVec3;
  /** 単位法線。 */
  readonly normal: KeyVec3;
  /** 法線の側を残すなら true。反対側を残すと別の形なので混ぜる。 */
  readonly keepPositive: boolean;
}

/**
 * くり抜き(シェル。FR-418、§0.a-0.47)の鍵の材料。**対象を消費する。**
 *
 * `openFaces` は**0枚でもよい**(中だけが空になる)。並びは指紋の並びのまま持ち、
 * 長さも鍵に混ざるので「0枚」と「1枚」は必ず別の鍵になる。
 */
export interface ShellKeyMaterial {
  readonly kind: 'shell';
  readonly targetKey: string;
  /** 開ける面の指紋の並び。0枚でもよい。 */
  readonly openFaces: readonly KeySubShape[];
  /** 壁の厚さ(mm)。 */
  readonly thickness: number;
  /** true で外向きに肉を付ける。 */
  readonly outward: boolean;
}

/**
 * 1段ぶんの鍵の材料。段の種類ごとに要る値だけを持つ。
 * パターン(FR-411 / FR-412 / FR-425)の材料はここに無い。パターンはもとの穴・ねじ穴の材料の
 * `targetKey` と `transforms` を差し替えたものとして表すため(§0.a-0.20、§0.a-0.42)。
 */
export type SolidStepKeyMaterial =
  | ExtrudeKeyMaterial
  | RevolveKeyMaterial
  | SewKeyMaterial
  | BooleanKeyMaterial
  | HoleKeyMaterial
  | ThreadKeyMaterial
  | FilletKeyMaterial
  | ChamferKeyMaterial
  | SpringKeyMaterial
  | PrimitiveKeyMaterial
  | ThruSectionsKeyMaterial
  // ここから下は P5 の Should 群・Could 群(§2.11、タスク44)。
  | DraftKeyMaterial
  | MirrorKeyMaterial
  | TransformKeyMaterial
  | ScaleKeyMaterial
  | SweepKeyMaterial
  | RibKeyMaterial
  | EmbossKeyMaterial
  | ThreadShaftKeyMaterial
  | SurfaceKeyMaterial
  | CutKeyMaterial
  | ShellKeyMaterial;

/** 座標を鍵へ混ぜるときの丸め桁数。double の下位の揺れで鍵が変わらないようにする。 */
export const KEY_DECIMALS = 9;

/**
 * 数値1つを鍵用の文字列にする。
 * 非数・無限は `'x'`(鍵を作れないことを表す。呼び出し側で除外できなかった異常値の印)。
 * `-0` は `0` と同一視する(`Object.is` では区別できてしまう double の癖を吸収する)。
 */
export function keyNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return 'x';
  }
  const normalized = value === 0 ? 0 : value;
  return normalized.toFixed(KEY_DECIMALS);
}

const FNV_PRIME_32 = 0x01000193;
/** 標準の FNV-1a 32bit オフセット基底。公式テストベクトルの起点(下の test ファイルで検算)。 */
const FNV_OFFSET_LANE_1 = 0x811c9dc5;
/** 第2レーンは第1レーンと違う開始点で回す(§0.a-0.20「オフセットが違う」)。全ビット反転で作る。 */
const FNV_OFFSET_LANE_2 = (~FNV_OFFSET_LANE_1) >>> 0;

/**
 * FNV-1a 32bit を1本回す。文字列は UTF-16 コード単位ごとに XOR する。
 * この関数へ渡す入力(鍵の材料の文字列化)は toFixed の出力とキーワード・区切り記号だけの
 * ASCII なので、コード単位ごとの XOR はバイト単位の標準 FNV-1a と同じ結果になる。
 */
function fnv1a32(text: string, offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash ^ text.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash >>> 0;
}

/**
 * FNV-1a を32ビット2本(オフセットが違う)で回し、16桁の16進文字列にする(§0.a-0.20)。
 * 決定的(同じ入力には常に同じ出力)。BigInt を使わない。
 */
export function hash64(text: string): string {
  const lane1 = fnv1a32(text, FNV_OFFSET_LANE_1);
  const lane2 = fnv1a32(text, FNV_OFFSET_LANE_2);
  return lane1.toString(16).padStart(8, '0') + lane2.toString(16).padStart(8, '0');
}

function keyVec3(vector: KeyVec3): string {
  return `${keyNumber(vector[0])},${keyNumber(vector[1])},${keyNumber(vector[2])}`;
}

function keyCurve(curve: KeyCurve): string {
  switch (curve.kind) {
    case 'segment':
      return `segment(${keyVec3(curve.from)}|${keyVec3(curve.to)})`;
    case 'arc':
      return (
        `arc(${keyVec3(curve.center)}|${keyVec3(curve.normal)}|${keyVec3(curve.xAxis)}` +
        `|${keyNumber(curve.radius)}|${keyNumber(curve.startAngle)}|${keyNumber(curve.endAngle)})`
      );
    case 'ellipse':
      return (
        `ellipse(${keyVec3(curve.center)}|${keyVec3(curve.normal)}|${keyVec3(curve.majorAxis)}` +
        `|${keyNumber(curve.majorRadius)}|${keyNumber(curve.minorRadius)}` +
        `|${keyNumber(curve.startAngle)}|${keyNumber(curve.endAngle)})`
      );
    case 'spline':
      // 点の並びは順序が意味を持つので、長さも混ぜる(曲線の並びと同じ衝突対策)。
      return (
        `spline(${curve.mode}|${keyBoolean(curve.closed)}` +
        `|${String(curve.points.length)}:[${curve.points.map(keyVec3).join(',')}])`
      );
  }
}

/**
 * 曲線の並び1本ぶん。順序を保ったまま連結し、長さも混ぜる(衝突対策)。
 *
 * オフセット(FR-321、P4 タスク15)の鍵も曲線の並びを材料にするので輸出する。
 * 丸めの規則(`keyNumber`)を2か所に書かないための決めで、`geometry/planeSpec.ts` が
 * `keyNumber` を借りているのと同じ考え方。
 */
export function keyCurveList(curves: readonly KeyCurve[]): string {
  return `${curves.length}:[${curves.map(keyCurve).join(',')}]`;
}

/**
 * 曲線の並びの並び(縫合の面ごと・エンボスの輪郭ごと・曲面のロフトの断面ごと)。
 * 外側の長さも混ぜる(`keyCurveList` と同じ衝突対策)。縫合が P2 から使っている
 * 文字列とまったく同じ形なので、既存の鍵は変わらない。
 */
function keyCurveListGroup(groups: readonly (readonly KeyCurve[])[]): string {
  return `${groups.length}:[${groups.map(keyCurveList).join(',')}]`;
}

/**
 * 無い(null)ことがある数値。`'none'` は `keyNumber` が返す数字列(必ず小数点を含む)と
 * 重ならないので、`null` と `0` は必ず別の文字列になる(貫通穴と深さ0の止まり穴の区別)。
 */
function keyOptionalNumber(value: number | null): string {
  return value === null ? 'none' : keyNumber(value);
}

/**
 * 真偽値。テンプレート文字列へ直に埋め込まず、この関数で明示的に文字列へ直す
 * (`@typescript-eslint/restrict-template-expressions` に掛からないため)。
 */
function keyBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

/** 座標の並び。順序を保ったまま連結し、長さも混ぜる(`keyCurveList` と同じ理由)。 */
function keyVec3List(vectors: readonly KeyVec3[]): string {
  return `${vectors.length}:[${vectors.map(keyVec3).join(',')}]`;
}

/** 剛体変換1つ(パターン)。 */
function keyTransform(transform: KeyTransform): string {
  return (
    `transform(${keyVec3(transform.translation)}` +
    `|${keyVec3(transform.rotationOrigin)}` +
    `|${keyVec3(transform.rotationAxis)}` +
    `|${keyNumber(transform.rotationAngle)})`
  );
}

/** 剛体変換の並び。長さを混ぜるので、空と恒等1つは必ず別の文字列になる。 */
function keyTransformList(transforms: readonly KeyTransform[]): string {
  return `${transforms.length}:[${transforms.map(keyTransform).join(',')}]`;
}

/**
 * 部分形状の指紋の並び。各要素は `fingerprintKeyText` が作った
 * `face{…}` / `edge{…}` / `vertex{…}` の形で、それ自体が区切りを持つ。長さも混ぜる。
 */
function keySubShapeList(subShapes: readonly KeySubShape[]): string {
  return `${subShapes.length}:[${subShapes.join(',')}]`;
}

/**
 * 無い(null)ことがある文字列(頂点の指紋・上流の鍵)。
 * `'none'` は指紋(`vertex{…}`)とも鍵(16桁の16進)とも重ならないので、
 * 「指していない」と「指している」は必ず別の文字列になる。
 */
function keyOptionalText(value: string | null): string {
  return value === null ? 'none' : value;
}

/** 基本形状の寸法(FR-429)。形の種類を先頭に置くので、種類が違えば必ず別の文字列になる。 */
function keyPrimitiveShape(shape: PrimitiveShapeKeyMaterial): string {
  switch (shape.kind) {
    case 'sphere':
      return `sphere(${keyNumber(shape.radius)})`;
    case 'box':
      return (
        `box(${keyNumber(shape.sizeX)},${keyNumber(shape.sizeY)},${keyNumber(shape.sizeZ)})`
      );
    case 'cylinder':
      return `cylinder(${keyNumber(shape.radius)},${keyNumber(shape.height)})`;
    case 'cone':
      return (
        `cone(${keyNumber(shape.bottomRadius)},${keyNumber(shape.topRadius)}` +
        `,${keyNumber(shape.height)})`
      );
    case 'torus':
      return `torus(${keyNumber(shape.majorRadius)},${keyNumber(shape.minorRadius)})`;
  }
}

/**
 * 罫線面・ロフトの断面 1 つ(FR-430、FR-410)。種類を先頭に置くので、
 * 種類が違えば必ず別の文字列になる(`keyPrimitiveShape` と同じ作り)。
 */
function keyThruSection(section: ThruSectionKeyMaterial): string {
  switch (section.kind) {
    case 'curves':
      return `curves(${keyCurveList(section.curves)})`;
    case 'sphere':
      return `sphere(${keyVec3(section.center)}|${keyNumber(section.radius)})`;
    case 'faceQuery':
      return `faceQuery(${section.targetKey}|${section.query})`;
  }
}

/** 断面の並び。順序が意味を持つので、長さも混ぜる(`keyCurveList` と同じ理由)。 */
function keyThruSectionList(sections: readonly ThruSectionKeyMaterial[]): string {
  return `${sections.length}:[${sections.map(keyThruSection).join(',')}]`;
}

/** 無い(null)ことがある座標。`'none'` は数字列と重ならないので必ず別の文字列になる。 */
function keyOptionalVec3(vector: KeyVec3 | null): string {
  return vector === null ? 'none' : keyVec3(vector);
}

/** 押し出しの終端(FR-415)。種類を先頭に置くので、種類が違えば必ず別の文字列になる。 */
function keyExtrudeEnd(end: ExtrudeEndKeyMaterial): string {
  switch (end.kind) {
    case 'distance':
      return `distance(${keyNumber(end.distance)})`;
    case 'symmetric':
      return `symmetric(${keyNumber(end.forward)}|${keyNumber(end.backward)})`;
    case 'toFace':
      return `toFace(${keyNumber(end.distance)})`;
    case 'toNext':
      return 'toNext';
  }
}

/** 薄板押し出し(FR-416)。中実(null・省略)は `'none'`。 */
function keyThinExtrude(thin: ThinExtrudeKeyMaterial | null): string {
  return thin === null ? 'none' : `thin(${keyNumber(thin.thickness)}|${thin.side})`;
}

/**
 * 押し出しに P5 で足した5欄(FR-415・FR-401・FR-416)の文字列。
 *
 * **既定のときは空文字列を返す**ので、P2 からの押し出しの鍵は1文字も変わらず、
 * 「欄を省略した材料」と「既定を明示した材料」も同じ鍵になる(冒頭の決め 3)。
 * 既定とは「この材料の `distance` ぶんを片側へ、傾きなし、中実、上流なし」で、
 * `createPartDocument.ts` の `extrudeShapingOf` が省略に当てる値と同じである。
 *
 * 1つでも既定から外れたら**5欄すべて**を出す。出す欄を値ごとに選ぶと、
 * 「テーパだけ非既定」と「薄板だけ非既定」が同じ書式で並ばず読み解きにくくなるうえ、
 * 欄の組み合わせによっては文字列が一致しうるためである。
 */
function keyExtrudeExtras(material: ExtrudeKeyMaterial): string {
  const end: ExtrudeEndKeyMaterial = material.end ?? {
    kind: 'distance',
    distance: material.distance,
  };
  const taperAngle = material.taperAngle ?? 0;
  const taperOutward = material.taperOutward ?? false;
  const thin = material.thin ?? null;
  const targetKey = material.targetKey ?? null;
  // 数値の比較は keyNumber に通した文字列で行う(-0 と 0、9桁より下の揺れを既定と見なす)。
  const endIsDefault =
    end.kind === 'distance' && keyNumber(end.distance) === keyNumber(material.distance);
  if (
    endIsDefault &&
    keyNumber(taperAngle) === keyNumber(0) &&
    !taperOutward &&
    thin === null &&
    targetKey === null
  ) {
    return '';
  }
  return (
    `;end=${keyExtrudeEnd(end)}` +
    `;taperAngle=${keyNumber(taperAngle)}` +
    `;taperOutward=${keyBoolean(taperOutward)}` +
    `;thin=${keyThinExtrude(thin)}` +
    `;targetKey=${keyOptionalText(targetKey)}`
  );
}

/** 穴・ねじ穴の入口(FR-422)。種類を先頭に置く。 */
function keyHoleEntry(entry: HoleEntryKeyMaterial): string {
  switch (entry.kind) {
    case 'plain':
      return 'plain';
    case 'counterbore':
      return `counterbore(${keyNumber(entry.diameter)}|${keyNumber(entry.depth)})`;
    case 'countersink':
      // 角度はラジアン(段の依頼 HoleEntrySpec と同じ単位。HoleEntryKeyMaterial の注釈)。
      return `countersink(${keyNumber(entry.diameter)}|${keyNumber(entry.angle)})`;
  }
}

/**
 * 穴・ねじ穴の入口の文字列。**広げない(省略・`plain`)ときは空文字列**を返す。
 * 理由は `keyExtrudeExtras` と同じで、省略と既定を同じ鍵にし、P3 の鍵も壊さないため。
 */
function keyHoleEntryExtra(entry: HoleEntryKeyMaterial | undefined): string {
  if (entry === undefined || entry.kind === 'plain') {
    return '';
  }
  return `;entry=${keyHoleEntry(entry)}`;
}

/**
 * R 面取りの半径(FR-407、FR-426)。
 * 一定半径は P3 と同じ数字列そのままで、可変半径だけ `variable(…)` を出す。
 * `keyNumber` の出力は必ず数字と小数点だけなので、2つが混ざることはない。
 */
function keyFilletRadius(radius: FilletRadiusKeyMaterial): string {
  return typeof radius === 'number'
    ? keyNumber(radius)
    : `variable(${keyNumber(radius.start)}|${keyNumber(radius.end)})`;
}

/** 曲面の作り方(FR-428)。種類を先頭に置くので、種類が違えば必ず別の文字列になる。 */
function keySurfaceShape(shape: SurfaceShapeKeyMaterial): string {
  switch (shape.kind) {
    case 'extrude':
      return (
        `extrude(${keyCurveList(shape.profile)}|${keyVec3(shape.direction)}` +
        `|${keyNumber(shape.distance)})`
      );
    case 'revolve':
      return (
        `revolve(${keyCurveList(shape.profile)}|${keyVec3(shape.axisOrigin)}` +
        `|${keyVec3(shape.axisDirection)}|${keyNumber(shape.angle)})`
      );
    case 'planar':
      return `planar(${keyCurveList(shape.profile)})`;
    case 'loft':
      return `loft(${keyCurveListGroup(shape.sections)}|${keyBoolean(shape.ruled)})`;
    case 'face':
      return `face(${shape.face})`;
    case 'offset':
      return `offset(${shape.face}|${keyNumber(shape.distance)})`;
  }
}

/**
 * 鍵の材料を、`hash64` に渡す前の1本の文字列にする。
 * 段の種類(先頭のキーワード)と各配列の長さを混ぜてあるので、
 * 違う種類・違う個数の入力が同じ文字列になることはない。
 */
export function keyMaterialText(material: SolidStepKeyMaterial): string {
  switch (material.kind) {
    case 'extrude':
      // P5 で足した5欄は既定なら出さない(keyExtrudeExtras の注釈、冒頭の決め 3)。
      return (
        `extrude{profile=${keyCurveList(material.profile)}` +
        `;direction=${keyVec3(material.direction)}` +
        `;distance=${keyNumber(material.distance)}` +
        `${keyExtrudeExtras(material)}}`
      );
    case 'revolve':
      return (
        `revolve{profile=${keyCurveList(material.profile)}` +
        `;axisOrigin=${keyVec3(material.axisOrigin)}` +
        `;axisDirection=${keyVec3(material.axisDirection)}` +
        `;angle=${keyNumber(material.angle)}}`
      );
    case 'sew':
      return (
        `sew{profiles=${keyCurveListGroup(material.profiles)}` +
        `;tolerance=${keyNumber(material.tolerance)}}`
      );
    case 'boolean':
      return (
        `boolean{operation=${material.operation}` +
        `;targetKey=${material.targetKey}` +
        `;toolKey=${material.toolKey}}`
      );
    case 'hole':
      return (
        `hole{targetKey=${material.targetKey}` +
        `;face=${material.face}` +
        `;centers=${keyVec3List(material.centers)}` +
        `;diameter=${keyNumber(material.diameter)}` +
        `;depth=${keyOptionalNumber(material.depth)}` +
        `;tiltAngle=${keyNumber(material.tiltAngle)}` +
        `;tiltAzimuth=${keyNumber(material.tiltAzimuth)}` +
        `;transforms=${keyTransformList(material.transforms)}` +
        `${keyHoleEntryExtra(material.entry)}}`
      );
    case 'thread':
      return (
        `thread{targetKey=${material.targetKey}` +
        `;face=${material.face}` +
        `;centers=${keyVec3List(material.centers)}` +
        `;drillDiameter=${keyNumber(material.drillDiameter)}` +
        `;majorDiameter=${keyNumber(material.majorDiameter)}` +
        `;pitch=${keyNumber(material.pitch)}` +
        `;threadLength=${keyNumber(material.threadLength)}` +
        `;depth=${keyOptionalNumber(material.depth)}` +
        `;modeled=${keyBoolean(material.modeled)}` +
        `;tiltAngle=${keyNumber(material.tiltAngle)}` +
        `;tiltAzimuth=${keyNumber(material.tiltAzimuth)}` +
        `;transforms=${keyTransformList(material.transforms)}` +
        `${keyHoleEntryExtra(material.entry)}}`
      );
    case 'fillet':
      return (
        `fillet{targetKey=${material.targetKey}` +
        `;targets=${keySubShapeList(material.targets)}` +
        `;radius=${keyFilletRadius(material.radius)}}`
      );
    case 'chamfer':
      return (
        `chamfer{targetKey=${material.targetKey}` +
        `;targets=${keySubShapeList(material.targets)}` +
        `;mode=${material.mode}` +
        `;distance1=${keyNumber(material.distance1)}` +
        `;distance2=${keyNumber(material.distance2)}` +
        `;swapReferenceFace=${keyBoolean(material.swapReferenceFace)}}`
      );
    case 'spring':
      // 全長(length)と derived は混ぜない(SpringKeyMaterial の注釈を参照)。
      return (
        `spring{origin=${keyVec3(material.origin)}` +
        `;direction=${keyVec3(material.direction)}` +
        `;coilDiameter=${keyNumber(material.coilDiameter)}` +
        `;wireDiameter=${keyNumber(material.wireDiameter)}` +
        `;pitch=${keyNumber(material.pitch)}` +
        `;turns=${keyNumber(material.turns)}` +
        `;handedness=${material.handedness}}`
      );
    case 'primitive':
      // originQuery と targetKey を必ず混ぜる(PrimitiveKeyMaterial の注釈を参照)。
      return (
        `primitive{shape=${keyPrimitiveShape(material.shape)}` +
        `;origin=${keyVec3(material.origin)}` +
        `;axis=${keyVec3(material.axis)}` +
        `;originQuery=${keyOptionalText(material.originQuery)}` +
        `;targetKey=${keyOptionalText(material.targetKey)}}`
      );
    case 'thruSections':
      // 断面の輪郭の数値・球の中心と半径・立体の面の鍵と指紋をすべて混ぜる
      // (ThruSectionsKeyMaterial の注釈、NFR-PF-3)。
      return (
        `thruSections{sections=${keyThruSectionList(material.sections)}` +
        `;ruled=${keyBoolean(material.ruled)}` +
        `;closed=${keyBoolean(material.closed)}` +
        `;twist=${keyNumber(material.twist)}` +
        `;sphereSegments=${keyNumber(material.sphereSegments)}}`
      );
    case 'draft':
      return (
        `draft{targetKey=${material.targetKey}` +
        `;faces=${keySubShapeList(material.faces)}` +
        `;neutralFace=${material.neutralFace}` +
        `;angle=${keyNumber(material.angle)}` +
        `;reversed=${keyBoolean(material.reversed)}}`
      );
    case 'mirror':
      // 対象を消費しないが targetKey を混ぜる(MirrorKeyMaterial の注釈、NFR-PF-3)。
      return (
        `mirror{targetKey=${material.targetKey}` +
        `;origin=${keyVec3(material.origin)}` +
        `;normal=${keyVec3(material.normal)}}`
      );
    case 'transform':
      return (
        `transform{targetKey=${material.targetKey}` +
        `;translation=${keyVec3(material.translation)}` +
        `;rotationOrigin=${keyVec3(material.rotationOrigin)}` +
        `;rotationAxis=${keyVec3(material.rotationAxis)}` +
        `;rotationAngle=${keyNumber(material.rotationAngle)}}`
      );
    case 'scale':
      return (
        `scale{targetKey=${material.targetKey}` +
        `;origin=${keyVec3(material.origin)}` +
        `;uniform=${keyOptionalNumber(material.uniform)}` +
        `;perAxis=${keyOptionalVec3(material.perAxis)}}`
      );
    case 'sweep':
      return (
        `sweep{profile=${keyCurveList(material.profile)}` +
        `;path=${keyCurveList(material.path)}` +
        `;frenet=${keyBoolean(material.frenet)}}`
      );
    case 'rib':
      return (
        `rib{targetKey=${material.targetKey}` +
        `;profile=${keyCurveList(material.profile)}` +
        `;normal=${keyVec3(material.normal)}` +
        `;thickness=${keyNumber(material.thickness)}` +
        `;symmetric=${keyBoolean(material.symmetric)}` +
        `;direction=${keyVec3(material.direction)}}`
      );
    case 'emboss':
      return (
        `emboss{targetKey=${material.targetKey}` +
        `;face=${material.face}` +
        `;profiles=${keyCurveListGroup(material.profiles)}` +
        `;depth=${keyNumber(material.depth)}` +
        `;raised=${keyBoolean(material.raised)}}`
      );
    case 'threadShaft':
      return (
        `threadShaft{targetKey=${material.targetKey}` +
        `;face=${material.face}` +
        `;majorDiameter=${keyNumber(material.majorDiameter)}` +
        `;pitch=${keyNumber(material.pitch)}` +
        `;length=${keyNumber(material.length)}` +
        `;fromEnd=${material.fromEnd}` +
        `;modeled=${keyBoolean(material.modeled)}}`
      );
    case 'surface':
      // 面を借りる作り方でも消費しないが targetKey を混ぜる(SurfaceKeyMaterial の注釈)。
      return (
        `surface{shape=${keySurfaceShape(material.shape)}` +
        `;targetKey=${keyOptionalText(material.targetKey)}}`
      );
    case 'cut':
      return (
        `cut{targetKey=${material.targetKey}` +
        `;origin=${keyVec3(material.origin)}` +
        `;normal=${keyVec3(material.normal)}` +
        `;keepPositive=${keyBoolean(material.keepPositive)}}`
      );
    case 'shell':
      return (
        `shell{targetKey=${material.targetKey}` +
        `;openFaces=${keySubShapeList(material.openFaces)}` +
        `;thickness=${keyNumber(material.thickness)}` +
        `;outward=${keyBoolean(material.outward)}}`
      );
  }
}

/**
 * 1段ぶんの鍵(§0.a-0.20)。名前・抑制・色は材料に含めない(形が変わらないため)。
 * ブーリアンの材料は上流の鍵(`targetKey` / `toolKey`)を含むので、上流が変われば
 * この鍵も必ず変わる(鍵の連鎖、NFR-PF-3)。加工フィーチャー(穴・ねじ穴・R 面取り・
 * C 面取り)も同じく `targetKey` を含むので、連鎖は同じように効く。ばねは上流を取らない
 * ので `targetKey` を持たない(§0.a-0.36)。基本形状は普段は上流を取らないが、基準点に
 * 立体の頂点を指したときだけ `targetKey` を持つ(消費はしない。P5 §0.a-0.18 / §0.a-0.19)。
 *
 * P5 の Should 群・Could 群(タスク44)も同じ規律で、**上流を指すものは消費してもしなくても
 * `targetKey` を混ぜる**(ミラー・曲面の `face`・押し出しの「次の面まで」が「消費しないが
 * 混ぜる」側)。対象を取らない「作る」段(スイープ)だけが `targetKey` を持たない。
 */
export function cacheKeyFor(step: SolidStepKeyMaterial): string {
  return hash64(keyMaterialText(step));
}
