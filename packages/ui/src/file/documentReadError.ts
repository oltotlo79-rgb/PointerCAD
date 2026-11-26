import type { ReadPcadFileError, ReadPcadFileErrorCode } from '@pointercad/io';
import { MAX_SUB_ASSEMBLY_DEPTH } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/**
 * `.pcad` を読めなかった理由と、利用者へ見せる文言の対応(NFR-UX-5)。
 *
 * `packages/io` は理由ごとに日本語の文も持っているが、画面へ出す文言は ja.json に
 * まとめる決まりなので(NFR-MA-5)、ここで対応づけ直す。`Record` で全部の理由を
 * 書かせているので、`packages/io` が理由を増やしたら型検査で気づける。
 */
const OPEN_ERROR_KEYS: Readonly<Record<ReadPcadFileErrorCode, MessageKey>> = {
  // ZIP として開けない。中身を見る手前で壊れている。
  notZip: 'file.error.corrupted',
  archiveExpansionLimit: 'file.error.archiveExpansionLimit',
  // ZIP ではあるが、部品の中身が入っていない。
  missingDocument: 'file.error.missingDocument',
  // 中身が JSON として読めない。
  invalidJson: 'file.error.corrupted',
  // PointerCAD の封筒になっていない(他のアプリのファイル)。
  notPcad: 'file.error.wrongKind',
  // PointerCAD のファイルだが、部品ではない(アセンブリ・図面)。
  unsupportedKind: 'file.error.wrongKind',
  unsupportedOldVersion: 'file.error.tooOld',
  unsupportedNewVersion: 'file.error.tooNew',
  // 版の記録が食い違う・欄が足りない・型が違うのは、いずれも中身の壊れ。
  versionMismatch: 'file.error.corrupted',
  missingField: 'file.error.corrupted',
  invalidField: 'file.error.corrupted',
  // 抱き込んだ組の入れ子が自分自身を含む・深すぎる(組を解く時と同じ文。assembly.json)。
  subAssemblyCycle: 'assembly.error.subAssemblyCycle',
  subAssemblyDepth: 'assembly.error.subAssemblyDepth',
};

/** 文に差し込む値(差し込みの無い理由は持たない)。 */
const ARCHIVE_DIAGNOSTIC_KEYS: Readonly<Record<NonNullable<ReadPcadFileError['diagnostic']>, MessageKey>> = {
  embeddedDocument: 'file.error.embeddedDocument',
  partAttachmentInvalid: 'file.error.partAttachmentInvalid',
  partAttachmentMissing: 'file.error.partAttachmentMissing',
  partAttachmentDigestMissing: 'file.error.partAttachmentDigestMissing',
  partAttachmentDigestMismatch: 'file.error.partAttachmentDigestMismatch',
};

const OPEN_ERROR_PARAMETERS: Partial<Readonly<Record<ReadPcadFileErrorCode, Readonly<Record<string, string>>>>> = {
  subAssemblyDepth: { max: String(MAX_SUB_ASSEMBLY_DEPTH) },
};

/**
 * 読めなかった理由を利用者へ見せる文言のキーへ直す。
 *
 * ひな形(`.pcadt`)も同じ封筒を読む(`file/templateFile.ts`)ので、上の表を**写さずに**
 * 使えるようにここへ 1 つだけ口を開けてある。表そのものは外へ出さない(理由と文言の
 * 対応を書き換える場所を 1 か所に閉じるため)。
 */
export function openErrorMessageKey(error: ReadPcadFileErrorCode | ReadPcadFileError): MessageKey {
  return openErrorMessage(error).key;
}

/**
 * 読めなかった理由を、文の鍵と差し込む値の組にする(画面の知らせ FileMessage へ広げて渡せる形)。差し込む値のある理由(入れ子の深さ)が
 * 出うる読み取り(アセンブリ・図面の出どころ・自動保存の控え)は、鍵だけの openErrorMessageKey でなく、この口を使う。
 */
export function openErrorMessage(error: ReadPcadFileErrorCode | ReadPcadFileError): { readonly key: MessageKey; readonly parameters?: Readonly<Record<string, string>> } {
  const code = typeof error === 'string' ? error : error.code;
  const diagnostic = typeof error === 'string' ? undefined : error.diagnostic;
  if (typeof error !== 'string' && import.meta.env.DEV
    && (diagnostic !== undefined || code === 'missingField' || code === 'invalidField')) {
    console.error('PointerCAD document read', error);
  }
  const key = diagnostic === undefined ? OPEN_ERROR_KEYS[code] : ARCHIVE_DIAGNOSTIC_KEYS[diagnostic];
  const parameters = OPEN_ERROR_PARAMETERS[code];
  return parameters === undefined ? { key } : { key, parameters };
}

/** 復元できない理由の案内(RestorePrompt の reasonKey・reasonParameters)へ広げて渡せる形。 */
export function openErrorReason(error: ReadPcadFileErrorCode | ReadPcadFileError): { readonly reasonKey: MessageKey; readonly reasonParameters?: Readonly<Record<string, string>> } {
  const { key, parameters } = openErrorMessage(error);
  return parameters === undefined ? { reasonKey: key } : { reasonKey: key, reasonParameters: parameters };
}
