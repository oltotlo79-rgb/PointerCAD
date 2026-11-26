import { DxfDataError, ThreeMfDataError, ThreeMfExportLimitError,
  type DxfDataErrorCode, type ThreeMfDataErrorCode } from '@pointercad/io';
import { DrawingDxfInputError, type ShapeExportOutcome, type ShapeImportOutcome } from '@pointercad/model';
import { messageText } from '../i18n/failureMessage.js';
import { t, type MessageKey } from '../i18n/t.js';
import { PcadSaveWorkerError } from './pcadSaveWorker.js';

const DXF_KEYS: Readonly<Record<DxfDataErrorCode, MessageKey>> = {
  unsupported: 'exchangeError.dxf.unsupported',
  tooLarge: 'exchangeError.dxf.tooLarge',
  nonUniformScale: 'exchangeError.dxf.nonUniformScale',
  tooManyEntities: 'exchangeError.dxf.tooManyEntities',
  blockNesting: 'exchangeError.dxf.blockNesting',
  invalidWriteValue: 'exchangeError.dxf.invalidWriteValue',
  controlCharacter: 'exchangeError.dxf.controlCharacter',
  invalidString: 'exchangeError.dxf.invalidString',
};
const THREE_MF_KEYS: Readonly<Record<ThreeMfDataErrorCode, MessageKey>> = {
  number: 'exchangeError.threeMf.number',
  positions: 'exchangeError.threeMf.positions',
  indices: 'exchangeError.threeMf.indices',
  color: 'exchangeError.threeMf.color',
};

function unexpectedExchangeFailure(format: string, error: unknown): string {
  console.error('PointerCAD exchange', format, error);
  return t('assembly.error.internal');
}

type ExportDiagnostic = NonNullable<Extract<ShapeExportOutcome, { kind: 'failed' }>['diagnostic']>;

const EXPORT_KEYS: Readonly<Record<Exclude<ExportDiagnostic['code'], 'deadline' | 'triangleLimit' | 'memoryLimit'>, MessageKey>> = {
  noShape: 'exchangeError.nothingToExport',
  missingShape: 'exchangeError.export.missingShape',
  noTriangle: 'exchangeError.export.noTriangle',
  workerBroken: 'exchangeError.export.workerBroken',
  igesUnavailable: 'exchangeError.igesUnavailable',
  internal: 'assembly.error.internal',
};

export class ExchangeExportError extends Error {
  constructor(message: string, readonly diagnostic?: ExportDiagnostic, options?: ErrorOptions) {
    super(message, options);
  }
}

export function shapeExportFailureMessage(format: 'step' | 'iges' | 'stl', error: ExchangeExportError): string {
  const diagnostic = error.diagnostic;
  if (diagnostic === undefined) return error.message;
  switch (diagnostic.code) {
    case 'internal':
      return 'cause' in error ? unexpectedExchangeFailure(format.toUpperCase(), error.cause) : t(EXPORT_KEYS.internal);
    case 'deadline':
      return messageText({ key: 'exchangeError.export.deadline', parameters: { seconds: String(diagnostic.limit / 1_000) } });
    case 'triangleLimit':
      return messageText({ key: 'exchangeError.export.triangleLimit', parameters: { limit: String(diagnostic.limit) } });
    case 'memoryLimit':
      return messageText({ key: 'exchangeError.export.memoryLimit', parameters: { mib: String(diagnostic.limit / 1_048_576) } });
    default:
      return t(EXPORT_KEYS[diagnostic.code]);
  }
}

type ImportDiagnostic = NonNullable<Extract<ShapeImportOutcome, { kind: 'failed' }>['diagnostic']>;

const IMPORT_KEYS: Readonly<Record<Exclude<ImportDiagnostic['code'], 'internal' | 'triangleLimit'>, MessageKey>> = {
  unreadable: 'exchangeError.import.unreadable',
  noShape: 'exchangeError.import.noShape',
  noSolid: 'exchangeError.import.noSolid',
  missingComponent: 'exchangeError.import.missingComponent',
  assemblyCycle: 'exchangeError.import.assemblyCycle',
  noFace: 'exchangeError.import.noFace',
  igesUnavailable: 'exchangeError.igesUnavailable',
};

export class ExchangeImportError extends Error {
  constructor(readonly diagnostic: ImportDiagnostic, message: string) {
    super(message);
  }
}

export function shapeImportFailureMessage(format: 'step' | 'iges' | 'stl', error: ExchangeImportError): string {
  const diagnostic = error.diagnostic;
  if (diagnostic.code === 'internal') {
    if (format === 'iges' && diagnostic.detail === '' && error.message === '') return t('assembly.error.internal');
    return unexpectedExchangeFailure(format.toUpperCase(), { message: error.message, detail: diagnostic.detail });
  }
  if (diagnostic.code === 'triangleLimit') {
    return messageText({ key: 'exchangeError.import.triangleLimit', parameters: { count: String(diagnostic.count) } });
  }
  return t(IMPORT_KEYS[diagnostic.code]);
}

export function dxfFailureMessage(error: unknown): string {
  if (error instanceof DrawingDxfInputError) return t('exchangeError.dxf.invalidPaperOrLayer');
  if (error instanceof DxfDataError) return t(DXF_KEYS[error.code]);
  return unexpectedExchangeFailure('DXF', error);
}

export function threeMfFailureMessage(error: unknown): string {
  if (error instanceof PcadSaveWorkerError && error.internal) return t('assembly.error.internal');
  const cause = error instanceof PcadSaveWorkerError && error.cause !== undefined ? error.cause : error;
  if (cause instanceof ThreeMfDataError) return t(THREE_MF_KEYS[cause.code]);
  if (cause instanceof ThreeMfExportLimitError) return cause.message;
  return unexpectedExchangeFailure('3MF', error);
}
