import { logger } from '../shared/logger.js';

export interface Challenge {
  question: string;
  answer: string;
  options: string[];
  type: 'math' | 'logic' | 'trivia';
}

const CHALLENGE_SYSTEM_PROMPT = `你是一个出题机器人。请生成一道验证题目，用于验证 Telegram 用户不是自动化 bot。

要求：
1. 随机选择类型：数学运算、逻辑推理、常识问答
2. 数学题：2-3 个运算符的混合运算，注意优先级，答案必须是整数
3. 逻辑题：数列推理、模式匹配、简单推理
4. 常识题：日常生活、自然常识、语言理解
5. 难度适中，人类 10 秒内可答，但对自动化 bot 有防御作用
6. 提供 4 个选项，其中 1 个正确答案，3 个干扰项
7. 干扰项要合理（接近正确答案，不能太离谱）

严格输出 JSON，不要输出其他内容：
{"question":"题目描述","answer":"正确答案","options":["选项1","选项2","选项3","选项4"],"type":"math"}

注意：
- answer 必须和 options 中的某一项完全一致（字符串相等）
- options 顺序随机
- 只输出 JSON，不要输出任何解释`;

export async function generateChallenge(
  aiCall: (systemPrompt: string, userMessage: string) => Promise<string | null>,
): Promise<Challenge | null> {
  const seed = `seed:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  try {
    const raw = await aiCall(CHALLENGE_SYSTEM_PROMPT, `请生成一道新题目。${seed}`);
    if (!raw) return null;

    const challenge = parseChallenge(raw);
    if (!challenge) {
      logger.warn({ raw: raw.slice(0, 200) }, 'Failed to parse challenge JSON');
      return null;
    }

    // 验证 answer 在 options 中
    if (!challenge.options.includes(challenge.answer)) {
      logger.warn({ challenge }, 'Answer not found in options');
      return null;
    }

    // 打乱选项顺序
    shuffleArray(challenge.options);

    return challenge;
  } catch (err) {
    logger.warn({ err }, 'Challenge generation failed');
    return null;
  }
}

export function parseChallenge(raw: string): Challenge | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const question = typeof parsed.question === 'string' ? parsed.question : '';
    const answer = typeof parsed.answer === 'string' ? parsed.answer : '';
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === 'string')
      : [];
    const type = parsed.type;

    if (!question || !answer || options.length < 2) return null;
    if (type !== 'math' && type !== 'logic' && type !== 'trivia') return null;

    return { question, answer, options, type };
  } catch {
    return null;
  }
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
