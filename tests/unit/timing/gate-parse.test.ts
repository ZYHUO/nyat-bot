import { describe, it, expect } from 'vitest';
import { parseGateResponse } from '../../../src/pipeline/timing/gate.js';

describe('parseGateResponse', () => {
  it('strict JSON continue', () => {
    const out = parseGateResponse('{"action":"continue","reason":"yes"}');
    expect(out?.action).toBe('continue');
    expect(out?.reason).toBe('yes');
  });

  it('strict JSON wait with seconds', () => {
    const out = parseGateResponse('{"action":"wait","waitSec":30,"reason":"用户还没说完"}');
    expect(out?.action).toBe('wait');
    expect(out?.waitSec).toBe(30);
  });

  it('JSON wrapped in ```json fence', () => {
    const raw = '```json\n{"action":"no_action","reason":"用户在自己聊"}\n```';
    expect(parseGateResponse(raw)?.action).toBe('no_action');
  });

  it('mixed text + JSON object', () => {
    const raw = '我觉得现在不该说话。\n{"action":"no_action","reason":"users互聊"}\n仅供参考';
    expect(parseGateResponse(raw)?.action).toBe('no_action');
  });

  it('snake_case wait_sec accepted', () => {
    const out = parseGateResponse('{"action":"wait","wait_sec":15}');
    expect(out?.action).toBe('wait');
    expect(out?.waitSec).toBe(15);
  });

  it('UPPERCASE ACTION accepted', () => {
    const out = parseGateResponse('{"ACTION":"CONTINUE"}');
    expect(out?.action).toBe('continue');
  });

  it('keyword fallback continue', () => {
    expect(parseGateResponse('I think we should continue here')?.action).toBe('continue');
  });

  it('keyword fallback no_action', () => {
    expect(parseGateResponse('decision: no_action')?.action).toBe('no_action');
  });

  it('keyword fallback wait with seconds', () => {
    const out = parseGateResponse('please wait 45 seconds');
    expect(out?.action).toBe('wait');
    expect(out?.waitSec).toBe(45);
  });

  it('invalid action enum → null', () => {
    expect(parseGateResponse('{"action":"reply"}')).toBeNull();
  });

  it('garbage input → null', () => {
    expect(parseGateResponse('blah blah')).toBeNull();
  });

  it('empty string → null', () => {
    expect(parseGateResponse('')).toBeNull();
  });

  it('truncates long reason', () => {
    const longReason = 'x'.repeat(500);
    const out = parseGateResponse(JSON.stringify({ action: 'continue', reason: longReason }));
    expect(out?.reason.length).toBe(200);
  });
});
