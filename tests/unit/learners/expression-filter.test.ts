import { describe, it, expect } from 'vitest';
import { isAgreementTail, isBannedExpression } from '../../../src/learners/expression-filter.js';

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

describe('isBannedExpression (自激口癖总黑名单)', () => {
  it('命中:附和句尾(向后兼容 isAgreementTail)', () => {
    expect(isBannedExpression('全自动晦气机是吧')).toBe(true);
    expect(isBannedExpression('这也太强了对吧')).toBe(true);
  });

  it('命中:「我勒个X」句首口癖(当前失控的复读模板)', () => {
    for (const s of ['使用 我勒个xxx', '我勒个锄大地', '我勒个狠活', '我勒个出片还是快']) {
      expect(isBannedExpression(s), s).toBe(true);
    }
  });

  it('命中:光一个填充词的模板', () => {
    for (const s of ['确实', '对对对', '对对', '嗯嗯', '属于是', '使用"草"', '使用 坏', '狠活']) {
      expect(isBannedExpression(s), s).toBe(true);
    }
  });

  it('命中:meta 规则(把"怎么说话"当表达学了)', () => {
    for (const s of ['本喵+动词,体现猫的身份', '喵呜!开头,多用感叹号', '语气词拉满']) {
      expect(isBannedExpression(s), s).toBe(true);
    }
  });

  it('不误伤:有实际内容的表达照常学/注入', () => {
    for (const s of [
      '少前2狐娘诱捕器罢了喵',
      '全球宽带大澡堂喵',
      '都抱都抱喵',
      '确实有点意思,不过得看节点',   // 「确实」开头但有后文,不是光一个词
      '本喵今天不想理你',             // 含本喵但是真句子,非 meta 说明
    ]) {
      expect(isBannedExpression(s), s).toBe(false);
    }
  });

  it('空/空白安全', () => {
    expect(isBannedExpression('')).toBe(false);
    expect(isBannedExpression('   ')).toBe(false);
  });
});
