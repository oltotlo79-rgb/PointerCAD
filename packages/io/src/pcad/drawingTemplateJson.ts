import { createDrawingTemplate, validateDrawingTemplate, type DrawingTemplate } from '@pointercad/model';
import { cleanSheet, isLayer, isSheet, parseDrawing } from './drawingJson.js';
import { hasOnlyFiniteJsonNumbers, preserveDrawingJsonFields } from './drawingJsonCompatibility.js';
import { isRecord, isUnknownArray } from './guards.js';
import { PCAD_APP_NAME, PCAD_DRAWING_TEMPLATE_KIND, PCAD_SCHEMA_VERSION } from './schema.js';

export type ParseDrawingTemplateResult =
  | { readonly ok: true; readonly template: DrawingTemplate; readonly savedAt: string }
  | { readonly ok: false; readonly error: { readonly code: 'invalidJson' | 'invalidTemplate' | 'unsupportedKind' | 'unsupportedVersion'; readonly message: string } };

function failure(code: Extract<ParseDrawingTemplateResult, { readonly ok: false }>['error']['code']): ParseDrawingTemplateResult {
  return { ok: false, error: { code, message: code === 'unsupportedKind'
    ? '図面用のひな形ではありません。図面用の .pcadt ファイルを選んでください。'
    : code === 'unsupportedVersion' ? '対応していない版の図面ひな形です。'
      : '図面ひな形の中身を読み取れませんでした。' } };
}

export function serializeDrawingTemplate(template: DrawingTemplate, savedAt: string): string {
  const checked = validateDrawingTemplate(template);
  if (!checked.ok || !hasOnlyFiniteJsonNumbers(template)) throw new Error('図面ひな形の設定に誤りがあるため保存できません。');
  const clean: DrawingTemplate = { name: template.name, sheet: preserveDrawingJsonFields(template.sheet, cleanSheet(template.sheet)),
    layers: template.layers.map((layer) => ({ ...layer })) };
  return `${JSON.stringify({ schema: PCAD_SCHEMA_VERSION, kind: PCAD_DRAWING_TEMPLATE_KIND, app: PCAD_APP_NAME, savedAt, template: clean }, null, 2)}\n`;
}

export function parseDrawingTemplate(text: string): ParseDrawingTemplateResult {
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch { return failure('invalidJson'); }
  if (!isRecord(raw) || raw['app'] !== PCAD_APP_NAME) return failure('invalidTemplate');
  if (raw['kind'] !== PCAD_DRAWING_TEMPLATE_KIND) return failure('unsupportedKind');
  if (typeof raw['schema'] !== 'number' || !Number.isInteger(raw['schema']) || raw['schema'] < 2 || raw['schema'] > PCAD_SCHEMA_VERSION) return failure('unsupportedVersion');
  if (!hasOnlyFiniteJsonNumbers(raw) || typeof raw['savedAt'] !== 'string') return failure('invalidTemplate');
  if (raw['template'] === undefined && isRecord(raw['document'])) {
    // 旧drawingTemplateは図面文書全体を持つ。設定だけを取り出し、元モデルや図を引き継がない。
    const legacy = parseDrawing(text);
    if (!legacy.ok || legacy.kind !== PCAD_DRAWING_TEMPLATE_KIND) return failure('invalidTemplate');
    const converted = createDrawingTemplate(legacy.document, legacy.document.name);
    return converted.ok ? { ok: true, template: converted.template, savedAt: legacy.savedAt } : failure('invalidTemplate');
  }
  if (raw['schema'] !== PCAD_SCHEMA_VERSION) return failure('unsupportedVersion');
  const value = raw['template'];
  if (!isRecord(value) || typeof value['name'] !== 'string' || !isSheet(value['sheet'])
    || !isUnknownArray(value['layers']) || !value['layers'].every(isLayer)) return failure('invalidTemplate');
  const template: DrawingTemplate = { name: value['name'], sheet: preserveDrawingJsonFields(value['sheet'], cleanSheet(value['sheet'])),
    layers: value['layers'].map((layer) => ({ ...layer })) };
  const checked = validateDrawingTemplate(template);
  return checked.ok ? { ok: true, template, savedAt: raw['savedAt'] } : failure('invalidTemplate');
}
