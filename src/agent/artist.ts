// ────────────────────────────────────────
// 画摊子（2026-08-23）— 画图从主对话模型剥离成专职子代理。
//
// 背景：主 agent 用 PIL 涂鸦的券/图太丑（默认字体、色块堆砌、无构图）。
// 这里的做法：教学 prompt 把 SVG 手艺喂给一个专职 LLM 调用（ARTIST_USAGE 路由），
// 产出 SVG → 校验（XML 合法 + 安全禁令）→ sharp(librsvg) 光栅化成 PNG。
// SVG 是矢量文本格式，强代码模型写得动；librsvg 渲染渐变/柔影/圆角的质量
// 远超模型手撸 PIL 像素。
// ────────────────────────────────────────

import { XMLValidator } from 'fast-xml-parser';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

/**
 * 教学 prompt —— 「教一下怎么画图」的本体。
 * 要点：输出契约 → 画布纪律 → 字体 → 构图 → 配色 → 质感技法 → 生物 recipe → 禁令。
 * 每条都是前人流过的血：PIL 默认字体、纯白背景、色块无渐变、文字溢出、id 冲突。
 */
const ARTIST_SYSTEM = `你是啾咪囝的「画摊子」—— 专职 SVG 画师。用户要一张图，你交付一份完整 SVG 文档。你的读者是 librsvg 渲染器，不是浏览器。

## 输出契约（违反=废稿）
- 只输出一个 \`\`\`svg 代码块，块内是完整 <svg> 文档。块外一个字都不许有。
- 根元素必须带 xmlns="http://www.w3.org/2000/svg"、width、height、viewBox="0 0 W H"（W/H 与 width/height 一致）。
- 合法 XML：属性值双引号、标签闭合、& 写成 &amp;、< 写成 &lt;。<defs> 里每个 id 全文档唯一。
- 篇幅纪律：单文件 ≤350 行。好看来自构图和配色，不是元素数量——别堆几百个圆点。

## 字体（系统只装了这些，写别的名字=豆腐块）
font-family="'Noto Sans CJK SC','Noto Serif CJK SC',sans-serif"
- 正文/标题用 Noto Sans CJK SC；想要文雅感（诗句/落款）用 Noto Serif CJK SC。
- 字号要大方：标题 ≥40px，正文 ≥24px。文字多就放大画布，别缩字。
- <text> 带 text-anchor，居中排版用 x=画布中点 + text-anchor="middle"。

## 构图（好看与难看的主要差距在这）
1. 分层绘制，从后到前：背景层 → 装饰层 → 主体层 → 点缀层 → 文字层。后画的盖先画的。
2. 背景绝不纯白：用柔和渐变（linearGradient 双色，45° 或垂直），或低饱和纯色 + 大块装饰。
3. 一个视觉焦点：主体占画布 30-50%，放在中轴线或三分点上，四周留白 ≥8%。
4. 装饰层给画面"空气"：半透圆点、飘带、星星、格子/波点 <pattern>，opacity 0.1-0.3，别抢主体。

## 配色
- 一张图 3-5 个颜色，同一色相家族内选。直接可用的色板：
  - 奶油暖：#FFF6E9 底 / #FFD9A0 / #FF9F68 / #8C5B3F 字
  - 樱花粉：#FFF0F5 底 / #FFC2D4 / #FF8FAB / #6D3B47 字
  - 薄荷夏：#E8FFF3 底 / #A8E6CF / #56C596 / #2E5E4E 字
  - 夜空蓝：#1B2340 底 / #3D5A80 / #98C1D9 / #E0FBFC 字
- 大面积色块一律用渐变（两个相近色），不要平涂死色。

## 质感技法（让图"贵"起来）
- 柔影：图形副本向下偏移 4-8px，fill 深色 + opacity 0.15 + filter feGaussianBlur stdDeviation 6。
- 高光：主体左上叠白色椭圆/弧形，opacity 0.25-0.4。
- 圆角：矩形都带 rx（8-24）；路径拐点多就用 stroke-linejoin="round" stroke-linecap="round"。
- 描边：主体深色描边 stroke-width 3-6，比 fill 深一号，立刻有"贴纸感"。

## 画猫/可爱生物的配方（本喵最常被点单）
- 头：正圆或微椭圆；耳朵：两个圆角三角形，内耳小一号浅色。
- 眼睛：开心=两条向下弯的弧线（path 二次贝塞尔，stroke 不 fill）；圆眼=两椭圆 + 白色高光点。
- 腮红：两团椭圆 #FF9FB2 opacity 0.5；胡须：两侧各三条细弧线。
- 身体比头小、四肢简化成椭圆，萌感来自"大头+短四肢"。

## 禁令（渲染器会炸或安全问题）
- 禁 <script>、<foreignObject>、<image>、href/xlink:href、@import、外部 URL。
- 禁 SMIL 动画（<animate> 等）——静态图。
- 禁 CSS <style> 标签——样式全部内联在属性里。

先想清楚画面再动笔：一句话构图（主体是谁/在哪/什么姿势/什么情绪）→ 选色板 → 分层写。`;

export interface ArtworkResult {
  /** 沙盒相对路径（art/xxx.png）——喂给 telegram.sendPhoto / sendFile。 */
  pngPath: string;
  svgPath: string;
  width: number;
  height: number;
}

