import { randomUUID } from "crypto";
import redis from "../redis.js";

const luaScript = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]

  -- 1. Throw away entries older than the window
  redis.call("ZREMRANGEBYSCORE", key, 0, now - windowMs)

  -- 2. Count what is left
  local count = redis.call("ZCARD", key)

  -- 3. Room available? Write down this request
  if count < limit then
    redis.call("ZADD", key, now, member)
    redis.call("PEXPIRE", key, windowMs)
    return { 1, limit - count - 1, 0 }
  end

  -- 4. No room: find when the oldest entry will expire
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryMs = tonumber(oldest[2]) + windowMs - now
  return { 0, 0, retryMs }
`;

redis.defineCommand("slidingWindow", {
  numberOfKeys: 1,
  lua: luaScript,
});

export function slidingWindowLimiter({ name = "default", limit, windowSeconds }) {
  return async (req, res, next) => {
    try {
      const key = `sliding:${name}:${req.ip}`;

      const [allowed, remaining, retryMs] = await redis.slidingWindow(
        key,
        Date.now(),
        windowSeconds * 1000,
        limit,
        randomUUID()
      );

      res.set("X-RateLimit-Remaining", String(remaining));

      if (!allowed) {
        res.set("Retry-After", String(Math.ceil(retryMs / 1000)));
        return res.status(429).json({
          message: "Too many requests. Please try again later.",
        });
      }

      next();
    } catch (err) {
      console.log("Limiter error:", err.message);
      next(); // fail open
    }
  };
}