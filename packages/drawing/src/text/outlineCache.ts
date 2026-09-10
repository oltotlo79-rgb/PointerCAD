import type { OutlinedText } from './fontStore.js';

/** 字体の同じ実測結果だけを保持する。文書数や異なる注記数に比例して増やさない。 */
export function createOutlineCache() {
  const entries = new Map<string, { readonly outline: OutlinedText; readonly commands: number; readonly characters: number }>();
  let commands = 0, characters = 0;
  // 1命令は最大3点。メモリーを占める輪郭命令とキー文字列を件数と別々に制限する。
  const maximumEntries = 256, maximumCommands = 32_768, maximumCharacters = 16_384;
  return {
    get(text: string, sizeMm: number): OutlinedText | undefined {
      const key = `${sizeMm}:${text}`, entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key); entries.set(key, entry);
      return entry.outline;
    },
    put(text: string, sizeMm: number, outline: OutlinedText): void {
      if (outline.status !== 'ready' || outline.metrics === null) return;
      const count = outline.subpaths.reduce((sum, path) => sum + path.commands.length, 0);
      if (count > maximumCommands || text.length > maximumCharacters) return;
      const key = `${sizeMm}:${text}`, previous = entries.get(key);
      if (previous !== undefined) {
        commands -= previous.commands; characters -= previous.characters; entries.delete(key);
      }
      while (entries.size >= maximumEntries || commands + count > maximumCommands || characters + text.length > maximumCharacters) {
        const first = entries.entries().next().value;
        if (first === undefined) break;
        commands -= first[1].commands; characters -= first[1].characters; entries.delete(first[0]);
      }
      entries.set(key, { outline, commands: count, characters: text.length });
      commands += count; characters += text.length;
    },
  };
}
