/**
 * OCCT を読み込まない純粋な組の算術。kernel の中の呼出し側(`occt/placeBodies.ts`・`occt/sphereTangent.ts`)は
 * 相対の import で読み、model は明示の subpath `@pointercad/kernel/math/vector-arithmetic` だけを通して読む
 * (`sketch/vec3.ts` が出し直す)。UI は model の `@pointercad/model/vec3` から読み、kernel を直接読まない。
 *
 * このファイルは何も import しない。kernel の index・OCCT・Worker を読み込む経路を作らないためで、
 * model の `beam-analysis` の入口から読まれても OCCT の初期化は起きない。
 * 組は `readonly` の数の組で受け、kernel の `Vec3Tuple`・`QuaternionTuple` と model の `Vec3`・`Quaternion` の
 * どちらもそのまま渡せる(同じ形)。
 */

/** 四元数の 4 成分がすべて有限か(NaN・∞ を含まないか)。長さや正規化は確かめない。 */
export function isFiniteQuaternion(value: readonly [number, number, number, number]): boolean {
  return (
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2]) &&
    Number.isFinite(value[3])
  );
}

/** base + direction × distance(成分ごと)。点を向きに沿って決まった長さだけ進めた位置。 */
export function addScaled(
  base: readonly [number, number, number],
  direction: readonly [number, number, number],
  distance: number,
): readonly [number, number, number] {
  return [
    base[0] + direction[0] * distance,
    base[1] + direction[1] * distance,
    base[2] + direction[2] * distance,
  ];
}
