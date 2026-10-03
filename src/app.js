import express from "express";
import redis from "./redis.js";
import { limits } from "./config/limits.js";
import { rateLimit } from "./middleware/ratelimit.js";

export const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/stats", async (req, res) => {
  const rules = {};
  let totalAllowed = 0;
  let totalBlocked = 0;

  const ruleNames = Object.keys(limits);

  for (const name of ruleNames) {
    const data = await redis.hgetall("stats:" + name);
    const allowed = Number(data.allowed || 0);
    const blocked = Number(data.blocked || 0);
    const total = allowed + blocked;

    let blockedPercent = 0;
    if (total > 0) {
      blockedPercent = Math.round((blocked / total) * 100);
    }

    rules[name] = {
      algorithm: limits[name].algorithm,
      allowed: allowed,
      blocked: blocked,
      blockedPercent: blockedPercent,
    };

    totalAllowed = totalAllowed + allowed;
    totalBlocked = totalBlocked + blocked;
  }

  res.json({
    totalAllowed: totalAllowed,
    totalBlocked: totalBlocked,
    rules: rules,
  });
});

app.delete("/stats", async (req, res) => {
  const ruleNames = Object.keys(limits);
  for (const name of ruleNames) {
    await redis.del("stats:" + name);
  }
  res.json({ message: "Stats reset" });
});



app.use(rateLimit("global"));

app.post("/login", rateLimit("login"), (req, res) => {
  res.json({ message: "Login attempt allowed" });
});

app.get("/search", rateLimit("search"), (req, res) => {
  res.json({ message: "Search allowed" });
});

app.post("/upload", rateLimit("upload"), (req, res) => {
  res.json({ message: "Upload allowed" });
});

app.get("/", (req, res) => {
  res.json({ message: "Home" });
});