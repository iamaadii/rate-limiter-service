## Rate Limiting
- It controls how many requests a client can make in a given period.

### Why Rate Limiting?
- Prevent abuse and spam
- Protect APIs from too many requests
- Reduce server overload
- Protect login/payment APIs from brute-force attacks
- Improve availability and fairness

<br>

## 🧠 Core System Concepts

- **Race Conditions (The Glitch):** If a user clicks a button twice at the exact same millisecond, two separate requests hit your server at the same time. Both requests might read the old number from the database before either finished updating it. This causes a counting glitch called a race condition.

- **Lua Scripts (The Single-Shot Fix):** To fix the counting glitch, we use a Lua script (a tiny script that runs directly inside the database). Instead of the server sending a request, waiting, and sending another request (which creates a back-and-forth delay, the "ping-pong" problem), the Lua script forces the database to run all steps (Read, Math, Write) in one single, un-interruptible shot. This guarantees 100% accurate counting.

- **Fail-Open Strategy (Keep the App Running):** If your database crashes or goes offline, your rate limiter middleware will fail. The best practice is to **Fail-Open**. This means your code catches the error, logs it to a tracking system, and lets the user through anyway. It is much better to temporarily lose your rate limiter than to completely crash the entire website for all your regular customers.

### What is Lua?

- Lua is a very small, lightweight, and incredibly fast programming language.
- Redis has a Lua engine built right inside it. This means Redis can read and execute Lua code directly inside its own memory.

### Why do we need it? (The "Ping-Pong" Problem)

In your Token Bucket algorithm, your code has to do multiple steps:

1. Get the current tokens (`HGET`).
2. Calculate the math in JavaScript (how much time passed, add tokens).
3. Check if tokens are at least 1 (`if`).
4. Save the new tokens back to Redis (`HSET`).

**Without Lua (The Slow Way):**

Node.js has to play "ping-pong" with Redis over the network:

- Node.js asks Redis: "Give me the tokens." (Network trip 1)
- Redis answers: "Here they are." (Network trip 2)
- Node.js does the math...
- Node.js tells Redis: "Okay, now save the new count." (Network trip 3)

If two requests from the same user arrive at the exact same millisecond, Node.js might read the tokens for both requests before saving the first one. This creates a glitch (called a **Race Condition**) where the rate limiter miscounts and breaks.

**With Lua (The Fast, Atomic Way):**

Instead of sending data back and forth, you ship the entire recipe (the Lua script) straight into Redis.

- Redis locks your database for a split second.
- It runs all the steps (Get, Math, If, Save) internally in one single shot.
- It just hands Node.js a final answer: `[allowed, remaining]`.

No ping-pong, no glitches. This single-shot execution is called **Atomic**.

---

<br>

## 🕒 Fixed Window Limiter

> **The Core Idea:** You split time into strict boxes, like a 1-minute window. Users get a counter that resets to zero every time a new minute begins.

### How it Works (Step-by-Step)

1. **Identify:** Look up the user's IP address (their digital location).
2. **Check First:** Look at their current count in the database. If the count is already over the limit, block them immediately. (This stops hackers from adding to the counter forever and running your database out of memory.)
3. **Add 1:** If they are under the limit, add 1 to their counter.
4. **Start Timer:** If it is their very first request, start a countdown timer (e.g., 60 seconds) so the counter automatically deletes itself when the minute ends.

### ⚖️ The Pros & Cons

- 🟢 **Pros:** Super fast, incredibly simple to code, and takes up almost zero database memory.
- 🔴 **Cons (The Boundary Flaw):** It has a time-border trick. If a user is allowed 100 requests per minute, they could send 100 requests at 11:59 AM and another 100 requests at 12:00 PM. They successfully bypassed the limiter by sending 200 requests in 2 seconds right at the border where the minute changes.

---

<br>

## 🪣 Token Bucket Limiter

> **The Core Idea:** Think of a physical bucket filled with water tokens (e.g., max 5 tokens). Every click scoops out 1 token. A faucet constantly drips new tokens back into the bucket over time (e.g., 1 token per second).

### How it Works (Step-by-Step)

This entire math logic runs inside a Lua script directly inside the database to prevent the back-and-forth (ping-pong) network delays:

1. **Fetch:** Read the bucket's current tokens and the exact time of the user's last visit.
2. **Refill Math:** Check how much time passed since their last visit. Turn that time into new tokens and add them back to the bucket (but never go over the maximum bucket size).
3. **Take a Token:** If the bucket has at least 1 token, take 1 token away and let the user through. If the bucket is empty, block them.
4. **Clean Up:** Save the new token count and time. Set a self-destruct timer on the bucket. If the user leaves your site and doesn't come back, the bucket automatically deletes itself from memory to save server space.

### ⚖️ The Pros & Cons

- 🟢 **Pros:** Completely fixes the time-border trick. It allows small bursts of fast clicks (up to the bucket size) but smoothly slows down continuous spam. It is highly secure because blocked requests freeze at 0 tokens and never drop below zero.
- 🔴 **Cons:** Harder to write and requires learning how to pass scripts to your database.

---

<br>

## 🕒 Sliding Window Log Limiter

> **The Core Idea:** Think of this like a security camera recording the last 60 seconds of a doorway. As time ticks forward, the 60-second window slides along with it. Instead of counting numbers, the database writes down an exact timestamp log (a history record) of every single click.

To keep this timeline organized, it uses a **Redis Sorted Set** (a specialized database list that automatically keeps items in order from oldest to newest based on a score, which in this case is the time of the click).

### How it Works (Step-by-Step)

This math logic runs inside a Lua script directly inside the database to prevent back-and-forth (ping-pong) network delays:

1. **Throw Away the Past:** The script checks the current time and deletes any old logs that are older than the time window (e.g., if your window is 60 seconds, it instantly wipes out clicks from 61 seconds ago) using the command `ZREMRANGEBYSCORE`.
2. **Count the Rest:** It counts how many timestamps are left in the list using `ZCARD`.
3. **Write Down the Click:** If the count is below your limit, it adds the current request's time to the list using `ZADD` (using a unique ID called a `randomUUID` to make sure every click is a separate item) and lets the user through.
4. **Calculate Wait Time:** If the bucket is full, it looks at the oldest click in the list. It does quick math to figure out exactly how many milliseconds the user has to wait until that oldest click drops off the timeline, and tells the user exactly when to try again (`Retry-After`).

### ⚖️ The Pros & Cons

- 🟢 **Pros:** This is the most accurate rate limiter possible. It completely obliterates the time-border trick found in the Fixed Window algorithm. It tracks a continuous, rolling window perfectly down to the millisecond.
- 🔴 **Cons (The Memory Hog):** Because it saves a unique timestamp for every single request, it uses a massive amount of database memory (RAM). If a hacker attacks you with 1,000,000 requests, your database has to store 1,000,000 text logs. (Note: Your Lua script handles this gracefully by dropping old items first, but it still takes up way more space than just storing a single number).

---