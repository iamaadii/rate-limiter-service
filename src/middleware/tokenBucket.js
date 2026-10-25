import redis from "../redis.js";

// A small script that runs INSIDE Redis, in one step
const luaScript = `
  local tokens = tonumber(redis.call("HGET", KEYS[1], "tokens"))
  local last = tonumber(redis.call("HGET", KEYS[1], "last"))

  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])

  -- First visit: start with a full bucket
  if tokens == nil then
    tokens = capacity
    last = now
  end

  -- Add tokens for the time that has passed
  local secondsPassed = math.max(0, now - last) / 1000
  tokens = math.min(capacity, tokens + secondsPassed * refillRate)

  -- Try to take 1 token
  local allowed = 0
  if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
  end

  redis.call("HSET", KEYS[1], "tokens", tokens, "last", now)
  redis.call("EXPIRE", KEYS[1], math.ceil(capacity / refillRate) * 2)

  return { allowed, math.floor(tokens) }
`;

redis.defineCommand("tokenBucket", {
  numberOfKeys: 1,
  lua: luaScript,
});

export function tokenBucketLimiter({ name = "default", capacity, refillPerSecond }) {
  return async (req, res, next) => {
    try {
      const key = `bucket:${name}:${req.ip}`;

      const [allowed, remaining] = await redis.tokenBucket(
        key,
        capacity,
        refillPerSecond,
        Date.now()
      );

      res.set("X-RateLimit-Remaining", String(remaining));

      if (!allowed) {
        res.set("Retry-After", String(Math.ceil(1 / refillPerSecond)));
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