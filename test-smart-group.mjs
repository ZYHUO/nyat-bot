// Direct test of Smart Group module - imports from compiled dist
import { getConfig, smartGroupReorder, recordSmartGroupResult, initSmartGroup } from "./dist/index.js";

// Monkey-patch getRedis to use our test
console.log("=== Test 1: getConfig ===");
const cfg = getConfig();
console.log("Config:", JSON.stringify(cfg));

console.log("\n=== Test 2: smartGroupReorder (no data yet) ===");
const labels = new Map([
  ["stepexplore", { endpoint: "https://newapi.gomami.wiki/v1", model: "deepseek-v4-flash" }],
  ["stepfun", { endpoint: "https://api.stepfun.com/v1", model: "step-3.7-flash" }],
  ["dsv4flash", { endpoint: "https://newapi.gomami.wiki/v1", model: "deepseek-v4-flash" }],
]);
const result = smartGroupReorder(["stepexplore", "stepfun", "dsv4flash"], labels);
console.log("Reordered:", result);

console.log("\n=== Test 3: recordSmartGroupResult ===");
await recordSmartGroupResult("stepexplore", 1234, true);
await recordSmartGroupResult("stepfun", 567, true);
await recordSmartGroupResult("dsv4flash", 3000, true);
console.log("Recorded 3 results");

console.log("\n=== Test 4: Reorder should now differ ===");
const result2 = smartGroupReorder(["stepexplore", "stepfun", "dsv4flash"], labels);
console.log("Reordered:", result2);
console.log("Changed?", JSON.stringify(result) !== JSON.stringify(result2));

// Check Redis
console.log("\n=== Test 5: Redis check ===");
import { getRedis } from "./src/db/redis.js";
const redis = getRedis();
const keys = await redis.keys("xxb:sg:health:*");
console.log("Redis keys found:", keys.length);
for (const k of keys.slice(0, 5)) {
  const data = await redis.hgetall(k);
  console.log(`  ${k}:`, data);
}