export interface ArtworkError {
  error: string;
}

const MAX_EDGE = 2560;
const DEFAULT_W = 1024;
const DEFAULT_H = 1024;

/** 从模型输出里掏 SVG：```svg 围栏优先，退化为第一个 <svg 到最后一个 </svg>。 */
export function extractSvg(text: string): string | null {
  const fenced = text.match(/```(?:svg|xml)?\s*(<svg[\s\S]*?<\/svg>)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start >= 0 && end > start) return text.slice(start, end + '</svg>'.length).trim();
  return null;
}

/**
 * 校验 + 修补 SVG。返回 null=不可救药。
 * 修补：补 xmlns（librsvg 没它不渲染）；剥 <?xml?> 头部以外的东西。
 */
export function sanitizeSvg(raw: string): string | null {
  let svg = raw.trim();
  // 安全禁令：脚本/外部引用/foreignObject（librsvg 支持差且是注入面）
  if (/<\s*script/i.test(svg)) return null;
  if (/<\s*foreignObject/i.test(svg)) return null;
  if (/<\s*image/i.test(svg)) return null;
  if (/(xlink:href|href)\s*=/i.test(svg)) return null;
  if (/<\s*animate/i.test(svg)) return null;
  if (!/xmlns\s*=/.test(svg.slice(0, svg.indexOf('>')))) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const verdict = XMLValidator.validate(svg);
  if (verdict !== true) {
    logger.debug({ err: verdict.err?.msg }, 'artist svg failed XML validation');
    return null;
  }
  return svg;
}

/** sharp(librsvg) 光栅化。density 144 ≈ 2x 超采样，发 Telegram 照片够清晰。 */
async function rasterize(svg: string): Promise<{ png: Buffer; width: number; height: number }> {
  const sharp = (await import('sharp')).default;
  const img = sharp(Buffer.from(svg, 'utf8'), { density: 144 });
  const meta = await img.metadata();
  let w = meta.width ?? DEFAULT_W;
  let h = meta.height ?? DEFAULT_H;
  if (w > MAX_EDGE || h > MAX_EDGE) {
    img.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside' });
    const scale = Math.min(MAX_EDGE / w, MAX_EDGE / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const png = await img.png().toBuffer();
  return { png, width: w, height: h };
}

async function callArtist(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const { callWithFallback } = await import('../ai/fallback.js');
  const res = await callWithFallback({
    usage: env().ARTIST_USAGE,
    messages,
    // 4096 足够一张精心 SVG（篇幅纪律 ≤350 行）；关键是 CodeAct 单轮只有
    // CODEACT_TIMEOUT_MS(30s) 预算——token 越少生成越快，别给画师拖稿的空间。
    maxTokens: 4096,
    temperature: 0.7,
    allowHedge: false,
  });
  return res.content ?? '';
}

/**
 * 画图主入口：描述 → SVG → PNG（写进沙盒 art/ 目录）。
 * 一轮绘制 + 一轮修复（把校验/渲染错误喂回模型改稿），两轮都废才报 error。
 */
export async function drawArtwork(
  description: string,
  opts: { width?: number; height?: number } = {},
): Promise<ArtworkResult | ArtworkError> {
  const clean = String(description ?? '').trim();
  if (!clean) return { error: 'empty_description' };
  const w = Math.min(Math.max(Math.round(opts.width ?? DEFAULT_W), 200), 2048);
  const h = Math.min(Math.max(Math.round(opts.height ?? DEFAULT_H), 200), 2048);

  const sizeHint = `画布 ${w}x${h}px。`;
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: ARTIST_SYSTEM },
    { role: 'user', content: `${sizeHint}要画的内容：${clean.slice(0, 600)}` },
  ];

  let lastError = 'unknown';
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: string;
    try {
      out = await callArtist(messages);
    } catch (err) {
      lastError = `llm_call_failed:${err instanceof Error ? err.message : String(err)}`;
      break; // 模型路由挂了，修复轮也救不了
    }
    const raw = extractSvg(out);
    const svg = raw ? sanitizeSvg(raw) : null;
    if (svg) {
      try {
        const { png, width, height } = await rasterize(svg);
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const { sandboxWriteBinary, sandboxWriteFile } = await import('../sandbox/files.js');
        const svgRel = (await sandboxWriteFile(`art/${stamp}.svg`, svg)).path;
        const pngRel = (await sandboxWriteBinary(`art/${stamp}.png`, png)).path;
        logger.info({ description: clean.slice(0, 60), attempt, width, height }, 'artist artwork done');
        return { pngPath: pngRel, svgPath: svgRel, width, height };
      } catch (err) {
        lastError = `rasterize_failed:${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      lastError = raw ? 'svg_invalid_or_forbidden' : 'no_svg_in_output';
    }
    // 修复轮：把废稿原因喂回去，让模型改稿而不是重画。
    messages.push(
      { role: 'assistant', content: out.slice(0, 4000) },
      {
        role: 'user',
        content: `上一稿废了（${lastError}）。对照输出契约和禁令修好，重新输出完整 \`\`\`svg 代码块，块外不写别的。`,
      },
    );
    logger.info({ attempt, lastError }, 'artist draft rejected, asking for repair');
  }
  logger.warn({ description: clean.slice(0, 60), lastError }, 'artist failed after repair round');
  return { error: lastError };
}
