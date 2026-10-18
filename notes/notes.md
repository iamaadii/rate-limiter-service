# Rate Limiter Service

A small service that stops users from sending too many requests to an API. It supports 3 rate limiting algorithms (Fixed Window, Token Bucket, Sliding Window), and each route can pick the one that suits it.



## The problem it solves

If one user (or a bot) sends thousands of requests, the API becomes slow for everyone. It also helps against:

- password guessing on login (brute force)
- scraping and spamming
- one buggy client that loops forever
- unfair use of expensive routes (upload, search)
- cost overruns on paid services

## Real-world use

- Login and OTP routes (strict, few tries)
- Public APIs (free plan: 100 requests per minute)
- Search and autocomplete (bursts are normal, so allow them)
- File uploads and emails (hourly or daily caps)
- API gateways, which almost always include a rate limiter

## Tech stack and why each piece is there

| Tech                      | Why I used it                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node.js and Express       | The API and the middleware                                                                                  |
| Redis                     | Fast shared counters. The numbers stay correct even if the server restarts, and many servers can share them |
| Lua scripts (in Redis)    | Make "read, calculate, write" one unbreakable step                                                          |
| ioredis                   | The Redis client (it can define Lua commands)                                                               |
| Docker and Docker Compose | One command to run the app and Redis                                                                        |
| node:test                 | Tests                                                                                                       |
| Postman                   | Manual testing                                                                                              |

## Big picture flow

1. A request comes in.
2. It passes through the **global limiter** first (a loose limit for everyone).
3. Then it passes through the **route limiter** of its own route (strict for sensitive routes).
4. If both say OK, the route handler runs and replies 200.
5. If either says no, the reply is 429 and the handler never runs.
6. Every decision is counted (allowed or blocked) for the stats endpoint.

Counters live in Redis, so they survive a server restart.

## Folder and file guide

| File                                  | Job                                                             |
| ------------------------------------- | --------------------------------------------------------------- |
| `src/server.js`                       | Starts the server                                               |
| `src/app.js`                          | Builds the Express app, applies limiters to routes              |
| `src/redis.js`                        | Redis connection (also defines the Lua commands)                |
| `src/config/limits.js`                | All rate limit rules in one place                               |
| `src/middleware/fixedWindow.js`       | Fixed Window algorithm                                          |
| `src/middleware/tokenBucket.js`       | Token Bucket algorithm (Lua)                                    |
| `src/middleware/slidingWindow.js`     | Sliding Window algorithm (Lua)                                  |
| `src/middleware/rateLimit.js`         | Picks the algorithm from the config and adds the stats counting |
| `tests/limiter.test.js`               | Tests for all 3 algorithms                                      |
| `Dockerfile` and `docker-compose.yml` | Run app and Redis together                                      |

## The 3 algorithms in simple words

### Fixed Window

Count requests inside each fixed time slot (for example each clock minute). When the slot ends, the count resets.

- Redis steps: `INCR key`. If the result is 1, set `EXPIRE` (the window length). If the result is more than the limit, block.
- Memory: 1 number per user.
- Weakness (the boundary loophole): a user can send 5 requests at 12:00:59 and 5 more at 12:01:00. That is 10 requests in 2 seconds, although the limit is 5 per minute.
- Good for: rough limits where precision isn't important.

### Token Bucket

Imagine a bucket that holds tokens. Each request takes one token. The bucket refills slowly (for example 5 tokens per second) up to its capacity.

- Redis stores 2 numbers per user: how many tokens are left, and the time of the last refill.
- On each request, a Lua script calculates how many tokens were added since the last time, takes one if available, and saves.
- Allows **bursts on purpose**: a full bucket of 20 lets a user send 20 requests at once, but the long-term speed is limited by the refill rate.
- Good for: search, autocomplete, normal API traffic.

### Sliding Window

Look back exactly 60 seconds from **right now** and count the requests in that period.

- Redis keeps a **sorted set** per user. Each request is an entry with its time as the score.
- Lua script steps: 1) remove entries older than the window, 2) count what is left, 3) if below the limit add this request, otherwise block, 4) when blocked, calculate how long until the oldest entry leaves the window (this is the `Retry-After`).
- Each entry gets a unique ID (`randomUUID`) because a sorted set can't hold two identical items. Without it, two requests in the same millisecond would overwrite each other.
- No boundary loophole, because the window moves with every request.
- Memory: 1 entry per request in the window (the most expensive of the three).
- Good for: strict limits such as login.

### Comparison

