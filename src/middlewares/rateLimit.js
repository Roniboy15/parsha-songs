import rateLimit from "express-rate-limit";

// Use app.set('trust proxy', 1) in server.js so real client IP is respected behind proxies (e.g. Render)
const commonOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
};

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // all API reads
  ...commonOptions,
});

export const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,                  // posting new links
  ...commonOptions,
});

export const sensitiveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,                  // deletes, test notify
  ...commonOptions,
});

export const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // admin endpoints
  ...commonOptions,
});