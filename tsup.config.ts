import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  shims: false,
  external: [
    'better-sqlite3',
    // Native addon loaded via createRequire at runtime (@nyat/nyatdb → native/nyatdb).
    /native\/nyatdb/,
    /@nyat\/nyatdb-native/,
  ],
  // Bundle @nyat/nyatdb TS engine into dist; keep napi .node external.
  noExternal: ['@nyat/nyatdb', '@nyat/context-engine'],
});
