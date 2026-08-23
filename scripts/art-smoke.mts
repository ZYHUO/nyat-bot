// 画摊子冒烟测试：真实调 LLM 出 SVG → 光栅化 → 打印沙盒路径。
// 用法：npx tsx scripts/art-smoke.mts "要画什么" [宽 高]
import { drawArtwork } from '../src/agent/artist.js';

const desc =
  process.argv[2] ??
  '一张「七夕鳗鱼饭兑换券」：奶油暖色系圆角卡片，中间一只开心眯眼的可爱白猫捧着一碗鳗鱼饭，下方大字「鳗鱼饭兑换券」，角落小字「啾咪囝亲手画」';
const w = Number(process.argv[3]) || 1024;
const h = Number(process.argv[4]) || 768;

const r = await drawArtwork(desc, { width: w, height: h });
console.log(JSON.stringify(r, null, 2));
process.exit(0);
