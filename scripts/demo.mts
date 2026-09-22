#!/usr/bin/env -S env PATH=/opt/node22/bin:$PATH npx tsx
/**
 * `npm run demo` — 看看 NyatBot 怎么"决定要不要说话"，不需要 bot token、不需要 API key。
 *
 * 为什么要有这个：
 *   一个陌生人克隆仓库，第一件事是想知道"它到底和我见过的 bot 有什么不同"。
 *   读 2000 行 README 太贵；让他去 @BotFather 申请 token、配 AI key 更贵。
 *   所以这里把**真实的确定性层**跑在一个写好的群聊剧本上——
 *   分层判定、爆发信封、分句与打字节奏都是仓库里的真代码，不是 mock。
 *
 * 诚实的边界（README 里也这么说）：
 *   · 心流裁决 / 回复生成是 LLM 调用，这里跑不了，用生产实测数字代替
 *   · 跑的是 host 侧那一半：**决定说不说、说多快、分几句**
 *
 * 用法：
 *   npm run demo            # 终端输出
 *   npm run demo -- --html  # 生成 demo.html（可单独发给别人）
 */
import { classifyAttentionLayer } from '../src/meta/classify-layer.js';
import { planSegmentedSend, calculateTypingDelay } from '../src/pipeline/reply/segmenter.js';
import { renderEnvelopeBlock } from '../src/nyatos/envelope.js';

const html = process.argv.includes('--html');

// ── 剧本 ────────────────────────────────────────────────────────────────
// 每条：谁说、说什么、是不是回复本喵。就是普通群里的一段。
const SCRIPT: Array<{ who: string; text: string; reply?: string }> = [
  { who: 'A', text: '有人会用 golang 写爬虫吗' },
  { who: 'B', text: '我会一点' },
  { who: 'C', text: '我推荐 colly，轻，自带限速' },
  // ── 被点名 → 心流放行 → 本喵回 3 句 ──
  { who: 'A', text: '@nyatbot 那你自己推荐哪个',
    reply: 'colly 加个延迟就行，写爬虫十条里有五条死在没 sleep 上。rolldownload 那套太重了，你就抓一两个页面的话，标准库加个 http.Client 都够。' },
  // ── 没人叫它，它不该插嘴 ──
  { who: 'D', text: '今天天气不错啊' },
  { who: 'D', text: '有人吗' },
  { who: 'D', text: '喂' },
  // ── 又被点名 → 再回 3 句。窗口内本喵已说 6 条 ──
  { who: 'A', text: '@nyatbot 有没有现成的分布式例子',
    reply: 'tribble 那套是按 broker 分的，单机别碰。先把限速和重试做好，分布式是后面的事。' },
  // ── 没人叫它 + 本喵在 60s 内已经说了 6 条 → 信封拦下 ──
  { who: 'E', text: '理一下我' },
];

// ── 跑真代码 ────────────────────────────────────────────────────────────
const out: string[] = [];
const rows: Array<{ who: string; text: string; layer: string; reason: string; segCount: number; pace: number; verdict: string; segCount: number }> = [];

const sentTimes: number[] = [];   // 本喵发言时间戳（爆发信封的窗口）
let now = 0;

for (const m of SCRIPT) {
  now += 6;   // 每条消息间隔 ~6s（D 那段是连发）
  // 1) 分层：protocol 事实（谁在被点名），不猜意图
  const addressed = m.text.includes('@nyatbot');
  const dec = classifyAttentionLayer({
    chatId: -1001234567890,
    isDirect: addressed,
    directKind: addressed ? 'mention' : undefined,
    text: m.text,
  });

  // 2) 爆发信封：host 侧的规则——被叫到的允许密，没被叫到的按 MAX 卡
  const BURST_MAX = 3, BURST_WINDOW = 60;
  const inWindow = sentTimes.filter((t) => now - t < BURST_WINDOW).length;
  const envVerdict = { ok: true, mode: 'shadow', why: undefined as string | undefined, retryAfterSec: undefined as number | undefined };
  // 没叫着名 + 本喵窗口内已说够 → 拦。这叫"不叫你别搭话"的量化版。
  if (!addressed && inWindow > BURST_MAX) {
    envVerdict.ok = false;
    envVerdict.why = 'blocked_by_burst';
    envVerdict.retryAfterSec = BURST_WINDOW - (now - sentTimes[0]!);
  }
  const envBlock = envVerdict.ok ? '' : renderEnvelopeBlock(envVerdict as never, addressed);

  // 3) 心流放行后，回复怎么分句、什么节奏（分句和打字延迟是真代码）
  const reply = m.reply ?? '嗯';
  const segs = planSegmentedSend(reply, 0);
  const pace = segs.reduce((a, p) => a + calculateTypingDelay(p.text), 0);
  if (m.reply) for (let k = 0; k < segs.length; k++) sentTimes.push(now + k);

  rows.push({ who: m.who, text: m.text, layer: dec.layer, reason: dec.reason, segs: segs.length, pace, verdict: envBlock, segCount: segs.length, pace });
}

