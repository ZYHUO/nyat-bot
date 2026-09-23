import { getLabel } from './src/ai/labels.js';
import { callModel } from './src/ai/provider.js';
const l = getLabel('stepfun');
if (!l) { console.log('NO LABEL'); process.exit(0); }
// 用一个必然触发长思维链的 prompt + 小 maxTokens 之前的真实路径：
// 直接给 4000，让模型自己想（不干预 prompt 内容）
try {
  const r = await callModel(l, [{ role: 'user', content: '请一步一步严格推理，不要跳步：证明任意大于 2 的偶数可以写成两个素数之和（哥德巴赫猜想），并给出你对当前数学界进展的完整推理过程。' }], { maxTokens: 4000 });
  console.log('RESULT content_len=' + (r.content || '').length);
} catch (e) {
  console.log('THREW: ' + (e instanceof Error ? e.message.slice(0, 90) : String(e)));
}
process.exit(0);
