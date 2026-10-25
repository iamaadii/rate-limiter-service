import "dotenv/config";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

redis.on("connect", () => console.log("Connected to Redis"));
redis.on("error", (err) => console.log("Redis error:", err.message));

export default redis;