import { describe, expect, it } from 'vitest';

import {
  extractLinuxSbTopicId,
  linuxSbForumUrl,
  linuxSbLatestUrl,
  parseLinuxSbList,
  parseLinuxSbTopic,
} from '../../../../src/pipeline/tools/linuxsb.js';

const LIST_HTML = `
<ul class="post-list">
  <li class="post-item topic-pinned">
    <div class="post-body">
      <div class="post-title-row">
        <span class="topic-badge pinned">置顶</span>
        <a class="post-title" href="/topic/17536">【打赏奖励爆率调整通知】每日限10次！</a>
      </div>
      <div class="post-meta">
        <span><a href="/user/1"><svg></svg>站长</a></span>
        <span class="post-forum-meta"><svg></svg><a href="/forum/9">社区公告</a></span>
        <span data-performance-time="1788140859">1小时前</span>
      </div>
    </div>
  </li>
  <li class="post-item">
    <div class="post-body">
      <div class="post-title-row"><a class="post-title" href="/topic/15484">【油猴脚本】宽屏现代 UI</a></div>
      <div class="post-meta"><span><a href="/user/5054"><svg></svg>token</a></span><span>昨天</span></div>
    </div>
    <a class="post-tag post-forum-badge" href="/forum/4">技术交流</a>
  </li>
</ul>`;

const TOPIC_HTML = `
<div class="breadcrumb"><a href="/">首页</a><span>/</span><a href="/forum/1">错误地方</a></div>
<div class="post-topic-title"><h1 class="post-content-title">新人报道</h1></div>
<ul class="post-list topic-post-list">
  <li class="post-item post-entry" id="post-18305">
    <div class="post-info"><a class="post-title post-author" href="/user/21760">南柯一梦</a></div>
    <div class="post-meta"><span class="post-time">1分钟前</span></div>
    <div class="post-content"><div class="long-content-fold-content">大家好，第一次来 linux.sb。<a href="https://example.com">链接</a></div></div>
  </li>
  <li class="post-item post-entry" id="post-18306">
    <div class="post-info"><a class="post-title post-author" href="/user/1">站长</a></div>
    <div class="post-meta"><span class="post-time">刚刚</span></div>
    <div class="post-content">欢迎！</div>
  </li>
</ul>`;

describe('linux.sb tool helpers', () => {
  it('parses latest/forum topic list entries', () => {
    const rows = parseLinuxSbList(LIST_HTML, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 17536,
      title: '【打赏奖励爆率调整通知】每日限10次！',
      author: '站长',
      forum: '社区公告',
      pinned: true,
    });
    expect(rows[0]!.url).toBe('https://linux.sb/topic/17536');
    expect(rows[1]).toMatchObject({ id: 15484, author: 'token', forum: '技术交流', pinned: false });
  });

  it('parses a topic page into title and posts', () => {
    const topic = parseLinuxSbTopic(TOPIC_HTML, 'https://linux.sb/topic/18305', 5);
    expect(topic).toMatchObject({ id: 18305, title: '新人报道', forum: '错误地方' });
    expect(topic.posts).toHaveLength(2);
    expect(topic.posts[0]).toMatchObject({ id: 18305, author: '南柯一梦', time: '1分钟前' });
    expect(topic.posts[0]!.text).toContain('大家好，第一次来 linux.sb。');
  });

  it('extracts topic id from id or URL and builds list URLs', () => {
    expect(extractLinuxSbTopicId('18305')).toBe(18305);
    expect(extractLinuxSbTopicId('https://linux.sb/topic/18305?p=2')).toBe(18305);
    expect(extractLinuxSbTopicId('https://example.com/topic/18305')).toBeNull();
    expect(linuxSbLatestUrl('post')).toBe('https://linux.sb/index.php?sort=post');
    expect(linuxSbLatestUrl('featured')).toBe('https://linux.sb/topic_featured');
    expect(linuxSbForumUrl(4)).toBe('https://linux.sb/forum/4');
  });
});
