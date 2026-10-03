# Rate Limiter Service: Interview Notes


## 30 second answer

> "I built a rate limiter service using Node.js, Express and Redis. It stops one user from sending too many requests to an API. It has three algorithms: fixed window, token bucket and sliding window. Each route picks the one that suits it. For example, login uses sliding window because accuracy matters, and search uses token bucket because bursts are normal."

<br>

## 1 minute answer

> "A rate limiter works like a bouncer at a club door. It counts how many requests each user made recently, and if they cross the limit, it replies with 429 Too Many Requests.
>
> I kept the counters in Redis, because Redis is fast, shared between many server copies, and deletes old keys by itself. I built three algorithms and put all the rules in one config file, so changing a limit is a one word edit.
>
> Token bucket and sliding window run as Lua scripts inside Redis, so the check is atomic and two requests at the same moment can't cheat the limit. I also added a stats endpoint that counts allowed and blocked requests for each rule, wrote automated tests for all three algorithms, and ran everything with Docker Compose. My tests also caught an off-by-one bug in the fixed window limiter."

<br>

## The problem it solves

- One user or a bot can send thousands of requests and slow down the API for everyone.
- Attackers can try thousands of passwords on the login route.
- Costly actions (uploads, emails, SMS) need a cap.
- Real examples: login and OTP, public APIs (GitHub, Stripe), search, uploads, scraping protection.


<br>

## Key words to know

- **Rate limiting:** allow only N requests in a fixed time.
- **429:** the status code for "Too Many Requests". Blocked users get this.
- **Middleware:** a function that runs between the request and the route. It either replies (blocks) or calls `next()` (allows).
- **Window:** the time period we count in, like 60 seconds.
- **TTL:** a timer on a Redis key. When it ends, Redis deletes the key.
- **Race condition:** a bug that happens when two things run at the same moment.
- **Atomic:** happens in one unbreakable step. Nothing can sneak in the middle.
- **Burst:** many requests in a very short time.
- **Fail open:** if the limiter breaks, allow requests.
- **Fail closed:** if the limiter breaks, block requests.

<br>

> ## Fixed Window
> - **How it counts:** count requests in each time block. At the end of the block, the count goes back to 0.
> - **Analogy:** a bus ticket counter that gives 5 tickets per minute and resets every minute.
> - **Stored in Redis:** one number per user, with a timer.
> - **Strength:** simplest, least memory.
> - **Weakness:** the **boundary loophole**.

### Steps
- Add 1 to the user's counter (`INCR`) and get the new number.
- If the number is 1, start the timer (`EXPIRE`).
- If the number is above the limit, send 429.
- Otherwise call `next()`.

### Code (be able to write this)
```js
export function fixedWindowLimiter({ name = "default", limit, windowSeconds }) {
  return async (req, res, next) => {
    try {
      const key = `rate:${name}:${req.ip}`;
      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (count > limit) {
        return res.status(429).json({ message: "Too many requests." });
      }

      next();
    } catch (err) {
      next();
    }
  };
}
```

### Dry run (limit 3)
- Request 1: count 1, timer starts, allowed.
- Request 2: count 2, allowed.
- Request 3: count 3, allowed.
- Request 4: count 4, which is more than 3, so blocked.
- After the timer ends, the key is deleted and the count starts again from 1.

### The boundary loophole (they love this question)
- A user sends 5 requests at 0:59 and 5 more at 1:01.
- That is 10 requests in 2 seconds, but the limit says 5 per minute.
- It happens because the counter resets all at once at the boundary.
- The other two algorithms fix this.

<br>

> ## Token Bucket
> - **How it counts:** each user has a bucket that holds N tokens. Each request costs 1 token. The bucket refills slowly over time.
> - **Analogy:** a bucket with a slow tap. Each request scoops out one cup. If the bucket is empty, you wait for the tap.
> - **Stored in Redis:** a hash with two values: tokens left, and time of the last request.
> - **Strength:** allows short bursts on purpose, and traffic stays smooth overall. Uses little memory.
> - **Weakness:** a bit harder to understand. Not as exact as sliding window.

