// ────────────────────────────────────────
// 按沙盒能力改写 subagent 的系统提示
// ────────────────────────────────────────
//
// 2026-09-21 加。`computer.run` 依赖 bwrap userns 隔离，而目标机器的 apt 源里
// **没有 bwrap 包**（`apt-get install bwrap` → Unable to locate package）。
// 于是 executeCommand 每次都返回 `sandbox isolation unavailable`，
// 而 EXECUTOR_SYSTEM 里两处仍在推荐它：
//
//   第 85 行  `- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}`
//   第 112 行 `8. 写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。`
//
// **prompt 在推荐一个永久坏掉的能力。** 模型照做、失败，可能还多烧几轮
// 去重试。这和本会话反复治的那类病同形：一个东西写着能用，实际那条路上是死的。
//
// 修法不是删掉那两行（bwrap 装回来就该恢复），而是按能力现场改写：
// 不可用时明说"本机没有，别试"，可用时一字不改。
//
// 抽成独立模块是为了可单测——内联在 executor 里就只能靠整条 CodeAct 链路验证。

/** getSandboxCapability() 的最小形状（避免为了一个判断把整个 sandbox 拖进依赖）。 */
export interface SandboxCapabilityLike {
  terminalEnabled: boolean;
  isolationRequired: boolean;
  bwrapAvailable: boolean;
}

/** EXECUTOR_SYSTEM 里被改写的几处原文。改 prompt 时这里必须同步，否则替换静默失效。 */
const RUN_DOC_LINE =
  '- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}';
const VERIFY_STEP_RE = /写文件后建议用 computer\.run 验证内容正确[^。]*。/g;
/** 「电脑使用」小节标题：它说"SANDBOX_ENABLED 时可用"，可那一节里依赖终端的建议一句句都死了。 */
const SECTION_HEADER = '## 电脑使用（SANDBOX_ENABLED 时可用）';
/** 依赖终端的图像处理建议（python3.10 + PIL 走 computer.run）。 */
const PIL_LINE_RE = /- \*\*图像处理（改尺寸\/裁剪\/转格式\/处理真实照片）用[^\n]*/;
/** 依赖终端的检查办法（grep 也是命令）。 */
const GREP_ADVICE_RE = /检查办法：写完 grep charset，没有就补。/;

/**
 * 终端隔离不可用 → 把"推荐用 computer.run"改写成"本机没有，别试"。
 * 可用（或未启用终端）→ 原样返回，一字不改。
 *
 * 两条原文都找不到时也算成功：说明 prompt 被改过了，改写目标不存在，
 * 这时候不该报错，只该安静返回（否则一次 prompt 重构就能让所有任务失败）。
 */
export function applySandboxAvailabilityNotes(
  prompt: string,
  capability: SandboxCapabilityLike,
): string {
  const terminalDead =
    capability.terminalEnabled && capability.isolationRequired && !capability.bwrapAvailable;
  if (!terminalDead) return prompt;

  let out = prompt;
  if (out.includes(RUN_DOC_LINE)) {
    out = out.replace(
      RUN_DOC_LINE,
      '- computer.run(command) — **本机不可用**：bwrap 未安装且 apt 源里没有这个包，' +
        '调用必定返回 `sandbox isolation unavailable`。别用它验证任何东西，' +
        '改用 browser / sendFile 之类的路径，或直接说明没法验证。',
    );
  }
  out = out.replace(
    VERIFY_STEP_RE,
    '写文件后没法用终端验证（本机没有 bwrap），必要时用 browser 打开看效果。',
  );
  // 小节标题：SANDBOX_ENABLED 确实开着，可这一节里凡是要跑命令的都死了。
  // 不改标题，模型读到这里会以为整节都能用，然后一头撞在 computer.run 上。
  if (out.includes(SECTION_HEADER)) {
    out = out.replace(
      SECTION_HEADER,
      '## 电脑使用（文件读写/浏览器可用；**终端命令本机不可用**——见下）',
    );
  }
  // 依赖终端的图像处理建议。
  if (PIL_LINE_RE.test(out)) {
    out = out.replace(
      PIL_LINE_RE,
      '- **图像处理（改尺寸/裁剪/转格式）本机做不了**：那需要终端跑 python3.10，而终端不可用。' +
        '要处理图片就跟用户说做不了，或用 art.draw 重新画。**画图创作不走这里，用 art.draw**',
    );
  }
  // 依赖终端的检查办法：grep 也是命令。
  if (GREP_ADVICE_RE.test(out)) {
    out = out.replace(
      GREP_ADVICE_RE,
      '检查办法：本机没有终端可用（grep 跑不了），写完在正文里自己核对一遍 <head> 开头有没有那行。',
    );
  }
  return out;
}
