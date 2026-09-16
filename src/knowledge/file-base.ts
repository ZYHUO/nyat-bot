// ────────────────────────────────────────
// File-backed knowledge base (PHP KnowledgeBaseManager parity)
// ────────────────────────────────────────

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';

export interface KnowledgeOptions {
  permanent?: boolean;
  group?: boolean;
}

interface Section {
  title: string;
  content: string;
}

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '也', '都', '你', '他', '她', '它', '这', '那', '吗', '吧',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'for', 'on', 'at', 'by',
  'with', 'and', 'or', 'but', 'if', 'so', 'as', 'do', 'did', 'does', 'not', 'no', 'can', 'will',
]);

const sectionCache = new Map<string, Section[]>();
let _permanentPromptCache: string | undefined;

export function clearKnowledgeSectionCache(): void {
  sectionCache.clear();
}

export function resetPermanentKnowledgeCache(): void {
  _permanentPromptCache = undefined;
}

/**
 * Permanent knowledge: prompts/knowledge/permanent.md (TS convention).
 */
export function loadPermanentFromPrompts(): string {
  if (_permanentPromptCache !== undefined) return _permanentPromptCache;

  const { promptsDir } = getConfig();
  const knowledgePath = resolve(promptsDir, 'knowledge/permanent.md');

  if (!existsSync(knowledgePath)) {
    logger.debug({ path: knowledgePath }, 'No permanent knowledge file');
    _permanentPromptCache = '';
    return '';
  }

  _permanentPromptCache = readFileSync(knowledgePath, 'utf-8').trim();
  logger.info({ length: _permanentPromptCache.length }, 'Permanent knowledge loaded');
  return _permanentPromptCache;
}

function groupKnowledgePath(chatId: number): string {
  return resolve(getConfig().knowledgeBaseDir, `${chatId}.md`);
}

export function getDynamicKnowledge(chatId: number): string {
  const path = groupKnowledgePath(chatId);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function getKnowledge(chatId: number, options: KnowledgeOptions = {}): string {
  const loadPermanent = options.permanent ?? true;
  const loadGroup = options.group ?? true;
  const knowledgeParts: string[] = [];

  if (loadPermanent) {
    const content = loadPermanentFromPrompts().trim();
    if (content) knowledgeParts.push('--- 全局知识库 ---\n' + content);
  }

  if (loadGroup) {
    const dynamic = getDynamicKnowledge(chatId).trim();
    if (dynamic) knowledgeParts.push('--- 群组动态知识库 ---\n' + dynamic);
  }

  return knowledgeParts.join('\n\n');
}

export function updateKnowledge(chatId: number, newKnowledgeMarkdown: string): void {
  const dir = getConfig().knowledgeBaseDir;
  mkdirSync(dir, { recursive: true });
  const path = groupKnowledgePath(chatId);
  writeFileSync(path, newKnowledgeMarkdown, { encoding: 'utf-8' });
  clearKnowledgeSectionCache();
}

function getCachedSections(fullKnowledge: string): Section[] {
  const key = createHash('md5').update(fullKnowledge).digest('hex');
  let sections = sectionCache.get(key);
  if (!sections) {
    sections = splitIntoSections(fullKnowledge);
    sectionCache.set(key, sections);
  }
  return sections;
}

/** Port of PHP splitIntoSections — headings start with ## */
export function splitIntoSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let currentTitle = '';
  let currentContent = '';
  let inSection = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) {
        sections.push({
          title: currentTitle,
          content: currentContent.trim(),
        });
      }
      currentTitle = line;
      currentContent = '';
      inSection = true;
    } else {
      if (inSection) {
        currentContent += line + '\n';
      } else {
        currentContent += line + '\n';
      }
    }
  }

  if (inSection) {
    sections.push({
      title: currentTitle,
      content: currentContent.trim(),
    });
  } else if (currentContent.trim()) {
    sections.push({
      title: '',
      content: currentContent.trim(),
    });
  }

  return sections;
}

function substrCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function tokenLen(word: string): number {
  return [...word].length;
}

/**
 * Keyword section scoring — matches PHP KnowledgeBaseManager::searchKnowledge.
 */
export function searchKnowledge(chatId: number, query: string, maxSections = 5): string {
  const fullKnowledge = getKnowledge(chatId, { permanent: true, group: true });

  if (!fullKnowledge.trim() || !query.trim()) {
    return fullKnowledge;
  }

  const sections = getCachedSections(fullKnowledge);
  if (sections.length === 0) {
    return fullKnowledge;
  }

  const words = query.trim().split(/\s+/u);
  const keywords: string[] = [];
  for (const word of words) {
    const w = word.trim();
    if (tokenLen(w) < 2) continue;
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    keywords.push(lower);
  }

  if (keywords.length === 0) {
    return fullKnowledge;
  }

  const scored: Array<{ index: number; score: number; section: Section }> = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const sectionText = (section.title + ' ' + section.content).toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      score += substrCount(sectionText, keyword);
    }
    scored.push({ index: i, score, section });
  }

  scored.sort((a, b) => b.score - a.score);

  const topSections = scored    .slice(0, maxSections)
    .filter((item) => item.score > 0);

  if (topSections.length === 0) {
    return fullKnowledge;
  }

  topSections.sort((a, b) => a.index - b.index);

  const result: string[] = [];
  for (const item of topSections) {
    const s = item.section;
    result.push((s.title + '\n' + s.content).trim());
  }

  return result.join('\n\n');
}
