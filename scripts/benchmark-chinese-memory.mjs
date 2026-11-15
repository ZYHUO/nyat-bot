// Synthetic local fixture only: no bot config, production messages, SQLite or Qdrant access.
// Run with Node 22 from the checkout. Offline by default; --allow-download fetches model assets.
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const models = (option('models') ?? 'Xenova/all-MiniLM-L6-v2,Xenova/paraphrase-multilingual-MiniLM-L12-v2').split(',');
const inputMode = option('input-mode') ?? 'production';
if (!['production', 'raw'].includes(inputMode)) throw new Error('input-mode must be production or raw');

const documents = [
  ['coffee', '小林不喝咖啡，晚上喝了会睡不着。'],
  ['tea', '小林喜欢茉莉花茶，泡茶时不放糖。'],
  ['flight', '小周星期三上午坐飞机去杭州出差。'],
  ['train', '小王星期五晚上坐高铁去南京看朋友。'],
  ['database', '昨晚服务报错是因为数据库连接数满了，扩容连接池以后恢复了。'],
  ['disk', '备份失败的原因是磁盘空间不足，清理临时文件后重试成功。'],
  ['cat', '小李家的橘猫叫团子，最爱吃鸡肉罐头。'],
  ['dog', '小赵养了一只柴犬，名字叫豆包。'],
  ['meeting', '项目周会改到周四下午三点，线上开会。'],
  ['dinner', '聚餐约在周六晚上七点，地点是楼下火锅店。'],
  ['allergy', '小陈对花生过敏，点外卖时需要避开花生和花生油。'],
  ['taste', '小张不喜欢香菜，但不是食物过敏。'],
  ['game', '阿明最近在玩星露谷物语，最喜欢种田钓鱼。'],
  ['music', '阿文练吉他两个月了，正在练习和弦转换。'],
  ['port', '这个网站的 HTTPS 端口是 8443，SSH 端口是 2222。'],
  ['schedule', '机器人日记每天北京时间清晨五点自动生成。'],
  ['city', '阿杰刚从广州搬到成都，现在在成都远程工作。'],
  ['job', '小美上个月换了工作，从设计师转成了产品经理。'],
];
const queries = [
  ['coffee', '谁因为会失眠所以不喝咖啡？'],
  ['tea', '小林平时爱喝哪种茶？'],
  ['flight', '小周的杭州商务行程是什么时候出发？'],
  ['database', '昨天服务故障是怎么解决的？'],
  ['disk', '备份为什么没成功？'],
  ['cat', '那只叫团子的猫喜欢吃什么？'],
  ['meeting', '例会改成星期几几点了？'],
  ['allergy', '给小陈点餐要避开什么食材？'],
  ['game', '阿明最近在玩的农场游戏是什么？'],
  ['port', '服务器远程登录使用哪个端口？'],
  ['schedule', '日记按中国时区每天几点生成？'],
  ['city', '阿杰现在住在哪座城市？'],
  ['job', '小美转行以后做什么岗位？'],
  ['train', '去南京探望朋友的人什么时候坐高铁？'],
];
// Positive pairs preserve the fact; hard negatives change a person, number, date or negation.
const pairs = [
  [true, '会议改到明天下午三点。', '明天下午三点开会。'],
  [true, '我对花生过敏。', '花生会让我过敏。'],
  [true, '小林喜欢喝不加糖的茉莉花茶。', '小林爱喝茉莉花茶，不放糖。'],
  [true, '服务器磁盘空间满了。', '服务器的磁盘没有剩余空间了。'],
  [true, '小美现在做产品经理。', '小美目前的工作是产品经理。'],
  [true, '橘猫团子爱吃鸡肉罐头。', '团子这只橘猫喜欢鸡肉罐头。'],
  [true, 'SSH 端口是 2222。', 'SSH 端口是 2222。'],
  [true, '北京时间每天早上五点写日记。', '每天北京时间清晨五点生成日记。'],
  [false, '我对花生过敏。', '我对花生不过敏。'],
  [false, '会议是周三下午三点。', '会议是周四下午三点。'],
  [false, 'SSH 端口是 2222。', 'SSH 端口是 2223。'],
  [false, '小林住在杭州。', '小王住在杭州。'],
  [false, '小美以前是设计师。', '小美现在是设计师。'],
  [false, '已经取消明天的聚餐。', '已经确认明天的聚餐。'],
  [false, '猫不能吃巧克力。', '猫可以吃巧克力。'],
  [false, '我喜欢猫。', '服务器磁盘满了。'],
];

