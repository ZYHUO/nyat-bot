#!/usr/bin/env python3
"""Cloudflare bypass fetch service — local HTTP API for xxb-ts skill system."""

import subprocess, time, os, sys, atexit, json
from flask import Flask, request, jsonify

app = Flask(__name__)

# Start Xvfb once
xvfb = None
def start_xvfb():
    global xvfb
    if xvfb: return
    xvfb = subprocess.Popen(
        ['Xvfb', ':99', '-screen', '0', '1920x1080x24', '-ac'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    time.sleep(1)
    os.environ['DISPLAY'] = ':99'

def stop_xvfb():
    if xvfb: xvfb.terminate()

atexit.register(stop_xvfb)

def is_challenge_page(title='', text=''):
    haystack = f"{title}\n{text}"
    markers = [
        'Just a moment',
        'Verify you are human',
        '正在进行安全验证',
        '安全服务防护恶意自动程序',
        'challenges.cloudflare.com',
        'Ray ID:',
        '由 Cloudflare 提供',
    ]
    return any(m in haystack for m in markers)

def fetch_with_playwright(url, wait=18, timeout=45):
    """Method 1: Playwright + Xvfb."""
    from playwright.sync_api import sync_playwright
    start_xvfb()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080',
            ]
        )
        ctx = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            locale='zh-CN',
            timezone_id='Asia/Shanghai',
            extra_http_headers={
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Upgrade-Insecure-Requests': '1',
            },
        )
        ctx.add_init_script("""
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
""")
        page = ctx.new_page()
        page.goto(url, wait_until='domcontentloaded', timeout=timeout * 1000)
        deadline = time.time() + wait
        title = page.title()
        body_text = ''
        while time.time() < deadline:
            time.sleep(1)
            title = page.title()
            try:
                body_text = page.inner_text('body', timeout=2000)
            except Exception:
                body_text = ''
            if not is_challenge_page(title, body_text):
                break
        if is_challenge_page(title, body_text):
            browser.close()
            return None  # CF not bypassed
        text = (body_text or page.inner_text('body'))[:10000]
        browser.close()
        return text

def fetch_with_drission(url, wait=8):
    """Method 2: DrissionPage for strict CF."""
    try:
        from DrissionPage import ChromiumPage, ChromiumOptions
    except ImportError:
        return None
    start_xvfb()
    co = ChromiumOptions()
    # Find playwright chromium
    chrome = subprocess.run(
        ['find', '/root/.cache/ms-playwright', '-name', 'chrome', '-type', 'f'],
        capture_output=True, text=True
    ).stdout.strip().split('\n')[0]
    if chrome:
        co.set_browser_path(chrome)
    co.set_argument('--no-sandbox')
    co.set_argument('--disable-blink-features=AutomationControlled')
    co.set_argument('--disable-gpu')
    co.headless(False)
    page = ChromiumPage(co)
    # Visit homepage first for CF cookies
    from urllib.parse import urlparse
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
    page.get(base)
    time.sleep(wait)
    page.get(url)
    time.sleep(5)
    title = page.title
    if is_challenge_page(title):
        page.quit()
        return None
    body = page.ele('tag:body')
    text = body.text[:10000] if body else ''
    if is_challenge_page(title, text):
        page.quit()
        return None
    page.quit()
    return text

@app.route('/fetch')
def cf_fetch():
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "missing url parameter"}), 400

    # Try simple fetch first
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='replace')
            # Strip HTML tags
            import re
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()[:10000]
            if not is_challenge_page('', text) and len(html) > 500:
                return jsonify({"text": text, "method": "direct"})
    except:
        pass

    # Method 1: Playwright
    try:
        text = fetch_with_playwright(url)
        if text:
            return jsonify({"text": text, "method": "playwright"})
    except Exception as e:
        app.logger.warning(f"Playwright failed: {e}")

    # Method 2: DrissionPage
    try:
        text = fetch_with_drission(url)
        if text:
            return jsonify({"text": text, "method": "drissionpage"})
    except Exception as e:
        app.logger.warning(f"DrissionPage failed: {e}")

    return jsonify({"error": "all methods failed", "url": url}), 502

@app.route('/health')
def health():
    return jsonify({"status": "ok"})

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8900)
