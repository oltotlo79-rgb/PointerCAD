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
 * 材料の型はこのファイルの中だけで完結させる(`packages/model/src/index.ts` へは輸出しない
 * 入力型で、タスク11 の `resolvePart.ts` が作る `SolidStepPlan` とは別物にする。
 * 統括の決定: docs/報告記録.md 2026-09-03 07:35 の④「タスク10 は鍵関数の入力型を自ファイルに
 * 置く」)。欄名は `packages/kernel/src/types.ts` の `ExtrudeStepSpec` 等と揃えてあるので、
 * タスク11・12 は解決済みの値をそのままここへ渡せる。
 *
 * BigInt は使わない(1フィーチャーの再計算のたびに何度も呼ばれる経路があり、型と性能の
 * 両方で不利なため)。`Math.imul` で32ビット同士の乗算を正確に(オーバーフローなく)行う。
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

/** 断面・面を作る曲線(kernel の `CurveSpec` と同じ形)。 */
export type KeyCurve = KeySegment | KeyArc;

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

/** 1段ぶんの鍵の材料。段の種類ごとに要る値だけを持つ。 */
export type SolidStepKeyMaterial =
  | ExtrudeKeyMaterial
  | RevolveKeyMaterial
  | SewKeyMaterial
  | BooleanKeyMaterial;

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
  }
}

/** 曲線の並び1本ぶん。順序を保ったまま連結し、長さも混ぜる(衝突対策)。 */
function keyCurveList(curves: readonly KeyCurve[]): string {
  return `${curves.length}:[${curves.map(keyCurve).join(',')}]`;
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
  }
}

/**
 * 1段ぶんの鍵(§0.a-0.20)。名前・抑制・色は材料に含めない(形が変わらないため)。
 * ブーリアンの材料は上流の鍵(`targetKey` / `toolKey`)を含むので、上流が変われば
 * この鍵も必ず変わる(鍵の連鎖、NFR-PF-3)。
 */
export function cacheKeyFor(step: SolidStepKeyMaterial): string {
  return hash64(keyMaterialText(step));
}
