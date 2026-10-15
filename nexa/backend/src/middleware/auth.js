import jwt from 'jsonwebtoken';

export const ACCESS_SECRET = process.env.NEXA_ACCESS_SECRET || 'nexa-dev-access-secret-change-me';
export const REFRESH_SECRET = process.env.NEXA_REFRESH_SECRET || 'nexa-dev-refresh-secret-change-me';
export const ACCESS_TTL = '15m';
export const REFRESH_TTL_DAYS = 30;

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } });
  }
  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Session expired or invalid. Please log in again.' } });
  }
}

// Attaches req.userId if a valid token is present, but doesn't reject if absent.
export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, ACCESS_SECRET);
      req.userId = payload.sub;
    } catch { /* ignore, treat as anonymous */ }
  }
  next();
}
