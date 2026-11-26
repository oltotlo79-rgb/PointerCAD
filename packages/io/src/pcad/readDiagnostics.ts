export type ArchiveDocumentDiagnostic =
  | 'embeddedDocument'
  | 'partAttachmentInvalid'
  | 'partAttachmentMissing'
  | 'partAttachmentDigestMissing'
  | 'partAttachmentDigestMismatch';

type ReadDiagnostic = ArchiveDocumentDiagnostic | 'missingField' | 'invalidField'
  | 'drawingTemplateMissingDocument' | 'drawingTemplateInvalidUtf8';

/** Legacy message for API callers and developer records. UI text is selected by the reason code. */
export function readDiagnosticMessage(reason: ReadDiagnostic, path = '', cause = ''): string {
  switch (reason) {
    case 'missingField': case 'partAttachmentMissing': case 'partAttachmentDigestMissing':
      return `ファイルの中身が壊れています(${path} が見つかりません)。`;
    case 'invalidField': case 'partAttachmentInvalid':
      return `ファイルの中身が壊れています(${path} の形が違います)。`;
    case 'embeddedDocument':
      return `抱き込んだ文書を読めませんでした(${path})。${cause}`;
    case 'partAttachmentDigestMismatch':
      return `ファイルの中身が壊れています(${path} の添付ダイジェストが一致しません)。`;
    case 'drawingTemplateMissingDocument':
      return '図面ひな形の設定が見つかりません。';
    case 'drawingTemplateInvalidUtf8':
      return '図面ひな形の文字を読み取れませんでした。';
  }
}