|                   | Fixed Window                            | Token Bucket                  | Sliding Window                        |
| ----------------- | --------------------------------------- | ----------------------------- | ------------------------------------- |
| Idea              | Count per fixed slot                    | Bucket of tokens that refills | Count in the last 60 seconds from now |
| Boundary loophole | Yes (up to 2x the limit near the reset) | No                            | No                                    |
| Bursts            | Accidentally                            | Yes, on purpose               | Up to the limit                       |
| Memory per user   | 1 number                                | 2 numbers                     | 1 entry per request                   |
| Precision         | Low                                     | Good                          | Highest                               |
| Best for          | Simple rough limits                     | Bursty but smooth APIs        | Strict limits like login              |

## Rules used in this project (`src/config/limits.js`)

| Rule   | Algorithm      | Limit                           |
| ------ | -------------- | ------------------------------- |
| global | Sliding Window | 100 requests per 60 seconds     |
| login  | Sliding Window | 5 requests per 60 seconds       |
| search | Token Bucket   | 20 tokens, refills 5 per second |
| upload | Fixed Window   | 10 requests per hour            |

Why each choice (the decision rules):

- **login = Sliding Window:** strict, no loophole, because attackers will try to exploit the boundary.
- **search = Token Bucket:** real users type fast in bursts, so bursts should be allowed, but the average speed stays limited.
- **upload = Fixed Window:** a simple hourly cap is enough. One hour is long, so the boundary loophole matters little, and it costs only 1 number of memory.
- **global = Sliding Window:** a fair, accurate cap for everything.

## Routes

| Method | Route   | Limited by      | What it does                        |
| ------ | ------- | --------------- | ----------------------------------- |
| GET    | /health | nothing         | Checks the server is running        |
| GET    | /stats  | nothing         | Allowed and blocked counts per rule |
| DELETE | /stats  | nothing         | Resets the counts                   |
| POST   | /login  | global + login  | Demo route with a strict limit      |
| GET    | /search | global + search | Demo route that allows bursts       |
| POST   | /upload | global + upload | Demo route with an hourly cap       |
| GET    | /       | global          | Home route                          |

When blocked: status 429. Token Bucket and Sliding Window also send `X-RateLimit-Remaining` and `Retry-After` headers.

## How `rateLimit.js` and the stats work

- Each limiter is a middleware function: `(req, res, next)`. It either calls `next()` (allowed) or replies 429.
- `rateLimit.js` reads the rule from the config, builds the right limiter, and **wraps** it (the decorator idea).
- The wrapper gives the limiter a **fake `next`** called `markAllowed`. If the limiter calls it, the request was allowed, so the wrapper counts "allowed" and then calls the real `next()`. If the limiter instead sends a 429 reply, `markAllowed` was never called, so the wrapper counts "blocked".
- Result: every algorithm gets stats **without changing its own code**.
- Stats are kept per rule name (global, login, search, upload).

Dry run for `POST /login` the 6th time in a minute:

1. Global limiter (sliding, 100 per minute): the user is under 100, so it allows. Stats: global allowed +1.
2. Login limiter (sliding, 5 per minute): there are already 5 entries in the last 60 seconds, so it blocks and replies 429 with `Retry-After`. Stats: login blocked +1.
3. The route handler never runs.

## Redis keys and ids

- The limiter key is built from the client IP and the rule name (for example `sliding:<ip>`), so a user's login attempts never mix with their search requests.
- Each rule has its own Redis key.
- The tests use **Redis database 1**, so real data in database 0 is never touched.

## Design decisions

- **Atomic Lua scripts:** Token Bucket and Sliding Window read, calculate and write inside Redis in one step. Without that, two requests at the same millisecond could both read the same old count and both slip through (a race condition). Redis runs a Lua script as one unit, and nothing runs in between.
- **Increment first, then compare** (Fixed Window): add 1, then check the number you got back. Checking first and adding later lets one extra request through.
- **Fail open:** if Redis is down, requests are allowed. A Redis problem should not take the whole API down. For very sensitive routes (login) some teams choose fail closed. It's a trade-off between availability and protection.
- **Config-driven rules:** changing the algorithm for a route is a one-word change in the config file.
- **Stats wrapper:** counting is done in one place.
- **Global plus route limiter:** loose limit for everyone, strict for sensitive routes.
- **Separate counters per rule:** no mixing between routes.
- **Unique member IDs** in the sliding window set.
- **Docker Compose:** the same one-command start for anyone.

## Bugs I hit and how I fixed them

| Problem                                                            | Cause                                                                    | Fix                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The 11th upload got 200 instead of 429 (test showed `200 !== 429`) | Off by one: the first version checked the old count and then incremented | Increment first with `INCR`, then compare the returned count with the limit. I made this correction in my own version of `fixedWindow.js` |
| Why that bug is also a race                                        | Two requests could both read the same old count                          | `INCR` is atomic in Redis, so each request gets its own number                                                                            |
| Port 6379 already in use                                           | Another Redis was running                                                | Stop the other Redis, or change the port                                                                                                  |

## Tests

- Run with `npm test`. Redis must be running on port 6379.
- Tests use Redis database 1.
- They cover all 3 algorithms: allowed under the limit, blocked over the limit, the headers, and recovery after the window or refill.

