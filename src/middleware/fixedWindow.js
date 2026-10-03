import redis from "../redis.js";

export function fixedWindowLimiter({ name = "default", limit, windowSeconds }) {
  return async (req, res, next) => {
    try {
      const key = `rate:${name}:${req.ip}`;

      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (count > limit) {
        return res.status(429).json({
          message: "Too many requests. Please try again later.",
        });
      }

      next();
    } catch (err) {
      console.log("Limiter error:", err.message);
      next();
    }
  };
}