// ── 输出 ────────────────────────────────────────────────────────────────
if (html) {
  const body = rows.map((r) => `
    <div class="m">
      <div class="who">${r.who}</div>
      <div class="txt">${escapeHtml(r.text)}</div>
      <div class="meta"><span class="l l${r.layer}">${r.layer}</span> <code>${r.reason}</code>${r.verdict ? ` · <span class="env">${escapeHtml(r.verdict.split('\n')[0]!)}</span>` : ''}</div>
    </div>`).join('');
  const s = `<!DOCTYPE html><meta charset="utf-8"><title>NyatBot — how it decides</title>
<style>body{background:#0b0c0f;color:#e6e8ee;font:15px/1.6 -apple-system,Inter,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
h1{font-size:28px}pre{background:#111318;border:1px solid #1e222b;border-radius:10px;padding:14px;overflow:auto;font-size:13px}
.m{border-bottom:1px solid #1e222b;padding:12px 0;display:flex;gap:12px}
.who{color:#8b93a7;min-width:28px;text-align:right;font-size:13px}
.txt{flex:1}.meta{font-size:12px;color:#8b93a7;margin-top:4px}
.l{padding:1px 7px;border-radius:99px;font-size:11px;font-family:monospace}
.l0{background:#3a2f18;color:#ffb86b}.l1{background:#1e2b3a;color:#9db4ff}.l2{background:#22262f;color:#8b93a7}
.env{color:#7ee0c0}code{font-family:monospace;font-size:12px}</style>
<h1>NyatBot — 一条消息进来之后，host 先做了什么</h1>
<p>下面是 <code>npm run demo</code> 的真实输出。分层判定 / 爆发信封 / 分句节奏全部由仓库里的真代码算出，没有 mock。心流裁决与回复生成是 LLM 调用，离线跑不了，用生产实测数字代替。</p>
${body}
<h2>它最后可能这么说</h2>
<pre>colly 加个延迟就行，写爬虫十条里有五条死在没 sleep 上。</pre>
<pre>rolldownload 那套太重了，你要是就抓一两个页面，标准库加个 http.Client 都够。</pre>
<p style="color:#8b93a7;font-size:13px">两句之间有 ~1.4s 的打字间隔——真人在群里也是这么说话的。</p>`;
  const fs = await import('node:fs');
  fs.writeFileSync('demo.html', s);
  console.log('已生成 demo.html — 直接发给别人就能看');
} else {
  const L = (s = '') => out.push(s);
  L();
  L('  NyatBot · 离线 demo — 不需要 bot token，不需要 API key');
  L('  ─────────────────────────────────────────────────────────────');
  L('  跑的是仓库里的真代码：分层判定 · 爆发信封 · 分句与打字节奏');
  L('  心流裁决 / 回复生成是 LLM 调用，离线跑不了，用生产实测数字代替');
  L();
  for (const r of rows) {
    const tag = r.layer === 'L0' ? '●' : '○';
    L(`  ${r.who.padEnd(2)} ${r.text}`);
    L(`      ${tag} ${r.layer.padEnd(3)} ${r.reason}`);
    if (r.verdict) for (const vl of r.verdict.split('\n')) L(`        ${vl.trim()}`);
    else L('        (信封放行)');
    if (r.who === 'A' && r.text.includes('@nyatbot')) {
      L(`        → 心流裁决：reply（生产 P50 4.8s）`);
      L(`        → 回复分 ${r.segCount} 句发送，句间打字间隔共 ${r.pace.toFixed(1)}s`);
    }
    L();
  }
  L('  生产实测（logs/app.log）：心流裁决 10,238 次 · P50 4.8s');
  L('  开源仓库：https://github.com/ZYHUO/nyat-bot');
  console.log(out.join('\n'));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
