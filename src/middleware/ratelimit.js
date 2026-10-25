import redis from "../redis.js";
import { limits } from "../config/limits.js";
import { fixedWindowLimiter } from "./fixedWindow.js";
import { tokenBucketLimiter } from "./tokenBucket.js";
import { slidingWindowLimiter } from "./slidingWindow.js";

// Wraps a limiter so it also counts allowed / blocked
function addStats(ruleName, limiter) {
  const statsKey = "stats:" + ruleName;

  async function checkAndCount(req, res, next) {
    let wasAllowed = false;

    // The limiter calls this when the user is allowed in
    function markAllowed() {
      wasAllowed = true;
      next();
    }

    // Run the real limiter and wait for it to finish
    await limiter(req, res, markAllowed);

    // Now count
    try {
      if (wasAllowed === true) {
        await redis.hincrby(statsKey, "allowed", 1);
      } else {
        await redis.hincrby(statsKey, "blocked", 1);
      }
    } catch (err) {
      console.log("Stats error:", err.message);
    }
  }

  return checkAndCount;
}


export function rateLimit(ruleName) {
  const rule = limits[ruleName];

  if (!rule) {
    throw new Error(`No rate limit rule named "${ruleName}"`);
  }

  let limiter;
  switch (rule.algorithm) {
    case "fixedWindow":
      limiter = fixedWindowLimiter({ name: ruleName, ...rule });
      break;
    case "tokenBucket":
      limiter = tokenBucketLimiter({ name: ruleName, ...rule });
      break;
    case "slidingWindow":
      limiter = slidingWindowLimiter({ name: ruleName, ...rule });
      break;
    default:
      throw new Error(`Unknown algorithm "${rule.algorithm}"`);
  }

  return addStats(ruleName, limiter);
}