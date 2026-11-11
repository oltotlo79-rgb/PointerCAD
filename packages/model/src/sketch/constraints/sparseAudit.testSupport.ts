/** Test-only binary arithmetic: products and cancellation happen before conversion to double. */
export function auditExactSum(terms: readonly (readonly number[])[]): number {
  const view = new DataView(new ArrayBuffer(8));
  const products: { integer: bigint; exponent: number }[] = [];
  let leastExponent = Infinity;
  for (const factors of terms) {
    let integer = 1n, exponent = 0;
    for (const factor of factors) {
      if (!Number.isFinite(factor)) throw new Error('Nonfinite audit factor');
      view.setFloat64(0, factor);
      const bits = view.getBigUint64(0), biased = Number((bits >> 52n) & 2047n);
      const fraction = bits & ((1n << 52n) - 1n);
      integer *= (bits >> 63n ? -1n : 1n) * (biased === 0 ? fraction : fraction + (1n << 52n));
      exponent += biased === 0 ? -1074 : biased - 1075;
    }
    if (integer !== 0n) {
      products.push({ integer, exponent });
      leastExponent = Math.min(leastExponent, exponent);
    }
  }
  if (products.length === 0) return 0;
  let integer = 0n;
  for (const product of products) integer += product.integer << BigInt(product.exponent - leastExponent);
  // These fixtures use bounded normal doubles; reject unsupported conversion ranges.
  const result = Number(integer) * 2 ** leastExponent;
  if (!Number.isFinite(result) || (result === 0 && integer !== 0n)) throw new Error('Audit conversion range');
  return result;
}
