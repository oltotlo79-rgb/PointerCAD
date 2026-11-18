/** Draft references and reported editions. Confirmation against the final JIS text is recorded separately. */
export type SteelStandardVerification = 'draft' | 'final-standard' | 'unverified';

export interface SteelStandardDraft {
  readonly reference: string;
  /** Draft meeting date, not the revision/publication date of the standard. */
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
  /** Null records missing evidence; it must never be filled with a different standard's draft. */
  readonly draft: SteelStandardDraft | null;
  /** Earlier drafts are retained as evidence, not substituted for this edition. */
  readonly historicalDrafts: readonly SteelStandardDraft[];
}

const draftNote = '原案で確認。規格票の本文との差は未確認。';
/** 2026-11-15 に足した G 3350・G 3459: 原案は 2020-12-02 の三者委員会の改正案。版と改正日は 規格票の見本の検索要約による。 */
const k3DraftNote = '原案（2020-12-02 三者委員会の改正案）で確認。2021年版・改正日 2021-04-20 は 規格票の見本の検索要約によるもので、'
  + '規格票の本文は未確認。公布本文との差は未確認。';

/**
 * Eleven standards, with eleven draft PDFs across ten standards (G 3192 has two drafts).
 * G 3123 has no JIS draft in the investigation; G 3444's edition remains inferred.
 * G 3350 and G 3459 (2026-11-15) are transcribed from the PDFs fetched for the catalog expansion design.
 */
export const STEEL_STANDARDS = {
  'jis-g-3101-2024': {
    number: 'JIS G 3101', name: '一般構造用圧延鋼材', edition: '2024', editionStatus: 'reported',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote,
    draft: {
      reference: 'JIS G 3101 原案 2023-07-26',
      meetingDate: '2023-07-26',
    },
    historicalDrafts: [],
  },
  'jis-g-3123-2004': {
    number: 'JIS G 3123', name: 'みがき棒鋼', edition: '2004', editionStatus: 'reported',
    revisedOn: '2004-09-20', revisionDateBasis: 'search-summary', verification: 'unverified',
    verificationNote: '改正原案・最終規格票・寸法表は未確認。版と改正日は書誌の検索要約による。'
      + '規格の確認と改正を区別する。既存S45Cみがき材の寸法は製造元資料で確認。',
    draft: null, historicalDrafts: [],
  },
  'jis-g-3191-2022': {
    number: 'JIS G 3191', name: '熱間圧延棒鋼及びバーインコイルの形状、寸法、質量及びその許容差',
    edition: '2022', editionStatus: 'reported',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote,
    draft: {
      reference: 'JIS G 3191 原案 2021-07-28',
      meetingDate: '2021-07-28',
    },
    historicalDrafts: [],
  },
  'jis-g-3192-2024': {
    number: 'JIS G 3192', name: '熱間圧延形鋼の形状、寸法、質量及びその許容差',
    edition: '2024', editionStatus: 'reported',
    revisedOn: '2024-11-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: draftNote,
    draft: {
      reference: 'JIS G 3192 原案 2024-07-24',
      meetingDate: '2024-07-24',
    },
    historicalDrafts: [{
      reference: 'JIS G 3192 原案 2020-12-02',
      meetingDate: '2020-12-02',
    }],
  },
  'jis-g-3194-2024': {
    number: 'JIS G 3194', name: '熱間圧延平鋼の形状、寸法、質量及びその許容差',
    edition: '2024', editionStatus: 'reported',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote,
    draft: {
      reference: 'JIS G 3194 原案 2024-07-24',
      meetingDate: '2024-07-24',
    },
    historicalDrafts: [],
  },
  'jis-g-3350-2021': {
    number: 'JIS G 3350', name: '一般構造用軽量形鋼', edition: '2021', editionStatus: 'reported',
    revisedOn: '2021-04-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: k3DraftNote,
    draft: {
      reference: 'JIS G 3350 原案 2020-12-02',
      meetingDate: '2020-12-02',
    },
    historicalDrafts: [],
  },
  'jis-g-3444-2025': {
    number: 'JIS G 3444', name: '一般構造用炭素鋼鋼管', edition: '2025', editionStatus: 'inferred',
    revisedOn: null, revisionDateBasis: 'unverified', verification: 'draft',
    verificationNote: draftNote + '2025年版は推測。原案の前書きは2021年版の改正を示すが、公布の版・改正日・寸法表は未確認。',
    
    draft: {
      reference: 'JIS G 3444 原案 2024-12-20',
      meetingDate: '2024-12-20',
    },
    historicalDrafts: [],
  },
  'jis-g-3452-2026': {
    number: 'JIS G 3452', name: '配管用炭素鋼鋼管', edition: '2026', editionStatus: 'reported',
    revisedOn: '2026-05-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: draftNote,
    draft: {
      reference: 'JIS G 3452 原案 2025-12-17',
      meetingDate: '2025-12-17',
    },
    historicalDrafts: [],
  },
  'jis-g-3459-2021': {
    number: 'JIS G 3459', name: '配管用ステンレス鋼鋼管', edition: '2021', editionStatus: 'reported',
    revisedOn: '2021-04-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: k3DraftNote,
    draft: {
      reference: 'JIS G 3459 原案 2020-12-02',
      meetingDate: '2020-12-02',
    },
    historicalDrafts: [],
  },
  'jis-g-3466-2025': {
    number: 'JIS G 3466', name: '一般構造用角形鋼管', edition: '2025', editionStatus: 'reported',
    revisedOn: '2025-04-21', revisionDateBasis: 'secondary-source', verification: 'draft',
    verificationNote: draftNote + '改正日は流通業者資料による二次情報で、規格票では未確認。',
    
    draft: {
      reference: 'JIS G 3466 原案 2024-12-20',
      meetingDate: '2024-12-20',
    },
    historicalDrafts: [],
  },
  'jis-g-4051-2026': {
    number: 'JIS G 4051', name: '機械構造用炭素鋼鋼材', edition: '2026', editionStatus: 'reported',
    revisedOn: '2026-05-20', revisionDateBasis: 'search-summary', verification: 'draft',
    verificationNote: draftNote,
    draft: {
      reference: 'JIS G 4051 原案 2025-12-17',
      meetingDate: '2025-12-17',
    },
    historicalDrafts: [],
  },
} as const satisfies Readonly<Record<string, SteelStandard>>;

type SteelStandardId = keyof typeof STEEL_STANDARDS;

export interface SteelStandardReference {
  readonly standardId: SteelStandardId;
  readonly locator: string;
}

/** Additional provenance only; these IDs do not replace the saved standard strings. */
export interface SteelProductStandardReferences {
  readonly material: SteelStandardId;
  readonly dimensions: SteelStandardId;
}
