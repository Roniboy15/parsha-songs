export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map(i => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return res.status(400).json({ error: "invalid_input", details });
    }
    req.body = result.data; // use sanitized values
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const details = result.error.issues.map(i => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return res.status(400).json({ error: "invalid_query", details });
    }
    // DON'T reassign req.query directly - use res.locals instead
    res.locals.validatedQuery = result.data;
    next();
  };
}