### Steps
- Read the tokens and the last time. A new user starts with a full bucket.
- Work out the time passed since the last request.
- Add `time passed × refill rate` tokens, but never above the bucket size.
- If there is at least 1 token, take it and allow. Otherwise block.
- Save the new tokens and the current time.

### Dry run (bucket 5, refill 1 per second)
- Start: 5 tokens.
- 5 quick requests: tokens go 4, 3, 2, 1, 0. All allowed.
- 6th request right away: about 0 tokens, so blocked.
- Wait 2 seconds: 2 tokens come back, so 2 more requests are allowed.
- Wait 5 seconds or more: the bucket is full again.

<br>

> ## Sliding Window
> - **How it counts:** for every request, look back exactly 60 seconds from right now and count the requests in that period.
> - **Analogy:** a security guard with a notebook. He writes your time on every entry, and counts only the last 60 seconds.
> - **Stored in Redis:** a sorted set. Each request is an item, and its score is the time.
> - **Strength:** most accurate, no boundary loophole.
> - **Weakness:** most memory, because it stores every request.

### Steps
- Remove entries older than the window.
- Count the entries left.
- If the count is below the limit, add this request and allow.
- Otherwise block, and work out how long until the oldest entry leaves the window.

### Dry run (limit 3, window 60 seconds)
- t = 0s: allowed. t = 10s: allowed. t = 20s: allowed.
- t = 30s: 3 entries in the last 60 seconds, so blocked. Retry in about 30 seconds.
- t = 61s: the entry from 0s is now too old, so it is removed. Allowed again.

### Why each request needs a unique ID
- A sorted set cannot hold two identical items.
- Two requests in the same millisecond would overwrite each other.
- So each request gets a random ID (`randomUUID`).

<br>

## The 3 algorithms side by side

- **Fixed Window**
  - Memory: 1 number per user.
  - Loophole: yes.
  - Best for: rough limits (uploads).
- **Token Bucket**
  - Memory: 2 values per user.
  - Loophole: no.
  - Best for: APIs where bursts are fine (search).
- **Sliding Window**
  - Memory: 1 entry per request.
  - Loophole: no.
  - Best for: strict limits (login, OTP).

**One line to remember:** "Sliding window is the most accurate but uses the most memory. For very high traffic I would choose token bucket."

<br>

## Why each route uses its algorithm

- **login: Sliding Window.** Needs the strictest and most accurate limit. With fixed window, someone could try 5 passwords just before the reset and 5 just after.
- **search: Token Bucket.** Real users type in bursts, then pause. Token bucket allows that and refills smoothly. A strict limit would annoy normal users.
- **upload: Fixed Window.** A rough hourly cap is enough. It is the simplest and uses the least memory. The loophole barely matters here.
- **global: Sliding Window.** A broad safety net for the whole API. The limit is small (100), so the memory is fine.

**Safe answer if they challenge a choice:**
> "There is no single right answer. I picked by what each route needs. If memory became a problem at large scale, I would switch the global rule to token bucket, and in my project that is a one word change in the config file."

<br>

## Why Redis

- **Shared:** if 3 copies of the server run, they all use the same counters. A normal variable would be separate in each copy, so a user could get 3 times the limit.
- **Fast:** it keeps data in memory, and the limiter runs on every request.
- **Survives restarts:** counters are not lost when Node restarts.
- **Expiry built in:** old counters delete themselves with TTL.
- **Atomic commands:** `INCR` is safe even if two requests arrive together.

**Redis commands I used:** `INCR`, `EXPIRE`, `HINCRBY`, `HGETALL`, `ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`, `DEL`.

<br>

## Why Lua scripts (very common question)

