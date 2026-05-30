// ────────────────────────────────────────
// Party games — one-shot conversational prompts for group chats.
// Curated lists (no LLM), random pick. /game tod | wyr | nhie | dare
// ────────────────────────────────────────

const TRUTH: string[] = [
  '群里你最想认识的人是谁？',
  '最近一次脸红是因为什么？',
  '手机里舍不得删的一张照片是什么？',
  '最丢人的一次社死现场？',
  '你偷偷羡慕群里谁的什么？',
  '最近一次撒的小谎是什么？',
  '你单曲循环到烂的一首歌？',
  '凌晨三点还没睡时你在想什么？',
];

const DARE: string[] = [
  '用最近一张表情包当头像 10 分钟',
  '给群里随机一个人发一句真诚的夸夸',
  '用语音念一句绕口令发群里',
  '把昵称改成「今天最听话的崽」保持半小时',
  '发一张你现在所在位置的照片（不暴露隐私）',
  '模仿一个群友说话的口吻发一句',
];

const WYR: string[] = [
  '一辈子只能吃甜的 vs 只能吃辣的？',
  '能飞但很慢 vs 能瞬移但每天一次？',
  '永远早睡早起 vs 永远熬夜但精神好？',
  '读懂所有动物的话 vs 学会世界所有语言？',
  '回到过去改一件事 vs 看到一年后的自己？',
  '钱花不完但没朋友 vs 朋友超多但总缺钱？',
];

const NHIE: string[] = [
  '我从没有……熬夜追剧到天亮',
  '我从没有……给偶像花过钱',
  '我从没有……假装没看见消息',
  '我从没有……一个人吃过火锅',
  '我从没有……上课/上班偷偷摸鱼打游戏',
  '我从没有……把外卖备注写得很可爱',
];

function pick(arr: string[]): string { return arr[Math.floor(Math.random() * arr.length)]!; }

/** Returns a party-game message for a mode, or null if the mode is unknown. */
export function partyGame(mode: string): string | null {
  switch (mode) {
    case 'tod': case '真心话': return `🎲 真心话：${pick(TRUTH)}\n（不敢答？/game dare 换大冒险）`;
    case 'dare': case '大冒险': return `🔥 大冒险：${pick(DARE)}`;
    case 'wyr': case '二选一': return `🤔 二选一：${pick(WYR)}`;
    case 'nhie': case '我从未': return `🙈 我从未：${pick(NHIE)}\n（中枪的扣 1~）`;
    default: return null;
  }
}
