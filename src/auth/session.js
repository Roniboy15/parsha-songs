import session from "express-session";

let store = null;

export async function buildSessionMiddleware(usePg, pgPool) {
  if (usePg) {
    const PgStore = (await import("connect-pg-simple")).default(session);
    store = new PgStore({
      pool: pgPool,
      tableName: "session",
      createTableIfMissing: true,
    });
  }
  return session({
    secret: process.env.SESSION_SECRET || "dev-insecure",
    resave: false,
    saveUninitialized: false,
    store,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8,
    },
  });
}