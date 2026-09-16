// ────────────────────────────────────────
// Knowledge Manager — re-exports + test helpers
// ────────────────────────────────────────

export {
  loadPermanentFromPrompts as loadPermanentKnowledge,
  getKnowledge,
  getDynamicKnowledge,
  updateKnowledge,
  searchKnowledge,
  clearKnowledgeSectionCache,
  resetPermanentKnowledgeCache,
  splitIntoSections,
  type KnowledgeOptions,
} from './file-base.js';

import {
  clearKnowledgeSectionCache,
  resetPermanentKnowledgeCache,
} from './file-base.js';

/** Reset all in-process caches (for testing) */
export function _resetKnowledge(): void {
  clearKnowledgeSectionCache();
  resetPermanentKnowledgeCache();
}
