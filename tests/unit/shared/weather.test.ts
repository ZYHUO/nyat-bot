import { beforeEach, describe, expect, it, vi } from 'vitest';

const envBase: Record<string, unknown> = {
  WEATHER_ENABLED: true,
  WEATHER_CITY: 'Beijing',
};
vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const redisGet = vi.fn(async () => null);
const redisSet = vi.fn(async () => 'OK');
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
  }),
}));

function wttrResponse(desc = '晴', temp = '27', feels = '29') {
  return {
    ok: true,
    json: async () => ({
      current_condition: [{
        temp_C: temp,
        FeelsLikeC: feels,
        lang_zh: [{ value: desc }],
        weatherDesc: [{ value: 'Sunny' }],
      }],
    }),
  };
}

describe('weather（天气环境感知）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    envBase.WEATHER_ENABLED = true;
    const { _resetWeatherCacheForTest } = await import('../../../src/shared/weather.js');
    _resetWeatherCacheForTest();
  });

  it('未启用 → null，不发请求', async () => {
    envBase.WEATHER_ENABLED = false;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getWeatherHint } = await import('../../../src/shared/weather.js');
    expect(await getWeatherHint()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('成功 → 组装中文环境句（体感不同才带）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => wttrResponse('晴', '27', '29')));
    const { getWeatherHint } = await import('../../../src/shared/weather.js');
    const text = await getWeatherHint();
    expect(text).toBe('你那边现在 27°C，晴，体感 29°C');
    expect(redisSet).toHaveBeenCalled(); // 写缓存
    vi.unstubAllGlobals();
  });

  it('体感=实际时不带体感尾巴', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => wttrResponse('多云', '20', '20')));
    const { getWeatherHint } = await import('../../../src/shared/weather.js');
    expect(await getWeatherHint()).toBe('你那边现在 20°C，多云');
    vi.unstubAllGlobals();
  });

  it('fetch 失败 → null（fail-soft 不炸 prompt 组装）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { getWeatherHint } = await import('../../../src/shared/weather.js');
    expect(await getWeatherHint()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('Redis 有缓存时直接用，不发请求', async () => {
    redisGet.mockResolvedValueOnce('你那边现在 26°C，阴');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getWeatherHint } = await import('../../../src/shared/weather.js');
    expect(await getWeatherHint()).toBe('你那边现在 26°C，阴');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
