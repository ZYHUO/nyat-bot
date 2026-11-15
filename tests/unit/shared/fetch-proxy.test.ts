import { describe, it, expect } from 'vitest';
import { isDirectUrl, installGlobalFetchProxy } from '../../../src/shared/fetch-proxy.js';

describe('fetch-proxy isDirectUrl', () => {
  it('本地地址直连', () => {
    expect(isDirectUrl('http://127.0.0.1:6333/collections')).toBe(true);
    expect(isDirectUrl('http://localhost:6379')).toBe(true);
    expect(isDirectUrl('http://192.168.1.5:3000/v1')).toBe(true);
    expect(isDirectUrl('http://172.16.0.11:22')).toBe(true);
    expect(isDirectUrl('http://10.0.0.5/v1')).toBe(true);
    expect(isDirectUrl('redis://127.0.0.1:6379/0')).toBe(true);
  });
  it('公网地址走代理', () => {
    expect(isDirectUrl('https://api.telegram.org/bot123:getMe')).toBe(false);
    expect(isDirectUrl('https://api.stepfun.com/step_plan/v1')).toBe(false);
    expect(isDirectUrl('https://generativelanguage.googleapis.com/v1beta/models')).toBe(false);
  });
  it('空代理 = 不安装', () => {
    expect(installGlobalFetchProxy(undefined)).toBe(false);
    expect(installGlobalFetchProxy('')).toBe(false);
  });
});
