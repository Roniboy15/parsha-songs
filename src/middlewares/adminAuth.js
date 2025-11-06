export function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(401).json({ error: "admin-unauthorized" });
}

export function attachAdminFlag(req, res, next) {
  res.locals.isAdmin = !!req.session?.isAdmin;
  next();
}