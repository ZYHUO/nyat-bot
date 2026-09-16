/* eslint-disable @typescript-eslint/no-explicit-any */
import { env } from '../env.js';
import { resolveScreenshotDir } from './paths.js';
import { join } from 'node:path';

type AnyBrowser = any;
type AnyPage = any;

let _browser: AnyBrowser | undefined;
let _page: AnyPage | undefined;
let _inactivityTimer: ReturnType<typeof setTimeout> | undefined;

async function loadPlaywright(): Promise<{ chromium: { launch(opts?: Record<string, unknown>): Promise<AnyBrowser> } }> {
  const moduleName = 'playwright';
  const mod = (await import(moduleName)) as { chromium: { launch(opts?: Record<string, unknown>): Promise<AnyBrowser> } };
  if (!mod?.chromium) throw new Error('playwright module has no chromium export');
  return mod;
}

function resetInactivityTimer(): void {
  if (_inactivityTimer) clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => { void browserClose(); }, 60_000);
  if (typeof _inactivityTimer === 'object' && _inactivityTimer && 'unref' in _inactivityTimer) {
    (_inactivityTimer as NodeJS.Timeout).unref?.();
  }
}

export async function browserOpen(url: string): Promise<{ title: string; url: string }> {
  if (!env().SANDBOX_BROWSER_ENABLED) throw new Error('browser disabled');
  if (!_page) {
    const { chromium } = await loadPlaywright();
    _browser = await chromium.launch({ headless: true });
    const ctx = await _browser.newContext({ viewport: { width: 1280, height: 720 } });
    _page = await ctx.newPage();
  }
  await _page.goto(url, { timeout: 30_000 });
  const title = await _page.title();
  resetInactivityTimer();
  return { title, url: _page.url() };
}

export async function browserScreenshot(): Promise<{ path: string }> {
  if (!_page) throw new Error('browser not open — call computer.browse(url) first');
  const dir = resolveScreenshotDir();
  const filename = `screenshot-${Date.now()}.png`;
  const filepath = join(dir, filename);
  await _page.screenshot({ path: filepath, fullPage: false });
  resetInactivityTimer();
  return { path: filepath };
}

export async function browserClick(selector: string): Promise<{ ok: boolean }> {
  if (!_page) throw new Error('browser not open');
  await _page.click(selector, { timeout: 10_000 });
  resetInactivityTimer();
  return { ok: true };
}

export async function browserType(selector: string, text: string): Promise<{ ok: boolean }> {
  if (!_page) throw new Error('browser not open');
  await _page.fill(selector, text, { timeout: 10_000 });
  resetInactivityTimer();
  return { ok: true };
}

export async function browserGetText(selector?: string): Promise<{ text: string }> {
  if (!_page) throw new Error('browser not open');
  const text = selector
    ? await _page.textContent(selector, { timeout: 10_000 })
    : await _page.textContent('body');
  resetInactivityTimer();
  return { text: String(text ?? '').slice(0, 4000) };
}

export async function browserEval(js: string): Promise<{ result: string }> {
  if (!_page) throw new Error('browser not open');
  const result = await _page.evaluate(js);
  resetInactivityTimer();
  return { result: typeof result === 'string' ? result.slice(0, 4000) : JSON.stringify(result)?.slice(0, 4000) ?? 'undefined' };
}

export async function browserScroll(direction: 'up' | 'down', amount = 500): Promise<{ ok: boolean }> {
  if (!_page) throw new Error('browser not open');
  const delta = direction === 'down' ? amount : -amount;
  await _page.evaluate(`window.scrollBy(0, ${delta})`);
  resetInactivityTimer();
  return { ok: true };
}

export async function browserClose(): Promise<{ ok: boolean }> {
  if (_inactivityTimer) { clearTimeout(_inactivityTimer); _inactivityTimer = undefined; }
  try {
    if (_page) { await _page.close(); _page = undefined; }
    if (_browser) { await _browser.close(); _browser = undefined; }
  } catch { /* non-critical */ }
  return { ok: true };
}
