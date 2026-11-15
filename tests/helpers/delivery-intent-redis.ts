/** Small stateful Redis hash fixture for the real durable-send fence.
 * Unlike always-return-1 mocks it rejects a duplicate claim and only removes the
 * exact nonce. It deliberately implements only the compare-delete Lua contract. */
export function createDeliveryIntentRedis() {
  const fields = new Map<string, string>();
  const fieldKey = (key: string, field: string) => `${key}\0${field}`;
  return {
    reset() { fields.clear(); },
    async hsetnx(key: string, field: string, value: string) {
      const id = fieldKey(key, field);
      if (fields.has(id)) return 0;
      fields.set(id, value); return 1;
    },
    async hget(key: string, field: string) { return fields.get(fieldKey(key, field)) ?? null; },
    async eval(script: string, count: number, key: string, field: string, expected: string) {
      if (count !== 1 || !script.includes("redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2]")
        || !script.includes("redis.call('HDEL', KEYS[1], ARGV[1])")) throw new Error('unexpected_test_lua');
      const id = fieldKey(key, field);
      if (fields.get(id) !== expected) return 0;
      fields.delete(id); return 1;
    },
  };
}
