/** R10: ZIPの偶発的破損を検出するCRC-32。真正性の署名ではない。 */
const table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
  return value >>> 0;
});
// Slice n is the CRC contribution after n further zero bytes. Combining eight
// independent contributions removes the per-byte dependency without skipping bits.
const slices = [table];
for (let slice = 1; slice < 8; slice += 1) {
  const previous = slices[slice - 1];
  slices.push(Uint32Array.from(previous, value => (value >>> 8) ^ table[value & 0xff]));
}
const [t0, t1, t2, t3, t4, t5, t6, t7] = slices;
export function zipCrc32(bytes: Uint8Array): number {
  return finishZipCrc32(updateZipCrc32(startZipCrc32(), bytes));
}

/** 区切って計算する時の最初の途中値(大きい項目を区切って圧縮する `zipSteps.ts` 用。R06)。 */
export function startZipCrc32(): number {
  return 0xffffffff;
}

/** 途中値へ続きのバイト列を足す。区切り方によらず、一括の `zipCrc32` と同じ値になる。 */
export function updateZipCrc32(running: number, bytes: Uint8Array): number {
  let value = running;
  let index = 0;
  for (; index + 8 <= bytes.length; index += 8) {
    const first = value ^ bytes[index] ^ (bytes[index + 1] << 8)
      ^ (bytes[index + 2] << 16) ^ (bytes[index + 3] << 24);
    value = t7[first & 0xff] ^ t6[(first >>> 8) & 0xff]
      ^ t5[(first >>> 16) & 0xff] ^ t4[first >>> 24]
      ^ t3[bytes[index + 4]] ^ t2[bytes[index + 5]]
      ^ t1[bytes[index + 6]] ^ t0[bytes[index + 7]];
  }
  // Exact original recurrence for the remaining zero to seven bytes.
  for (; index < bytes.length; index += 1) {
    value = (value >>> 8) ^ table[(value ^ bytes[index]) & 0xff];
  }
  return value;
}

/** 途中値から CRC-32 を確定する。 */
export function finishZipCrc32(running: number): number {
  return (running ^ 0xffffffff) >>> 0;
}
