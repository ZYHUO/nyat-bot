import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseJudgeAction } from '../../../src/pipeline/judge/micro.js';

// We test parseJudgeAction separately — it's a pure function
// For callWithFallback tests, we mock the AI provider

describe('parseJudgeAction', () => {
  it('parses valid JSON response', () => {
    const result = parseJudgeAction('{"action": "REPLY", "replyPath": "planned", "replyTier": "pro", "confidence": 0.9, "reasoning": "asked a question"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.replyPath).toBe('planned');
    expect(result!.replyTier).toBe('pro');
    expect(result!.confidence).toBe(0.9);
    expect(result!.reasoning).toBe('asked a question');
  });

  it('maps legacy REPLY_PRO to REPLY + planned + pro', () => {
    const result = parseJudgeAction('{"action": "REPLY_PRO", "confidence": 0.85}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.replyPath).toBe('planned');
    expect(result!.replyTier).toBe('pro');
  });

  it('parses IGNORE', () => {
    const result = parseJudgeAction('{"action": "IGNORE", "confidence": 0.95, "reasoning": "not relevant"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
  });

  it('parses REJECT', () => {
    const result = parseJudgeAction('{"action": "REJECT", "confidence": 1.0}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REJECT');
  });

  it('handles markdown code blocks', () => {
    const result = parseJudgeAction('```json\n{"action": "REPLY", "confidence": 0.8}\n```');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
  });

  it('handles uppercase ACTION key', () => {
    const result = parseJudgeAction('{"ACTION": "IGNORE"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
  });

  it('extracts action from messy JSON', () => {
    const result = parseJudgeAction('Sure, here is my decision:\n{"action": "REPLY", "replyTier": "normal"}\nLet me explain...');
    // This won't parse as JSON directly, but regex should catch it
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
  });

  it('extracts keyword from plain text', () => {
    const result = parseJudgeAction('I think we should IGNORE this message because it is not relevant.');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('IGNORE');
    expect(result!.confidence).toBe(0.3);
  });

  it('maps REPLY_PRO keyword extraction to planned pro reply', () => {
    const result = parseJudgeAction('This deserves a REPLY_PRO response');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.replyPath).toBe('planned');
    expect(result!.replyTier).toBe('pro');
  });

  it('returns null for completely unparseable response', () => {
    const result = parseJudgeAction('I am not sure what to do here.');
    expect(result).toBeNull();
  });

  it('defaults confidence to 0.5 when not provided in JSON', () => {
    const result = parseJudgeAction('{"action": "REPLY"}');
    expect(result).not.toBeNull();
    expect(result!.replyPath).toBe('direct');
    expect(result!.replyTier).toBe('normal');
    expect(result!.confidence).toBe(0.5);
  });

  it('handles lowercase action values', () => {
    const result = parseJudgeAction('{"action": "reply", "replyTier": "pro"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.replyPath).toBe('direct');
    expect(result!.replyTier).toBe('pro');
  });

  it('falls back to default reply path when replyPath is invalid', () => {
    const result = parseJudgeAction('{"action": "REPLY_PRO", "replyPath": "unknown"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.replyPath).toBe('planned');
    expect(result!.replyTier).toBe('pro');
  });

  it('defaults replyTier to normal for REPLY when omitted', () => {
    const result = parseJudgeAction('{"action": "REPLY", "replyPath": "direct"}');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('REPLY');
    expect(result!.replyTier).toBe('normal');
  });
});

// Fallback chain tests - mock the AI provider
describe('Fallback chain logic', () => {
  // These tests verify the callWithFallback logic using mocks
  // We can't easily mock the entire module chain in unit tests,
  // so we test the parse logic above and trust the integration

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('callWithFallback is importable', async () => {
    // Verify the module can be imported without errors
    const mod = await import('../../../src/ai/fallback.js');
    expect(typeof mod.callWithFallback).toBe('function');
  });
});