- **The problem:** a check like "read tokens, calculate, write tokens" has 3 steps. Two requests at the same millisecond can both read "1 token left" and both spend it. That is a **race condition**, and the user gets a free request.
- **The fix:** a Lua script runs inside Redis as **one unbreakable step**. The second request always sees the updated value.
- **In my project:** Token Bucket and Sliding Window use Lua scripts. Fixed Window doesn't need one, because `INCR` is already atomic.

<br>

## How a request flows

- Take `POST /login`.
- **Global limiter** checks first (100 per minute). Blocked means 429 and it stops.
- **Login limiter** checks next (5 per minute). Blocked means 429 and it stops.
- If both allow, the **route handler** runs and replies 200.

**At server start (runs once):** each `rateLimit("name")` looks up its rule in the config, builds the right limiter, and wraps it with stats.

**On every request:** Express runs the list of functions for that route in order.

**Route order matters:** `/health` and `/stats` are written above the global limiter, so they are never limited.

<br>

## How the stats work (explain this simply)

- One wrapper function runs the limiter, but gives it **my own `next`** (called `markAllowed`) instead of the real one.
- `markAllowed` sets `wasAllowed = true`, then calls the real `next()`.
- If the limiter allows the request, it calls `next()`, so `wasAllowed` becomes true. If it blocks, it sends 429 and never calls `next()`, so `wasAllowed` stays false.
- After the limiter finishes, one line adds 1 to the `allowed` or `blocked` counter in Redis.
- Stats are per **rule**, not per route. One request to `/login` is counted in two rules (global and login).
- The wrapper is the **decorator pattern**: I added metrics to all algorithms without changing their code.

---

## Fail open and fail closed

- **What my code does:** if Redis is down, the `catch` block logs the error and calls `next()`. The request is **allowed**. This is **fail open**.
- **Why:** a rate limiter problem should not take the whole API down.
- **When I would choose the opposite:** for very sensitive routes like login, I might fail closed, because letting everyone through during an outage helps attackers.

---

## Testing

- Tests use Node's built-in test runner (`node --test`), so no extra libraries.
- They use Redis **database 1**, so real data in database 0 is safe.
- `flushdb` runs before every test, so each test starts from zero.
- One test per algorithm: login (sliding), search (token bucket), upload (fixed), plus `/health` never blocked, plus stats counts.
- The search test says "at least one blocked" instead of "exactly 5", because the bucket refills while the loop runs.
- The stats test waits 200 ms, because counting happens after the response is sent.

---

## Docker

- `Dockerfile` packs the Node app. `docker-compose.yml` starts the app and Redis together with one command.
- Inside Docker, the app connects to `redis://redis:6379`. The host is the **service name**.
- **Why not `localhost`:** inside a container, `localhost` means the container itself, so the app would look for Redis inside itself and fail.
- **Why copy `package.json` first in the Dockerfile:** Docker reuses saved steps. Libraries rarely change, so `npm install` is skipped on most rebuilds and builds are fast.

---

## Real bugs I hit (best stories)

- **Off-by-one in fixed window.**
  - I checked the count first and only then added 1.
  - With limit 3, request 4 saw a stored count of 3. `3 > 3` is false, so it passed. One extra request got through.
  - It also had a race, because two requests could read the same number.
  - My test (`upload: 11th should be blocked`) caught it.
  - **Fix:** `INCR` first, then compare the number it **returned**. Each request gets its own number.
- **Docker networking.** `localhost` inside a container is the container itself. Use the service name.
- **Test environment order.** `import` runs before other code, so setting `REDIS_URL` after it was too late. I used `await import()` so the test database is set first.

**How to tell a bug story:** what happened, how you found it, what the cause was, how you fixed it, and what you learned.

---

## Honest limits (say these yourself)

- It identifies users by **IP** (`req.ip`). Many people can share one IP (college, office), and behind a proxy everyone can look like one IP unless `trust proxy` is on.
- It is a **demo service**, not a full production gateway.
- I have **not load tested** it, so I don't claim a requests per second number.
- Only Token Bucket and Sliding Window send `X-RateLimit-Remaining` and `Retry-After` headers. Fixed Window doesn't yet.

