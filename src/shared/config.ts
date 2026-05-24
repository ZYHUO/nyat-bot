import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { env } from '../env.js';
import { logger } from './logger.js';

export interface AppConfig {
  promptsDir: string;
  migrationsDir: string;
  knowledgeBaseDir: string;
  personaDir: string;
}

function loadPrompt(relativePath: string, promptsDir: string): string {
  const fullPath = resolve(promptsDir, relativePath);
  if (!existsSync(fullPath)) {
    logger.warn({ path: fullPath }, 'Prompt file not found');
    return '';
  }
  return readFileSync(fullPath, 'utf-8');
}

let _config: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!_config) {
    // trigger env validation
    const e = env();
    const cwd = process.cwd();
    const knowledgeBaseDir = resolve(cwd, e.KNOWLEDGE_BASE_DIR);
    const personaDir = e.PERSONA_DIR
      ? isAbsolute(e.PERSONA_DIR)
        ? e.PERSONA_DIR
        : resolve(cwd, e.PERSONA_DIR)
      : resolve(cwd, 'prompts/persona');
    _config = {
      promptsDir: resolve(cwd, 'prompts'),
      migrationsDir: resolve(cwd, 'migrations'),
      knowledgeBaseDir,
      personaDir,
    };
  }
  return _config;
}

export { loadPrompt };

const PROMPT_CACHE_MAX_SIZE = 200;
const PROMPT_CACHE_EVICT_COUNT = 50;

let _promptCache: Map<string, string> | undefined;

function getPromptCache(): Map<string, string> {
  if (!_promptCache) {
    _promptCache = new Map();
  }
  return _promptCache;
}

export function loadCachedPrompt(relativePath: string): string {
  const cache = getPromptCache();
  const cached = cache.get(relativePath);
  if (cached !== undefined) return cached;

  const config = getConfig();
  const content = loadPrompt(relativePath, config.promptsDir);
  cache.set(relativePath, content);
  if (cache.size > PROMPT_CACHE_MAX_SIZE) {
    const keys = cache.keys();
    for (let i = 0; i < PROMPT_CACHE_EVICT_COUNT; i++) {
      const { value, done } = keys.next();
      if (done) break;
      cache.delete(value);
    }
  }
  return content;
}

/** Reset prompt cache (for testing) */
export function _resetPromptCache(): void {
  _promptCache = undefined;
}

/** @internal test helper — clears cached AppConfig */
export function _resetAppConfig(): void {
  _config = undefined;
}
