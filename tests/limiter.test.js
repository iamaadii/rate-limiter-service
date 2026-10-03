import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert";

process.env.REDIS_URL = "redis://localhost:6379/1";

const redisModule = await import("../src/redis.js");
const appModule = await import("../src/app.js");
const redis = redisModule.default;
const app = appModule.app;

let server;
let baseUrl;

before(() => {
  server = app.listen(0);
  baseUrl = "http://localhost:" + server.address().port;
});

after(async () => {
  server.close();
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
});

async function callRoute(method, path) {
  const response = await fetch(baseUrl + path, { method: method });
  return response.status;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("login: 5 pass, 6th is blocked (sliding window)", async () => {
  for (let i = 1; i <= 5; i++) {
    const status = await callRoute("POST", "/login");
    assert.strictEqual(status, 200);
  }
  const sixth = await callRoute("POST", "/login");
  assert.strictEqual(sixth, 429);
});

test("search: bucket of 20 runs out (token bucket)", async () => {
  for (let i = 1; i <= 20; i++) {
    const status = await callRoute("GET", "/search");
    assert.strictEqual(status, 200);
  }

  let blockedCount = 0;
  for (let i = 1; i <= 5; i++) {
    const status = await callRoute("GET", "/search");
    if (status === 429) {
      blockedCount = blockedCount + 1;
    }
  }
  assert.ok(blockedCount >= 1);
});

test("upload: 10 pass, 11th is blocked (fixed window)", async () => {
  for (let i = 1; i <= 10; i++) {
    const status = await callRoute("POST", "/upload");
    assert.strictEqual(status, 200);
  }
  const eleventh = await callRoute("POST", "/upload");
  assert.strictEqual(eleventh, 429);
});

test("health is never blocked", async () => {
  for (let i = 1; i <= 110; i++) {
    const status = await callRoute("GET", "/health");
    assert.strictEqual(status, 200);
  }
});

test("stats count allowed and blocked", async () => {
  for (let i = 1; i <= 6; i++) {
    await callRoute("POST", "/login");
  }

  await wait(200);

  const response = await fetch(baseUrl + "/stats");
  const data = await response.json();

  assert.strictEqual(data.rules.login.allowed, 5);
  assert.strictEqual(data.rules.login.blocked, 1);
});