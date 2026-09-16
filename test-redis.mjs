import "dotenv/config";
import { getRedis } from "./src/db/redis.js";
const redis = getRedis();
redis.set("xxb:test:123", "hello", "EX", 60)
  .then(() => console.log("WRITE OK"))
  .catch(e => console.log("WRITE ERR:", e.message));
redis.get("xxb:test:123")
  .then(v => console.log("READ:", v))
  .catch(e => console.log("READ ERR:", e.message));
redis.hmset("xxb:test:hash", "a", "1", "b", "2")
  .then(v => console.log("HMSET OK:", v))
  .catch(e => console.log("HMSET ERR:", e.message));
