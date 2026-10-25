/** Evidence snapshot of 2026-10-24; this ledger does not certify the published JIS text. */
export type SteelStandardVerification = 'draft' | 'final-standard' | 'unverified';

export interface SteelStandardDraft {
  readonly url: string;
  readonly sha256: string;
  /** JISF meeting date, not the revision/publication date of the standard. */
  readonly meetingDate: string;
}

export interface SteelStandard {
  readonly number: string;
  readonly name: string;
  readonly edition: string;
  /** Reported bibliographic year and inferred year are not final-text verification. */
  readonly editionStatus: 'reported' | 'inferred' | 'confirmed';
  readonly revisedOn: string | null;
  readonly revisionDateBasis: 'search-summary' | 'secondary-source' | 'final-standard' | 'unverified';
  readonly verification: SteelStandardVerification;
  readonly verificationNote: string;
  readonly checkedOn: string;
  /** Null records missing evidence; it must never be filled with a different standard's draft. */
  readonly draft: SteelStandardDraft | null;
  /** Earlier drafts are retained as evidence, not substituted for this edition. */
  readonly historicalDrafts: readonly SteelStandardDraft[];
}

const draftNote = '原案で確認（2026-10-24調査時、JSAの規格票は保守中で未確認）。公布本文との差は未確認。';

/**
 * Nine standards, with nine JISF PDFs across eight standards (G 3192 has two drafts).
 * G 3123 has no JISF draft in the investigation; G 3444's edition remains inferred.
 * URL/hash pairs are transcribed from the EX-03 investigation, not fetched at runtime.
 */
export const STEEL_STANDARDS = {
  'jis-g-3101-2024': {
    number: 'JIS G 3101', name: '一般構造用圧延鋼材', edition: '2024', editionStatus: 'reported',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote, checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3101_20230726.pdf',
      sha256: '797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893',
      meetingDate: '2023-07-26',
    },
    historicalDrafts: [],
  },
  'jis-g-3123-2004': {
    number: 'JIS G 3123', name: 'みがき棒鋼', edition: '2004', editionStatus: 'reported',
    revisedOn: '2004-09-20', revisionDateBasis: 'search-summary', verification: 'unverified',
    verificationNote: 'JISF原案・最終規格票・寸法表は未確認。版と改正日はJSA書誌の検索要約による。'
      + '2024-10-21は確認日であり改正日ではない。既存S45Cみがき材の寸法は製造元資料で確認。',
    checkedOn: '2026-10-24', draft: null, historicalDrafts: [],
  },
  'jis-g-3191-2022': {
    number: 'JIS G 3191', name: '熱間圧延棒鋼及びバーインコイルの形状、寸法、質量及びその許容差',
    edition: '2022', editionStatus: 'reported',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote, checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai010_jis12G3191_20210728.pdf',
      sha256: '8ea886730b59558553d49f395e7ada43c093210c51e00e3080c08f2163c0e313',
      meetingDate: '2021-07-28',
    },
    historicalDrafts: [],
  },
  'jis-g-3192-2024': {
    number: 'JIS G 3192', name: '熱間圧延形鋼の形状、寸法、質量及びその許容差',
    edition: '2024', editionStatus: 'reported',
    revisedOn: '2024-11-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: draftNote, checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3192_20240724.pdf',
      sha256: 'ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa',
      meetingDate: '2024-07-24',
    },
    historicalDrafts: [{
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai004_jis02G3192_20201202.pdf',
      sha256: '000c5bf453e141191151608e424731322155f88a4f756a450abd14c8c573a935',
      meetingDate: '2020-12-02',
    }],
  },
  'jis-g-3194-2024': {
    number: 'JIS G 3194', name: '熱間圧延平鋼の形状、寸法、質量及びその許容差',
    edition: '2024', editionStatus: 'reported',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote, checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0500JISG3194_20240724.pdf',
      sha256: '07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea',
      meetingDate: '2024-07-24',
    },
    historicalDrafts: [],
  },
  'jis-g-3444-2025': {
    number: 'JIS G 3444', name: '一般構造用炭素鋼鋼管', edition: '2025', editionStatus: 'inferred',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote + '2025年版は推測。原案の前書きは2021年版の改正を示すが、公布の版・改正日・寸法表は未確認。',
    checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_1400_JISG3444_20241220.pdf',
      sha256: '755e8484f4006043ff5592f0f0baba5524f86d4aac777aca25f25827483e5fa3',
      meetingDate: '2024-12-20',
    },
    historicalDrafts: [],
  },
  'jis-g-3452-2026': {
    number: 'JIS G 3452', name: '配管用炭素鋼鋼管', edition: '2026', editionStatus: 'reported',
    revisedOn: '2026-05-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: draftNote, checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0500_JISG3452_20251217.pdf',
      sha256: '03b3975041cee440fd7be67ef7928089158cc8d7e7d1fc584399cfb282170318',
      meetingDate: '2025-12-17',
    },
    historicalDrafts: [],
  },
  'jis-g-3466-2025': {
    number: 'JIS G 3466', name: '一般構造用角形鋼管', edition: '2025', editionStatus: 'reported',
    revisedOn: '2025-04-21', revisionDateBasis: 'secondary-source', verification: 'draft',
    verificationNote: draftNote + '改正日は流通業者資料による二次情報で、規格票では未確認。',
    checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_1600_JISG3466_20241220.pdf',
      sha256: 'ce00863b95e73a2dd116459bf75595ac6a21779961406cef8d149791af012752',
      meetingDate: '2024-12-20',
    },
    historicalDrafts: [],
  },
  'jis-g-4051-2026': {
    number: 'JIS G 4051', name: '機械構造用炭素鋼鋼材', edition: '2026', editionStatus: 'reported',
    revisedOn: '2026-05-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: draftNote, checkedOn: '2026-10-24',
    draft: {
      url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0700_JISG4051_20251217.pdf',
      sha256: '158ac7b25b0c1cda41ae5cdf68cfe37530b73f1288b9cacf62c2d45584664245',
      meetingDate: '2025-12-17',
    },
    historicalDrafts: [],
  },
} as const satisfies Readonly<Record<string, SteelStandard>>;

export type SteelStandardId = keyof typeof STEEL_STANDARDS;

export interface SteelStandardReference {
  readonly standardId: SteelStandardId;
  readonly locator: string;
}

/** Additional provenance only; these IDs do not replace the saved standard strings. */
export interface SteelProductStandardReferences {
  readonly material: SteelStandardId;
  readonly dimensions: SteelStandardId;
}
