/** R10: ZIPの偶発的破損を検出するCRC-32。真正性の署名ではない。 */
const table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
  return value >>> 0;
});
export function zipCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  // 添字で回す(反復子の for...of より約3倍速い。40MiB で 527ms → 195ms の実測。R06)。
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value >>> 8) ^ table[(value ^ bytes[index]) & 0xff];
  }
  return (value ^ 0xffffffff) >>> 0;
}