const report = {
  fixture: 'synthetic-chinese-memory-v1',
  limitations: 'Small synthetic fixture; reports retrieval and duplicate tradeoffs, not production quality. No threshold is approved automatically. A model change requires full reembedding into a new collection before switching.',
  inputMode,
  productionInputNote: 'Current chroma.getEmbedder embeds the cache key: text.length + colon + first 512 characters. Production mode reproduces that behavior; raw mode is a separate experiment.',
  counts: { documents: documents.length, queries: queries.length, pairs: pairs.length },
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version },
  allowDownload: args.includes('--allow-download'),
  models: [],
};

if (args.includes('--describe-only')) {
  console.log(JSON.stringify({ ...report, plannedModels: models }, null, 2));
  process.exit(0);
}

const cosine = (a, b) => {
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return dot / Math.sqrt(an * bn);
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const transform = (text) => inputMode === 'production' ? `${text.length}:${text.slice(0, 512)}` : text;

const { pipeline, env } = await import('@xenova/transformers');
if (option('cache-dir')) env.cacheDir = option('cache-dir');
env.allowRemoteModels = report.allowDownload;

for (const model of models) {
  let extractor;
  const result = { model, dimensions: null, inputMode };
  try {
    const loadStart = performance.now();
    extractor = await pipeline('feature-extraction', model, {
      quantized: true,
      local_files_only: !report.allowDownload,
    });
    result.loadMs = performance.now() - loadStart;
    // Warm-up is excluded from per-text latency, but reported separately.
    const warmStart = performance.now();
    await extractor(transform('这是一条中文预热消息。'), { pooling: 'mean', normalize: true });
    result.warmupMs = performance.now() - warmStart;
    const texts = [...new Set([...documents.map((d) => d[1]), ...queries.map((q) => q[1]), ...pairs.flatMap((p) => [p[1], p[2]])])];
    const vectors = new Map();
    const elapsed = [];
    const cpuStart = process.cpuUsage();
    for (const text of texts) {
      const started = performance.now();
      const output = await extractor(transform(text), { pooling: 'mean', normalize: true });
      elapsed.push(performance.now() - started);
      const vector = Array.from(output.data);
      result.dimensions ??= vector.length;
      if (vector.length !== 384) throw new Error(`Expected 384 dimensions, got ${vector.length}`);
      vectors.set(text, vector);
    }
    result.cpuMicroseconds = process.cpuUsage(cpuStart);
    result.latency = {
      uniqueTexts: texts.length, totalMs: elapsed.reduce((sum, value) => sum + value, 0),
      meanMs: mean(elapsed), p50Ms: percentile(elapsed, 0.5), p95Ms: percentile(elapsed, 0.95),
    };
    const retrieval = queries.map(([expected, query]) => {
      const ranked = documents.map(([id, text]) => ({ id, score: cosine(vectors.get(query), vectors.get(text)) })).sort((a, b) => b.score - a.score);
      return { query, expected, rank: ranked.findIndex((hit) => hit.id === expected) + 1, top3: ranked.slice(0, 3) };
    });
    result.retrieval = {
      top1: retrieval.filter((r) => r.rank === 1).length / retrieval.length,
      top3: retrieval.filter((r) => r.rank <= 3).length / retrieval.length,
      mrr: mean(retrieval.map((r) => 1 / r.rank)), details: retrieval,
    };
    const scored = pairs.map(([duplicate, a, b]) => ({ duplicate, a, b, score: cosine(vectors.get(a), vectors.get(b)) }));
    const positive = scored.filter((p) => p.duplicate);
    const negative = scored.filter((p) => !p.duplicate);
    result.duplicates = {
      positiveMean: mean(positive.map((p) => p.score)), negativeMean: mean(negative.map((p) => p.score)),
      thresholds: [0.85, 0.9, 0.93, 0.95, 0.97, 0.99].map((threshold) => ({
        threshold,
        trueDuplicatesCaught: positive.filter((p) => p.score >= threshold).length,
        trueDuplicatesTotal: positive.length,
        distinctFactsIncorrectlyDropped: negative.filter((p) => p.score >= threshold).length,
        distinctFactsTotal: negative.length,
      })),
      details: scored,
    };
    result.memoryAfterBytes = process.memoryUsage();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (extractor) await extractor.dispose();
  }
  report.models.push(result);
}
console.log(JSON.stringify(report, null, 2));
if (report.models.some((model) => model.error)) process.exitCode = 1;
