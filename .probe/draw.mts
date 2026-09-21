process.env.ARTIST_USAGE = 'artist';
process.env.AI_USAGE_ARTIST_LABEL = process.argv[2] ?? 'dshkimi';
process.env.AI_USAGE_ARTIST_BACKUPS = process.argv[3] ?? '';
const { drawArtwork } = await import('../src/agent/artist.js');
const t0 = Date.now();
const r = await drawArtwork('一只戴着樱桃发夹的橘猫，奶油色背景，图里写「喵」');
console.log(`[${process.argv[2]}] ${Date.now()-t0}ms`, JSON.stringify(r).slice(0, 400));
