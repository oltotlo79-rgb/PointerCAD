export interface ChapterImageException {
  readonly reason: string;
  readonly deadline: string;
  readonly note: string;
}
export const NO_IMAGE_NEEDED: Readonly<Record<string, string>>;
export const KNOWN_EXCEPTIONS: Readonly<Record<string, ChapterImageException>>;
export function isExemptChapter(id: string): boolean;
export interface ChapterImagePolicyResult {
  readonly problems: readonly string[];
  readonly openExceptions: readonly (ChapterImageException & { readonly id: string; readonly images: number })[];
  readonly chapters: number;
}
export function checkChapterImagePolicy(
  chapters: readonly { readonly name: string; readonly text: string }[],
  options?: { readonly requireFullCoverage?: boolean },
): ChapterImagePolicyResult;
