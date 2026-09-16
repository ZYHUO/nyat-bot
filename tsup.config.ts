import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // dist/index.js 是 `node dist/index.js` 直接跑的应用入口,package.json 又是 private:true
  // 不发包 —— 生成 .d.ts rollup 没有消费者,纯粹浪费构建时间。
  dts: false,
  shims: false,
  external: [
    'better-sqlite3',
    'playwright',
    // Native addon loaded via createRequire at runtime (@nyat/nyatdb → native/nyatdb).
    /native\/nyatdb/,
    /@nyat\/nyatdb-native/,
  ],
  // Bundle @nyat/nyatdb TS engine into dist; keep napi .node external.
  noExternal: ['@nyat/nyatdb', '@nyat/context-engine'],
});