---

## What I would improve next

- Limit by **user ID or API key** instead of IP.
- Turn on `trust proxy` behind a load balancer.
- Send the same headers from all three algorithms.
- Add a **load test** (for example with `autocannon`) to get real numbers.
- Package it as an **npm module**.
- Add a small dashboard for `/stats`.
- Add a Redis health check in Docker Compose.
- Fail closed for the login route.

---

## Interview questions and short answers

- **What is rate limiting?**
  - Allowing only N requests per user in a time period, to protect the API from abuse and keep it fair.
- **Why Redis and not a variable?**
  - Redis is shared by all server copies, fast, survives restarts, and has built-in expiry.
- **Explain the three algorithms.**
  - Fixed window counts per time block. Token bucket refills tokens at a steady rate and allows bursts. Sliding window counts requests in the last N seconds from now.
- **Weakness of fixed window?**
  - The boundary loophole: double the limit around the reset.
- **Token bucket vs sliding window?**
  - Token bucket uses less memory and allows bursts. Sliding window is stricter and more accurate but stores every request.
- **Why Lua?**
  - To make read, calculate and write one atomic step, so two requests at the same moment can't both pass.
- **What does atomic mean?**
  - One unbreakable step. Nothing can run in the middle.
- **What if Redis goes down?**
  - My limiter fails open and allows requests. For sensitive routes I would fail closed.
- **How do you identify users?**
  - By IP. Better options are user ID or API key, and `trust proxy` must be on behind a proxy.
- **How does it work with many servers?**
  - All servers share one Redis, so the counters are shared.
- **Why two limiters on one route?**
  - A loose global one protects the whole API, and a strict one protects sensitive routes. A request must pass both.
- **How do stats work?**
  - A wrapper gives the limiter a custom `next`. If it gets called, the request was allowed, otherwise blocked. Then it adds 1 to the right Redis counter.
- **Why is the config in one file?**
  - To change a rule without touching logic. A wrong rule name makes the server fail at startup, so mistakes show up early.
- **Why are `/health` and `/stats` not limited?**
  - They are written above the global limiter, and Express runs routes in order. Monitoring should never be blocked.
- **How did you test it?**
  - One test per algorithm using a separate Redis database, with the database emptied before each test.
- **What was the hardest bug?**
  - The off-by-one in fixed window. My test caught it, and the fix was to increment first and compare the returned number.
- **What would you change at very large scale?**
  - Use token bucket to save memory, limit by user ID, and load test to find the real limits.

---

## What you should be able to do live

- **Write fixed window from memory** (about 10 lines). It is the one interviewers most often ask for.
- **Draw the request flow** on paper: request, global limiter, route limiter, handler, with Redis next to both limiters.
- **Dry run any algorithm** with small numbers (limit 3).
- **Explain a bug** you hit from start to finish.

For token bucket and sliding window, explain the steps in plain words instead of writing the Lua script.

---

## Things to avoid saying

- Do not say "it handles 1000 requests per second" unless you measured it.
- Do not claim something you can't explain. If your resume says "atomic Lua scripts", be ready to explain what atomic means and why it's needed.
- Do not say one algorithm is "the best". Say which is best for which job.
- Do not hide the limits. Say them first, and it looks mature.
- If you don't know something, say: "I'm not sure, but here is how I would find out."

---

## Resume bullets

- Built a Redis-backed rate limiting service for Express APIs with 3 algorithms (fixed window, token bucket, sliding window), selected per route through a single config file.
- Prevented race conditions by running token bucket and sliding window checks as atomic Redis Lua scripts, so simultaneous requests cannot exceed the limit.
- Added a stats endpoint tracking allowed vs blocked requests per rule, using one wrapper so every algorithm gets metrics without code changes.
- Wrote automated tests for all 3 algorithms (caught an off-by-one bug in the fixed window limiter) and containerized the app and Redis with Docker Compose.

---