## Run it

- Docker: `docker compose up --build`, then open `http://localhost:3000/stats`.
- Without Docker: start Redis with `docker run -d --name my-redis -p 6379:6379 redis`, then `npm install`, copy `.env.example` to `.env`, and `npm start`.

## Limitations and future work

- Limits by IP only (users behind one network share a limit). Better: limit by user ID or API key when logged in.
- Behind a proxy or load balancer, `req.ip` needs `trust proxy` set, otherwise everyone looks like the same IP.
- Rules are fixed in a file. They could be loaded from a database and changed at runtime.
- Single Redis. For high availability use Redis Sentinel or Cluster.
- No dashboard UI for the stats yet.
- Could be packaged as an npm library or run as a separate service for other apps.

## How others can use it

- As middleware inside their Express app (copy the middleware and config).
- As a separate service in front of other services (an API gateway pattern).
- Changing limits only needs the config file.

## How to scale it

- Run many app servers that share one Redis. Since all counters live in Redis, the limit stays correct across servers.
- Use Redis Cluster and shard by key if one Redis is not enough.
- Local in-memory caches can cut Redis calls for very hot keys, with slightly less accuracy.

## Commands to remember

```
docker compose up --build        run app and Redis
docker run -d --name my-redis -p 6379:6379 redis
npm start                        start the server
npm test                         run tests
```

## 30-second pitch

"I built a rate limiter service with Node, Express and Redis. It implements three algorithms: Fixed Window, Token Bucket and Sliding Window, and each route picks one from a config file. I used Redis Lua scripts so the check is atomic, which stops two simultaneous requests from slipping past the limit. It has a global limit and strict limits on routes like login, a stats endpoint showing allowed and blocked counts, tests for all three algorithms, and it runs with Docker Compose."

## Interview questions and answers

**Why do you need a rate limiter?**
To protect the API from abuse and overload, keep it fair for all users, and slow down attacks like password guessing.

**Why 3 algorithms, and how do you choose?**
Each fits a different need. Fixed Window is the simplest and cheapest. Token Bucket allows bursts and keeps the average rate limited. Sliding Window is the most accurate and has no boundary loophole. I choose by the route: sliding for login, token bucket for search, fixed for an hourly upload cap.

**What is the boundary problem in Fixed Window?**
A user can use the full limit at the end of one window and the full limit again at the start of the next, so they send up to twice the limit in a short time.

**Why Redis and not a variable in Node's memory?**
Memory is lost on restart, and it is not shared between several servers. Redis is shared, fast and has built-in expiry.

**Why Lua scripts?**
Reading a value, calculating and writing it back are 3 steps. Two requests could interleave between the steps and both pass. A Lua script runs in Redis as one atomic unit.

**Why does `INCR` solve the Fixed Window race?**
`INCR` is atomic and returns the new number. Each request gets a different number, so only the ones under the limit pass.

**Explain the off-by-one bug you found.**
My first version read the count, compared it with the limit and then incremented. That allowed one extra request. The fix is to increment first, then compare the returned number with the limit. My own test caught it: the 11th upload returned 200 instead of 429.

**What does fail open mean? Is it always right?**
If Redis is down, the limiter lets requests through. That keeps the API available. For security-critical routes some teams prefer fail closed. It is a choice between availability and protection.

**How does Token Bucket work internally?**
It stores the token count and the last refill time. On each request, the script adds `elapsed seconds times refill rate` tokens (up to the capacity), then takes one if at least one is available.

**Why a sorted set for Sliding Window? Why a unique ID per entry?**
A sorted set keeps entries ordered by time and lets me delete everything older than the window by score in one command. The unique ID stops two requests with the same timestamp from overwriting each other.

**How do you tell the client when to retry?**
The `Retry-After` header. For sliding window it is the time until the oldest entry leaves the window.

**How do you count allowed and blocked requests without editing each algorithm?**
A wrapper passes a fake `next` called `markAllowed` to the limiter. If the limiter calls it, the request was allowed. If it sends a 429 instead, it wasn't called, so it was blocked.

**What are the weaknesses?**
It limits by IP, so many users behind one network share a limit. It depends on one Redis. And behind a proxy I must configure `trust proxy`.

**How would you scale this to many servers?**
All servers share the same Redis, so the counters are global. For more load, use Redis Cluster.

**How would you rate limit by user instead of IP?**
Use the user ID from the JWT in the key when the user is logged in, and fall back to IP for anonymous users.

**What would you improve with more time?**
Per-user and per-API-key limits, rules from a database, a dashboard, a library version, and sticky limits for very sensitive routes.

**What did you learn?**
Concurrency bugs are invisible until you test with simultaneous requests, atomic operations matter, and the right algorithm depends on what the route needs.
