type Vector3 = readonly [number, number, number];
type Vector6 = readonly [number, number, number, number, number, number];

/** The parts of a static solid result that the summary reads (a computed result or a saved one). */
interface SummaryFields {
  readonly displacementMm: readonly Vector3[];
  readonly reactionN: readonly Vector3[];
  readonly elements: readonly { readonly stressMPa: Vector6 }[];
}

/** Largest displacement, largest von Mises stress and the summed support reaction. The panel's results and the
 * limited view of a saved result use this one formula. */
export function solidResultScalars(result: SummaryFields): {
  readonly maximumDisplacement: number; readonly maximumVonMises: number; readonly reaction: Vector3;
} {
  const maximumDisplacement = result.displacementMm.reduce((maximum, vector) => Math.max(maximum, Math.hypot(...vector)), 0);
  const maximumVonMises = result.elements.reduce((maximum, element) => {
    const [x, y, z, yz, xz, xy] = element.stressMPa;
    return Math.max(maximum, Math.hypot((x - y) / Math.SQRT2, (y - z) / Math.SQRT2,
      (z - x) / Math.SQRT2, Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * xz));
  }, 0);
  const reaction = result.reactionN.reduce<Vector3>((sum, vector) => [sum[0] + vector[0], sum[1] + vector[1], sum[2] + vector[2]],
    [0, 0, 0]);
  return { maximumDisplacement, maximumVonMises, reaction };
}
