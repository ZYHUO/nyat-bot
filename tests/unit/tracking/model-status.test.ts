import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyModelStatus } from '../../../src/tracking/model-status.js';

describe('classifyModelStatus', () => {
  it('returns "down" on fetch error', () => {
    const result = classifyModelStatus(0, 'connection refused', 0);
    expect(result.status).toBe('down');
  });

  it('returns "down" on HTTP 0 with fetch error', () => {
    const result = classifyModelStatus(0, 'timeout', 5000);
    expect(result.status).toBe('down');
  });

  it('returns "down" on HTTP 500', () => {
    const result = classifyModelStatus(500, '', 200);
    expect(result.status).toBe('down');
  });

  it('returns "down" on HTTP 401', () => {
    const result = classifyModelStatus(401, '', 100);
    expect(result.status).toBe('down');
  });

  it('returns "slow" on HTTP 429 without long cooldown', () => {
    const result = classifyModelStatus(429, '', 200);
    expect(result.status).toBe('slow');
  });

  it('returns "down" on HTTP 429 with long cooldown', () => {
    const body = JSON.stringify({ error: { code: 'model_cooldown', reset_seconds: 300 } });
    const result = classifyModelStatus(429, '', 200, body);
    expect(result.status).toBe('down');
  });

  it('returns "down" on HTTP 429 with very low latency (instant rejection)', () => {
    const result = classifyModelStatus(429, '', 10);
    expect(result.status).toBe('down');
  });

  it('returns "up" on HTTP 200 with normal latency', () => {
    const result = classifyModelStatus(200, '', 1500);
    expect(result.status).toBe('up');
    expect(result.latencyMs).toBe(1500);
  });

  it('returns "slow" on high latency (>5s)', () => {
    const result = classifyModelStatus(200, '', 8000);
    expect(result.status).toBe('slow');
  });

  it('returns "down" on very high latency (>15s)', () => {
    const result = classifyModelStatus(200, '', 16000);
    expect(result.status).toBe('down');
  });

  it('returns "up" on HTTP 200 with fast latency', () => {
    const result = classifyModelStatus(200, '', 200);
    expect(result.status).toBe('up');
  });

  it('preserves latencyMs in result', () => {
    const result = classifyModelStatus(200, '', 3456);
    expect(result.latencyMs).toBe(3456);
  });

  it('handles malformed cooldown body gracefully', () => {
    const result = classifyModelStatus(429, '', 200, 'not json');
    expect(result.status).toBe('slow');
  });

  it('handles cooldown with short reset time', () => {
    const body = JSON.stringify({ error: { code: 'model_cooldown', reset_seconds: 30 } });
    const result = classifyModelStatus(429, '', 200, body);
    expect(result.status).toBe('slow');
  });
});
