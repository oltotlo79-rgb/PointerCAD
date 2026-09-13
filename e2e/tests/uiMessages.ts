import { readFileSync } from 'node:fs';

const catalogs = new Map<string, unknown>();
/** Read the product's labels without Node-version-dependent JSON module imports. */
export function uiMessage(catalog: string, key: string): string {
  if (!/^[a-z][a-zA-Z-]*$/u.test(catalog)) throw new Error(`Invalid UI catalog: ${catalog}`);
  if (!catalogs.has(catalog)) catalogs.set(catalog, JSON.parse(readFileSync(
    new URL(`../../packages/ui/src/i18n/ja/${catalog}.json`, import.meta.url), 'utf8')));
  const messages = catalogs.get(catalog);
  const value: unknown = typeof messages === 'object' && messages !== null ? Reflect.get(messages, key) : undefined;
  if (typeof value !== 'string' || /\?{2,}|\uFFFD/u.test(value)) throw new Error(`操作ラベルが未登録または破損: ${catalog}/${key}`);
  return value;
}
