export const limits = {
  // Applies to every route
  global: { algorithm: "slidingWindow", limit: 100, windowSeconds: 60 },

  // Strict: stops password guessing
  login: { algorithm: "slidingWindow", limit: 5, windowSeconds: 60 },

  // Flexible: allows quick bursts, refills smoothly
  search: { algorithm: "tokenBucket", capacity: 20, refillPerSecond: 5 },

  // Simple hourly cap
  upload: { algorithm: "fixedWindow", limit: 10, windowSeconds: 3600 },
};