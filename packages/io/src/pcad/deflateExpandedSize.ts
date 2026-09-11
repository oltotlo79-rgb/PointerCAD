/** R06: 出力バイトを生成せずraw DEFLATEの展開長を検査する。
 * 形式の根拠: https://www.rfc-editor.org/rfc/rfc1951.html §3.2。
 * 入力全体と固定上限のHuffman表だけを読む。展開サイズに比例する確保は行わない。 */
export class DeflateSizeError extends Error {
  constructor(readonly kind: 'invalidDeflate' | 'expandedLimit') { super(kind); }
}
class Bits {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  peek(count: number): number {
    const offset = Math.floor(this.position / 8), shift = this.position % 8;
    const word = (this.bytes[offset] ?? 0) | ((this.bytes[offset + 1] ?? 0) << 8) | ((this.bytes[offset + 2] ?? 0) << 16);
    return (word >>> shift) & ((1 << count) - 1);
  }
  read(count: number): number {
    if (this.position + count > this.bytes.length * 8) throw new DeflateSizeError('invalidDeflate');
    const value = this.peek(count); this.position += count; return value;
  }
  skipBytes(count: number): void {
    if (this.position % 8 !== 0 || this.position + count * 8 > this.bytes.length * 8) throw new DeflateSizeError('invalidDeflate');
    this.position += count * 8;
  }
  align(): void { this.position = Math.ceil(this.position / 8) * 8; }
}
interface Huffman { readonly lookup: Uint16Array; readonly width: number }
function huffman(lengths: readonly number[], mode: 'codes' | 'literals' | 'distances'): Huffman {
  const counts = new Uint16Array(16);
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 15) throw new DeflateSizeError('invalidDeflate');
    if (length !== 0) counts[length]++;
  }
  let width = 15; while (width > 0 && counts[width] === 0) width--;
  // 空の距離表は、ブロックがliteralだけで構成される場合に限り未使用のまま許される。
  if (width === 0) {
    if (mode !== 'distances') throw new DeflateSizeError('invalidDeflate');
    return { lookup: new Uint16Array(1), width: 1 };
  }
  let unused = 1;
  for (let length = 1; length <= 15; length++) {
    unused = unused * 2 - counts[length];
    if (unused < 0) throw new DeflateSizeError('invalidDeflate');
  }
  if (unused !== 0 && (mode === 'codes' || width !== 1)) throw new DeflateSizeError('invalidDeflate');
  const next = new Uint16Array(16); let code = 0;
  for (let length = 1; length <= 15; length++) { code = (code + counts[length - 1]) * 2; next[length] = code; }
  const lookup = new Uint16Array(1 << width);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]; if (length === 0) continue;
    let canonical = next[length]++, reversed = 0;
    for (let bit = 0; bit < length; bit++) { reversed = (reversed << 1) | (canonical & 1); canonical >>>= 1; }
    for (let prefix = reversed; prefix < lookup.length; prefix += 1 << length) lookup[prefix] = (symbol << 4) | length;
  }
  return { lookup, width };
}
function symbol(bits: Bits, table: Huffman): number {
  const entry = table.lookup[bits.peek(table.width)], length = entry & 15;
  if (length === 0) throw new DeflateSizeError('invalidDeflate');
  bits.read(length); return entry >>> 4;
}
const FIXED_LITERALS = huffman(Array.from({ length: 288 }, (_, index) => index < 144 ? 8 : index < 256 ? 9 : index < 280 ? 7 : 8), 'literals');
const FIXED_DISTANCES = huffman(Array<number>(32).fill(5), 'distances');
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function dynamicTables(bits: Bits): readonly [Huffman, Huffman] {
  const literals = bits.read(5) + 257, distances = bits.read(5) + 1, codeCount = bits.read(4) + 4;
  if (literals > 286) throw new DeflateSizeError('invalidDeflate');
  const codeLengths = Array<number>(19).fill(0);
  for (let i = 0; i < codeCount; i++) codeLengths[CODE_ORDER[i]] = bits.read(3);
  const codeTable = huffman(codeLengths, 'codes'), lengths: number[] = [];
  while (lengths.length < literals + distances) {
    const value = symbol(bits, codeTable);
    if (value < 16) { lengths.push(value); continue; }
    if (value === 16 && lengths.length === 0) throw new DeflateSizeError('invalidDeflate');
    const repeated = value === 16 ? lengths[lengths.length - 1] : 0;
    const count = value === 16 ? bits.read(2) + 3 : value === 17 ? bits.read(3) + 3 : bits.read(7) + 11;
    if (lengths.length + count > literals + distances) throw new DeflateSizeError('invalidDeflate');
    for (let i = 0; i < count; i++) lengths.push(repeated);
  }
  if (lengths[256] === 0) throw new DeflateSizeError('invalidDeflate');
  return [huffman(lengths.slice(0, literals), 'literals'), huffman(lengths.slice(literals), 'distances')];
}

/** 予算を超えるlength/literalを読んだ時点で止める。重複文字列をメモリー上へ生成しない。 */
export function deflateExpandedSize(data: Uint8Array, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new DeflateSizeError('expandedLimit');
  const bits = new Bits(data); let expanded = 0; let final: boolean;
  const append = (count: number): void => {
    if (count > maximum - expanded) throw new DeflateSizeError('expandedLimit');
    expanded += count;
  };
  do {
    final = bits.read(1) === 1; const type = bits.read(2);
    if (type === 0) {
      bits.align(); const length = bits.read(16), complement = bits.read(16);
      if ((length ^ complement) !== 65535) throw new DeflateSizeError('invalidDeflate');
      append(length); bits.skipBytes(length); continue;
    }
    if (type === 3) throw new DeflateSizeError('invalidDeflate');
    const [literals, distances] = type === 1 ? [FIXED_LITERALS, FIXED_DISTANCES] : dynamicTables(bits);
    for (;;) {
      const item = symbol(bits, literals);
      if (item < 256) { append(1); continue; }
      if (item === 256) break;
      if (item > 285) throw new DeflateSizeError('invalidDeflate');
      const index = item - 257, length = LENGTH_BASE[index] + bits.read(LENGTH_BITS[index]);
      const distanceCode = symbol(bits, distances);
      if (distanceCode > 29) throw new DeflateSizeError('invalidDeflate');
      const distance = DISTANCE_BASE[distanceCode] + bits.read(DISTANCE_BITS[distanceCode]);
      if (distance > expanded) throw new DeflateSizeError('invalidDeflate');
      append(length);
    }
  } while (!final);
  if (Math.ceil(bits.position / 8) !== data.length) throw new DeflateSizeError('invalidDeflate');
  return expanded;
}
