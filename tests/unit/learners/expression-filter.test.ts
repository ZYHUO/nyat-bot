import { describe, it, expect } from 'vitest';
import { isAgreementTail } from '../../../src/learners/expression-filter.js';

describe('isAgreementTail (附和句尾口癖黑名单)', () => {
  it('命中:线上真实翻车的「…是吧」家族', () => {
    for (const s of [
      '…是吧',
      '全自动晦气机是吧',
      '阴间米奇半夜出没是吧',
      '少羽含金量又上去了是吧',
      '…开团了是吧喵',      // 带猫腔后缀
      '越南盲盒是吧',
      '判定大师是吧',
      '复读上瘾是吧',
      'cnm 不回信息是吧',
      '使用 胆子肥了是吧',  // 学习器的"使用 xxx"前缀
    ]) {
      expect(isAgreementTail(s), s).toBe(true);
    }
  });

  it('命中:其他附和尾 对吧/是嘛/行吧/就这吧', () => {
    for (const s of ['这也太强了对吧', '不就是摆烂嘛是嘛', '随便啦行吧', '就这吧', '猫毛炸了对吧喵~']) {
      expect(isAgreementTail(s), s).toBe(true);
    }
  });

  it('不误伤:真正的疑问句 / 有内容的句子', () => {
    for (const s of [
      '你是不是傻',        // 是不是 ≠ 是不
      '这到底对不对',      // 对不对 ≠ 对不
      '今天吃了吗',
      '本喵自封的喵',
      '少前2狐娘诱捕器罢了喵',
      '全球宽带大澡堂喵',
      '出厂自带神秘减益喵',
      '都抱都抱喵',
      '对对对',            // 讽刺赞同(是合法表达,不是句尾标点)
    ]) {
      expect(isAgreementTail(s), s).toBe(false);
    }
  });

  it('空/空白安全', () => {
    expect(isAgreementTail('')).toBe(false);
    expect(isAgreementTail('   ')).toBe(false);
  });
});
