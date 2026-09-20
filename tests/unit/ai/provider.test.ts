import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AILabel } from '../../../src/ai/types.js';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((model: string) => ({ model }))),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { callModel } = await import('../../../src/ai/provider.js');
const { generateText } = await import('ai');

function makeSseResponse(chunks: string[], usage?: { prompt_tokens: number; completion_tokens: number }) {
  const lines: string[] = chunks.map(c =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
  );
  lines.push('data: [DONE]\n\n');
  const body = lines.join('');

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('callModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes audio parts as input_audio and uses the raw fetch path', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: '一段猫叫' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));

    const label: AILabel = {
      name: 'audio',
      endpoint: 'https://audio.example/v1',
      apiKeys: ['audio-key'],
      model: 'gpt-4o-audio-preview',
    };

    const result = await callModel(label, [{
      role: 'user',
      content: [
        { type: 'audio', audio: 'QkFTRTY0', format: 'ogg' },
        { type: 'text', text: '这是什么?' },
      ],
    }], { maxTokens: 50 });

    expect(result.content).toBe('一段猫叫');
    // audio must NOT go through the AI SDK generateText path — raw fetch only
    expect(fetch).toHaveBeenCalledOnce();
    const part = capturedBody.messages[0].content[0];
    expect(part).toEqual({ type: 'input_audio', input_audio: { data: 'QkFTRTY0', format: 'ogg' } });
  });

  // 2026-09-21 回归：claude 分支原来把 content parts 映射成
  // `p.type === 'text' ? p.text : ''` —— 图片/音频/视频全被换成空字符串。
  // 调用方以为发了媒体，模型只收到文字，于是回"我没看到视频呀"，而 prompt token
  // 数也对得上（只有文字）。**没有任何报错**，是最难发现的那类静默 bug。
  describe('FORMAT=claude 的 label 不再静默丢弃媒体', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        (globalThis as { __body?: unknown }).__body = JSON.parse(init.body as string);
        return Promise.resolve(new Response(
          JSON.stringify({
            choices: [{ message: { content: '看到了' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      }));
    });

    const claudeLabel: AILabel = {
      name: 'step5',
      endpoint: 'https://api.stepfun.com/step_plan/v1',
      apiKeys: ['k'],
      model: 'step-5-preview',
      apiFormat: 'claude',
    };

    it('video_url part 真的进请求体（不变成空字符串）', async () => {
      const r = await callModel(claudeLabel, [{
        role: 'user',
        content: [
          { type: 'text', text: '这视频里有什么' },
          { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } },
        ],
      }], { maxTokens: 100 });
      expect(r.content).toBe('看到了');
      const body = (globalThis as { __body?: { messages: Array<{ content: Array<Record<string, unknown>> }> } }).__body!;
      const parts = body.messages[0]!.content;
      // 文本必须在，视频 part 必须原样序列化——不能是 ''
      expect(parts[0]).toEqual({ type: 'text', text: '这视频里有什么' });
      expect(parts[1]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } });
      expect(parts.filter((p) => JSON.stringify(p) === '""' || p.type === undefined)).toHaveLength(0);
    });

    it('image part 同样不再被丢弃（同一条路径，顺带修好）', async () => {
      await callModel(claudeLabel, [{
        role: 'user',
        content: [
          { type: 'text', text: '图里有什么' },
          { type: 'image', image: 'data:image/png;base64,QUJD' },
        ],
      }], { maxTokens: 100 });
      const body = (globalThis as { __body?: { messages: Array<{ content: Array<Record<string, unknown>> }> } }).__body!;
      expect(body.messages[0]!.content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,QUJD', detail: 'high' },
      });
    });

    // ─── 2026-09-21：思维链吃光 max_tokens → 空正文 ────────────────────────
    //
    // 日志实测：`Empty response` 2882 次（stepfunthink 1481 / stepfunvision 685 /
    // stepfun 583 / stepfunjudge 133），是心流 "All labels exhausted"（占心流失败
    // 64%）的主要来源。旧行为把它当普通空响应交给 fallback 链，而 backup 常常是
    // 同一个账号的另一个 label，撞同一个限额，于是一次性全灭。
    describe('claude 分支：截断导致空正文时加额重试', () => {
      const anthropicOk = (text: string, stopReason = 'end_turn') => new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          stop_reason: stopReason,
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      const anthropicThinkingOnly = (stopReason = 'max_tokens') => new Response(
        JSON.stringify({
          content: [{ type: 'thinking', thinking: '想了很多但没来得及说' }],
          stop_reason: stopReason,
          usage: { input_tokens: 10, output_tokens: 4096 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

      it('stop_reason=max_tokens 且只有 thinking → 加额重试，第二次成功', async () => {
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          const b = JSON.parse(init.body as string) as { max_tokens: number };
          calls.push(b.max_tokens);
          return Promise.resolve(calls.length === 1 ? anthropicThinkingOnly('max_tokens') : anthropicOk('{"act":"pass"}'));
        }));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 4096, temperature: 0 });
        expect(r.content).toBe('{"act":"pass"}');
        expect(calls).toEqual([4096, 8192]); // 第一次原额度，第二次翻倍
      });

      it('stop_reason=end_turn 但只有 thinking → 不重试（不是截断，重试没意义）', async () => {
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          return Promise.resolve(anthropicThinkingOnly('end_turn'));
        }));
        // callModel 自己不抛空（rejectEmpty 是 callWithFallback 那层的事），
        // 这里验的是"不重试"。
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 4096 });
        expect(r.content).toBe('');
        expect(calls).toEqual([4096]); // 只调一次
      });

      it('重试也截断 → 仍报 Empty response（交回 fallback 链，不假装成功）', async () => {
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          return Promise.resolve(anthropicThinkingOnly('max_tokens'));
        }));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 4096 });
        expect(r.content).toBe('');
        expect(calls).toEqual([4096, 8192]); // 试过了，两次
      });

      it('正常有正文 → 一次成功，不重试', async () => {
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          return Promise.resolve(anthropicOk('{"act":"reply"}'));
        }));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 4096 });
        expect(r.content).toBe('{"act":"reply"}');
        expect(calls).toEqual([4096]);
      });

      it('额度翻倍有上界（32k），不会无限涨', async () => {
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          return Promise.resolve(anthropicThinkingOnly('max_tokens'));
        }));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 20000 });
        expect(r.content).toBe('');
        expect(calls).toEqual([20000, 32000]); // 20000*2=40000 → 钳到 32000
      });
    });

    // ─── 2026-09-21：reasoning 下限 ────────────────────────────────────
    //
    // 实测起因：`claude: 空正文` 诊断上线后 50 分钟 193 次，全部
    // stop_reason=max_tokens + blocks=['thinking']，maxTokens 是 24/48/1200/4000/…
    // 24 来自 topic-scan（"用 4-12 个汉字起个标签"于是写 maxTokens: 24）。
    // reasoning 模型思维链先烧 token，24 连一句"让我想想"都不够。
    // 上一轮的"翻倍重试"在这里也不够：24→48 照样空（诊断里 48 出现 73 次）。
    describe('reasoning 下限（观测到截断的 label 自动抬到 1200）', () => {
      const truncOnce = (stopReason = 'max_tokens') => new Response(
        JSON.stringify({
          content: [{ type: 'thinking', thinking: '想了很多但没来得及说' }],
          stop_reason: stopReason,
          usage: { input_tokens: 10, output_tokens: 24 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      const okOnce = (text = '{"ok":1}') => new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200, headers: { 'ContentType': 'application/json' } },
      );

      it('重试用下限（1200）而不是 2×——24 翻倍成 48 照样不够', async () => {
        const { __resetTruncatingLabelsForTest } = await import('../../../src/ai/provider.js');
        __resetTruncatingLabelsForTest();
        const calls: number[] = [];
        let n = 0;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          const b = JSON.parse(init.body as string) as { max_tokens: number };
          calls.push(b.max_tokens);
          n++;
          return Promise.resolve(n === 1 ? truncOnce() : okOnce());
        }));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 24 });
        expect(r.content).toBe('{"ok":1}');
        expect(calls).toEqual([24, 1200]); // 第一次照调用方的 24，重试直接抬到下限
      });

      it('记住之后，同一个 label 的后续调用直接拿下限（不再先撞一次）', async () => {
        const { __resetTruncatingLabelsForTest } = await import('../../../src/ai/provider.js');
        __resetTruncatingLabelsForTest();
        const calls: number[] = [];
        let n = 0;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          const b = JSON.parse(init.body as string) as { max_tokens: number };
          calls.push(b.max_tokens);
          n++;
          return Promise.resolve(n === 1 ? truncOnce() : okOnce());
        }));
        await callModel(claudeLabel, [{ role: 'user', content: 'a' }], { maxTokens: 24 });
        await callModel(claudeLabel, [{ role: 'user', content: 'b' }], { maxTokens: 24 });
        // 第三次应该直接用 1200，不再先发 24 撞一次
        await callModel(claudeLabel, [{ role: 'user', content: 'c' }], { maxTokens: 24 });
        expect(calls).toEqual([24, 1200, 1200, 1200]);
      });

      it('调用方已经给了大于下限的值 → 不压（尊重显式配置）', async () => {
        const { __resetTruncatingLabelsForTest } = await import('../../../src/ai/provider.js');
        __resetTruncatingLabelsForTest();
        const calls: number[] = [];
        let n = 0;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          n++;
          return Promise.resolve(n === 1 ? truncOnce() : okOnce());
        }));
        await callModel(claudeLabel, [{ role: 'user', content: 'a' }], { maxTokens: 8000 });
        // 8000 > 1200：第一次照 8000 发（不被压成下限），重试按 2× 抬到 16000。
        // 下限只托底，不封顶。
        expect(calls).toEqual([8000, 16000]);
      });

      it('没截断过的 label 完全不受影响（零额外成本）', async () => {
        const { __resetTruncatingLabelsForTest } = await import('../../../src/ai/provider.js');
        __resetTruncatingLabelsForTest();
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          return Promise.resolve(okOnce());
        }));
        await callModel(claudeLabel, [{ role: 'user', content: 'a' }], { maxTokens: 24 });
        expect(calls).toEqual([24]); // 原样，不抬
      });

      it('重试也截断 → 仍报空，且 label 已被记住', async () => {
        const { __resetTruncatingLabelsForTest } = await import('../../../src/ai/provider.js');
        __resetTruncatingLabelsForTest();
        const calls: number[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          calls.push((JSON.parse(init.body as string) as { max_tokens: number }).max_tokens);
          return Promise.resolve(truncOnce());
        }));
        const r = await callModel(claudeLabel, [{ role: 'user', content: 'a' }], { maxTokens: 24 });
        expect(r.content).toBe('');
        expect(calls).toEqual([24, 1200]);
        // 第三次直接 1200（记住了，不再先发 24 撞一次）；1200 也截断 → 重试 2× = 2400
        await callModel(claudeLabel, [{ role: 'user', content: 'b' }], { maxTokens: 24 });
        expect(calls).toEqual([24, 1200, 1200, 2400]);
      });
    });

    // ─── 2026-09-21：jsonMode 在 claude 路径上也要生效 ──────────────────
    //
    // 实测起因：`dreaming output unparseable — skipped` **805 次，
    // 而 `dreaming consolidated` 一次都没出现过**（0% 产出）；
    // `distill output unparseable` 473 vs `episode distilled` 73（13.4%）。
    //
    // 病因：这两个 usage 默认 jsonMode: true，label 是 stepfun（FORMAT=claude）。
    // jsonMode 此前只对裸 fetch 的 OpenAI 路径设 response_format，claude 分支
    // 根本不看它——模型收到"请输出 JSON"的 prompt 却没有任何机制逼它，
    // 回中文散文，JSON.parse 失败，整次调用被丢弃。
    describe('claude 分支的 jsonMode（assistant 预填 {）', () => {
      const okJson = (text: string) => new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

      it('请求体末尾多一条 assistant "{"（prefill）', async () => {
        let body: { messages: Array<{ role: string; content: string }> } | undefined;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          body = JSON.parse(init.body as string);
          return Promise.resolve(okJson('"act":"pass"}'));
        }));
        await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 1200, jsonMode: true });
        expect(body!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(body!.messages[1]!.content).toBe('{');
      });

      it('正文把 "{" 拼回去（调用方拿到完整 JSON）', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(okJson('"act":"pass","why":"q"}'))));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 1200, jsonMode: true });
        expect(r.content).toBe('{"act":"pass","why":"q"}');
        expect(() => JSON.parse(r.content)).not.toThrow();
      });

      it('模型自己吐了完整 "{" 开头 → 不重复拼', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(okJson('{"act":"pass"}'))));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 1200, jsonMode: true });
        expect(r.content).toBe('{"act":"pass"}');
        expect(r.content.startsWith('{{')).toBe(false);
      });

      it('jsonMode 不开 → 不加 prefill（纯文本调用不受影响）', async () => {
        let body: { messages: Array<{ role: string }> } | undefined;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          body = JSON.parse(init.body as string);
          return Promise.resolve(okJson('随便'));
        }));
        await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 1200 });
        expect(body!.messages.map((m) => m.role)).toEqual(['user']);
      });

      it('最后一条本来就是 assistant → 不重复加 prefill', async () => {
        let body: { messages: Array<{ role: string; content: string }> } | undefined;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          body = JSON.parse(init.body as string);
          return Promise.resolve(okJson('"ok":1}'));
        }));
        await callModel(claudeLabel, [
          { role: 'user', content: '判断' },
          { role: 'assistant', content: '{"a"' },
        ], { maxTokens: 1200, jsonMode: true });
        expect(body!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(body!.messages[1]!.content).toBe('{"a"'); // 原样，不覆盖
      });

      it('system 消息不参与 prefill 位置判断', async () => {
        let body: { messages: Array<{ role: string }> } | undefined;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init: RequestInit) => {
          body = JSON.parse(init.body as string);
          return Promise.resolve(okJson('"ok":1}'));
        }));
        await callModel(claudeLabel, [
          { role: 'system', content: '你是判断器' },
          { role: 'user', content: '判断' },
        ], { maxTokens: 1200, jsonMode: true });
        expect(body!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      });

      it('空正文 + jsonMode → 仍然是空（prefill 不伪造内容）', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(
          JSON.stringify({ content: [{ type: 'thinking', thinking: '想' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1200 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ))));
        const r = await callModel(claudeLabel, [{ role: 'user', content: '判断' }], { maxTokens: 1200, jsonMode: true });
        expect(r.content).toBe('');
      });
    });

    it('纯文本仍走 claude 分支（不为带媒体改掉正常路径）', async () => {
      // 纯文本 + claude label → callClaude：打 /messages 且请求体是 Anthropic 形状
      // （messages[].content 是字符串，不是 parts 数组）。
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
        (globalThis as { __claudeBody?: unknown }).__claudeBody = JSON.parse(init.body as string);
        return Promise.resolve(new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '喵' }],
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      }));
      const r = await callModel(claudeLabel, [{ role: 'user', content: '你好' }], { maxTokens: 50 });
      expect(r.content).toBe('喵');
      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(String(url)).toContain('/messages');
      const body = (globalThis as { __claudeBody?: { messages: Array<{ content: unknown }> } }).__claudeBody!;
      expect(body.messages[0]!.content).toBe('你好'); // 纯文本仍是字符串，没被拆成 parts
    });
  });

  it('forceRaw + 空 choices → 走 raw fetch、抛 AI_EMPTY(不崩 reading message)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const label: AILabel = {
      name: 'gemini35low', endpoint: 'http://relay/v1', apiKeys: ['k'],
      model: 'gemini-3.5-flash-low', forceRaw: true,
    };
    await expect(callModel(label, [{ role: 'user', content: 'hi' }], { maxTokens: 50 })).rejects.toMatchObject({
      code: 'AI_EMPTY',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('forceRaw + choices[0] 无 message → 同样抛 AI_EMPTY', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ finish_reason: 'content_filter' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const label: AILabel = {
      name: 'gemini35low', endpoint: 'http://relay/v1', apiKeys: ['k'],
      model: 'gemini-3.5-flash-low', forceRaw: true,
    };
    await expect(callModel(label, [{ role: 'user', content: 'hi' }], { maxTokens: 50 })).rejects.toMatchObject({
      code: 'AI_EMPTY',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('forceRaw + 空 content 时仅回退结构化 reasoning_content（WRITE/JSON）', async () => {
    const label: AILabel = {
      name: 'grok45', endpoint: 'http://relay/v1', apiKeys: ['k'],
      model: 'grok-4.5', forceRaw: true, reasoningEffort: 'low',
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'WRITE\n\n本喵困了' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const diary = await callModel(label, [{ role: 'user', content: '日记' }], { maxTokens: 50 });
    expect(diary.content).toContain('本喵困了');

    // 裸 CoT 散文不得当正文（会进群）——当作空响应
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: '让我想想用户在说什么…' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(callModel(label, [{ role: 'user', content: 'hi' }], { maxTokens: 50 })).rejects.toMatchObject({
      code: 'AI_EMPTY',
    });
  });

  it('returns stream token usage for stream-only providers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      makeSseResponse(['<thinking>internal</thinking>', 'hello'])
    ));

    const label: AILabel = {
      name: 'reply_max_gpt54pro',
      endpoint: 'https://openai.example/v1',
      apiKeys: ['openai-key'],
      model: 'gpt-5.4',
      stream: true,
    };

    const result = await callModel(label, [{ role: 'user', content: 'ping' }], { maxTokens: 10 });

    expect(result.content).toBe('hello');
    expect(fetch).toHaveBeenCalledWith(
      'https://openai.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer openai-key' }),
      })
    );
  });

  it('jsonMode sets response_format when the prompt contains "json"', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: '{"replyContent":"hi","targetMessageId":1}' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));
    const label: AILabel = { name: 'deepseek', endpoint: 'https://ds.example/v1', apiKeys: ['k'], model: 'deepseek-v4-flash', disableThinking: true };

    await callModel(label, [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: 'hi' }], { maxTokens: 50, jsonMode: true });
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  it('jsonMode does NOT set response_format when the prompt lacks "json" (avoids DeepSeek hard-error)', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    }));
    const label: AILabel = { name: 'deepseek', endpoint: 'https://ds.example/v1', apiKeys: ['k'], model: 'deepseek-v4-flash', disableThinking: true };

    await callModel(label, [{ role: 'user', content: '回复:你好' }], { maxTokens: 50, jsonMode: true });
    expect(capturedBody.response_format).toBeUndefined();
  });

  it('classifies StepFun raw HTTP 451 censorship_blocked as content rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'The content you provided or machine outputted is blocked.',
            type: 'censorship_blocked',
          },
        }),
        { status: 451, headers: { 'Content-Type': 'application/json' } },
      ),
    ));
    const label: AILabel = {
      name: 'stepfun',
      endpoint: 'https://api.stepfun.com/step_plan/v1',
      apiKeys: ['k'],
      model: 'step-3.7-flash',
      reasoningEffort: 'medium',
    };

    await expect(callModel(label, [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ code: 'AI_CONTENT_REJECTED', provider: 'stepfun' });
  });

  it('classifies StepFun SDK blocked text as content rejection', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error('The content you provided or machine outputted is blocked.'),
    );
    const label: AILabel = {
      name: 'stepfunjudge',
      endpoint: 'https://api.stepfun.com/step_plan/v1',
      apiKeys: ['k'],
      model: 'step-3.5-flash',
    };

    await expect(callModel(label, [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ code: 'AI_CONTENT_REJECTED', provider: 'stepfunjudge' });
  });
});
