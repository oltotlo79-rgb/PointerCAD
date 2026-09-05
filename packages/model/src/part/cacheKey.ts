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

/** 押し出し(FR-401)の鍵の材料。断面+向き+長さ(平行移動と反転は model 側で計算済み、§0.a-0.8)。 */
export interface ExtrudeKeyMaterial {
  readonly kind: 'extrude';
  readonly profile: readonly KeyCurve[];
  readonly direction: KeyVec3;
  readonly distance: number;
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
  readonly transforms: readonly KeyTransform[];
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
  readonly transforms: readonly KeyTransform[];
}

/**
 * R 面取り(FR-407)の鍵の材料。
 * `targets` は辺・頂点の指紋の並びで、**並びが違えば違う鍵**になる。
 * そのため **model は必ず通し番号の昇順に並べてから渡す**(タスク16 の `planFillet`)。
 * 同じ辺の集合を選んだのに選んだ順で鍵が変わると、キャッシュが当たらなくなるため。
 */
export interface FilletKeyMaterial {
  readonly kind: 'fillet';
  readonly targetKey: string;
  readonly targets: readonly KeySubShape[];
  readonly radius: number;
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

/**
 * 1段ぶんの鍵の材料。段の種類ごとに要る値だけを持つ。
 * パターン(FR-411 / FR-412)の材料はここに無い。パターンはもとの穴・ねじ穴の材料の
 * `targetKey` と `transforms` を差し替えたものとして表すため(§0.a-0.20)。
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
  | ThruSectionsKeyMaterial;

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

/**
 * 鍵の材料を、`hash64` に渡す前の1本の文字列にする。
 * 段の種類(先頭のキーワード)と各配列の長さを混ぜてあるので、
 * 違う種類・違う個数の入力が同じ文字列になることはない。
 */
export function keyMaterialText(material: SolidStepKeyMaterial): string {
  switch (material.kind) {
    case 'extrude':
      return (
        `extrude{profile=${keyCurveList(material.profile)}` +
        `;direction=${keyVec3(material.direction)}` +
        `;distance=${keyNumber(material.distance)}}`
      );
    case 'revolve':
      return (
        `revolve{profile=${keyCurveList(material.profile)}` +
        `;axisOrigin=${keyVec3(material.axisOrigin)}` +
        `;axisDirection=${keyVec3(material.axisDirection)}` +
        `;angle=${keyNumber(material.angle)}}`
      );
    case 'sew': {
      const profiles = material.profiles.map(keyCurveList).join(',');
      return (
        `sew{profiles=${material.profiles.length}:[${profiles}]` +
        `;tolerance=${keyNumber(material.tolerance)}}`
      );
    }
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
        `;transforms=${keyTransformList(material.transforms)}}`
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
        `;transforms=${keyTransformList(material.transforms)}}`
      );
    case 'fillet':
      return (
        `fillet{targetKey=${material.targetKey}` +
        `;targets=${keySubShapeList(material.targets)}` +
        `;radius=${keyNumber(material.radius)}}`
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
  }
}

/**
 * 1段ぶんの鍵(§0.a-0.20)。名前・抑制・色は材料に含めない(形が変わらないため)。
 * ブーリアンの材料は上流の鍵(`targetKey` / `toolKey`)を含むので、上流が変われば
 * この鍵も必ず変わる(鍵の連鎖、NFR-PF-3)。加工フィーチャー(穴・ねじ穴・R 面取り・
 * C 面取り)も同じく `targetKey` を含むので、連鎖は同じように効く。ばねは上流を取らない
 * ので `targetKey` を持たない(§0.a-0.36)。基本形状は普段は上流を取らないが、基準点に
 * 立体の頂点を指したときだけ `targetKey` を持つ(消費はしない。P5 §0.a-0.18 / §0.a-0.19)。
 */
export function cacheKeyFor(step: SolidStepKeyMaterial): string {
  return hash64(keyMaterialText(step));
}
