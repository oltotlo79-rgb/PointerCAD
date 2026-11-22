/**
 * OCCT の取得・検証・コンパイルが失敗したときに Worker が付ける Error の名前(FR-504、NFR-RE-1)。
 * Comlink が運ぶこの名前で、主スレッドは読み込みの失敗を見分け、同じ世代を頼み直す。
 */
export const OCCT_LOAD_ERROR_NAME = 'OcctLoadError';
