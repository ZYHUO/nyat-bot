import { describe, it, expect } from 'vitest';
import { detectCommandIntent } from '../../../src/pipeline/nl-commands.js';

describe('detectCommandIntent', () => {
  it('checkin phrasings → /checkin (llm)', () => {
    for (const s of ['帮我签到', '签到', '打卡', '我要签到', '@nyat 签个到']) {
      expect(detectCommandIntent(s)).toEqual({ cmd: '/checkin', arg: '', kind: 'llm' });
    }
  });

  it('stats phrasings → /stats (llm)', () => {
    expect(detectCommandIntent('签到排行榜')?.cmd).toBe('/stats');
    expect(detectCommandIntent('看看签到排名')?.cmd).toBe('/stats');
  });

  it('cards / 图鉴 → /cards (intercept)', () => {
    for (const s of ['看看我的图鉴', '我的卡册', '我的猫娘卡', '集卡进度']) {
      expect(detectCommandIntent(s)).toEqual({ cmd: '/cards', arg: '', kind: 'intercept' });
    }
  });

  it('wish add only fires for a REAL card name', () => {
    expect(detectCommandIntent('我想要九尾喵')).toEqual({ cmd: '/wish', arg: 'add 九尾喵', kind: 'intercept' });
    expect(detectCommandIntent('想集齐女王喵')).toEqual({ cmd: '/wish', arg: 'add 女王喵', kind: 'intercept' });
    // not a card → must NOT hijack as a wish
    expect(detectCommandIntent('我想要去北京玩')).toBeNull();
  });

  it('wish list / holders / wanted', () => {
    expect(detectCommandIntent('我的心愿单')).toEqual({ cmd: '/wish', arg: '', kind: 'intercept' });
    expect(detectCommandIntent('谁有我想要的卡')).toEqual({ cmd: '/wish', arg: 'holders', kind: 'intercept' });
    expect(detectCommandIntent('谁想要我的卡')).toEqual({ cmd: '/wish', arg: 'wanted', kind: 'intercept' });
  });

  it('watch 关键词追踪已删除：相关表述一律不落命令（2026-08-19）', () => {
    // 群聊关键词追踪功能下线后，NL 路由不再产出 /watch /unwatch /watches。
    // 「留意/关注/追踪」类日常对话必须原样落到正常回复流。
    expect(detectCommandIntent('追踪比特币')).toBeNull();
    expect(detectCommandIntent('帮我留意一下显卡')).toBeNull();
    expect(detectCommandIntent('取消追踪比特币')).toBeNull();
    expect(detectCommandIntent('我追踪了什么')).toBeNull();
    expect(detectCommandIntent('关注比特币')).toBeNull();
    expect(detectCommandIntent('诺亚帮你留意着，不让这份心意落空')).toBeNull();
  });

  it('party games', () => {
    expect(detectCommandIntent('玩真心话')).toEqual({ cmd: '/game', arg: 'tod', kind: 'intercept' });
    expect(detectCommandIntent('大冒险')).toEqual({ cmd: '/game', arg: 'dare', kind: 'intercept' });
    expect(detectCommandIntent('来个二选一')).toEqual({ cmd: '/game', arg: 'wyr', kind: 'intercept' });
  });

  it('help', () => {
    expect(detectCommandIntent('你会什么')?.cmd).toBe('/help');
    expect(detectCommandIntent('你有什么功能')?.cmd).toBe('/help');
  });

  it('does not fire on slash commands or normal chat', () => {
    expect(detectCommandIntent('/checkin')).toBeNull();
    expect(detectCommandIntent('今天天气真好呀')).toBeNull();
    expect(detectCommandIntent('哈哈哈你好可爱')).toBeNull();
    expect(detectCommandIntent('')).toBeNull();
  });
});
