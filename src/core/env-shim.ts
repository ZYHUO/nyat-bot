// ────────────────────────────────────────
// Core env shim — core 目录读 env 的唯一入口
//
// 为什么 shim：src/env.ts 的 zod schema 巨大，单测 mock env() 时
// 不想拖整个 schema。shim 只 re-export，保证 core 读到的与主路径一致。
// ────────────────────────────────────────

export { env } from '../env.js';
