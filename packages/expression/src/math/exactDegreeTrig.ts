/** Only exactly represented integer multiples of 90 degrees grant exact quadrant values. */
export function exactDegreeTrig(value: number, degree: boolean): { readonly sin: number; readonly cos: number } | null {
  if (!degree || !Number.isSafeInteger(value)) return null;
  const integer = BigInt(value);
  if (integer % 90n !== 0n) return null;
  const quadrant = Number(((integer / 90n) % 4n + 4n) % 4n);
  return { sin: [0,1,0,-1][quadrant], cos: [1,0,-1,0][quadrant] };
}
