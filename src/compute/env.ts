import { z } from 'zod';
import { isAbsolute } from 'node:path';

const schema = z.object({
  EMBED_COMPUTE_TOKEN: z.string().min(32),
  EMBED_COMPUTE_MODEL: z.string().min(1).regex(/^[A-Za-z0-9._/-]+$/).refine(value => !value.split('/').includes('..')),
  EMBED_COMPUTE_CACHE_DIR: z.string().refine(isAbsolute, 'cache directory must be absolute'),
  EMBED_COMPUTE_HOST: z.string().min(1).default('127.0.0.1'),
  EMBED_COMPUTE_PORT: z.coerce.number().int().min(1).max(65535).default(3032),
  EMBED_COMPUTE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  EMBED_COMPUTE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(15_000),
});
/** Deliberate standalone configuration boundary: never loads the bot .env. */
export function computeEnv(source: NodeJS.ProcessEnv = process.env) { return schema.parse(source); }
