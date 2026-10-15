import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import postRoutes from './routes/posts.js';
import feedRoutes from './routes/feed.js';
import messageRoutes from './routes/messages.js';
import notificationRoutes from './routes/notifications.js';
import noteRoutes from './routes/notes.js';
import storyRoutes from './routes/stories.js';
import reelRoutes from './routes/reels.js';
import gameRoutes from './routes/games.js';
import tournamentRoutes from './routes/tournaments.js';
import reportRoutes from './routes/reports.js';
import searchRoutes from './routes/search.js';
import appRoutes from './routes/apps.js';
import callRoutes from './routes/calls.js';
import codexRoutes from './routes/codex.js';
import { registerGameHandlers } from './gameEngine.js';
import { registerCallHandlers } from './callEngine.js';
import { ACCESS_SECRET, REFRESH_SECRET } from './middleware/auth.js';
import { UPLOADS_ROOT } from './uploads.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';

// Refuse to boot in production with the built-in dev secrets: anyone could forge tokens.
if (IS_PROD && (ACCESS_SECRET.includes('change-me') || REFRESH_SECRET.includes('change-me'))) {
  console.error('[nexa] Refusing to start: set NEXA_ACCESS_SECRET and NEXA_REFRESH_SECRET in production.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // correct client IPs for rate limiting behind a reverse proxy
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Uploaded reel video files (see uploads.js) — served back as plain static files, outside
// the /api namespace, so <video src="/uploads/reels/...mp4"> just works like any hosted URL.
app.use('/uploads', express.static(UPLOADS_ROOT));

// Rate limiting: tighter on auth (brute-force protection), looser but present on general API.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } } });

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'nexa-backend', time: new Date().toISOString() }));
// Readiness: proves the database actually answers (used by Docker/orchestrator health checks).
app.get('/api/ready', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ready: true, uptime: Math.round(process.uptime()) }); }
  catch { res.status(503).json({ ready: false }); }
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/posts', apiLimiter, postRoutes);
app.use('/api/feed', apiLimiter, feedRoutes);
app.use('/api/messages', apiLimiter, messageRoutes);
app.use('/api/notifications', apiLimiter, notificationRoutes);
app.use('/api/notes', apiLimiter, noteRoutes);
app.use('/api/stories', apiLimiter, storyRoutes);
app.use('/api/reels', apiLimiter, reelRoutes);
app.use('/api/games', apiLimiter, gameRoutes);
app.use('/api/tournaments', apiLimiter, tournamentRoutes);
app.use('/api/reports', apiLimiter, reportRoutes);
app.use('/api/search', apiLimiter, searchRoutes);
app.use('/api/apps', apiLimiter, appRoutes);
app.use('/api/calls', apiLimiter, callRoutes);
const codexLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many Codex requests. Please slow down.' } } });
// The on-screen agent makes several cheap calls per command (resolve + report per step, plus a few
// retries while a page loads). Those get their own, higher ceiling; /act (which can call the LLM)
// keeps the tight one.
const codexUiLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many Codex requests. Please slow down.' } } });
app.use('/api/codex', (req, res, next) => (req.path.startsWith('/ui-') ? codexUiLimiter : codexLimiter)(req, res, next), codexRoutes);

// 404 for unknown API routes
app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));

// Serve the built web app from the same server (one process, one port) when frontend/dist exists.
const DIST = process.env.NEXA_STATIC_DIR || path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST, {
    index: false,
    setHeaders: (res, file) => {
      // hashed assets are immutable; the service worker and HTML must always revalidate
      if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api|uploads|socket\.io).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  console.log('[nexa] serving web app from', DIST);
}

// Centralized error handler: never leak stack traces to clients.
app.use((err, _req, res, _next) => {
  console.error('[nexa] unhandled error:', err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, ACCESS_SECRET);
    socket.userId = payload.sub;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  socket.on('typing', ({ conversationId }) => {
    socket.to(`conversation:${conversationId}`).emit('typing', { userId: socket.userId, conversationId });
  });
  socket.on('conversation:join', ({ conversationId }) => {
    socket.join(`conversation:${conversationId}`);
  });
  registerGameHandlers(io, socket);
  registerCallHandlers(io, socket);
});

const PORT = process.env.PORT || 4000;
// Large post/story videos can take longer than Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.listen(PORT, () => {
  console.log(`NEXA backend listening on http://localhost:${PORT}`);
});

// Graceful shutdown: stop accepting connections, close sockets and the database cleanly.
function shutdown(signal) {
  console.log(`[nexa] ${signal} received, shutting down…`);
  io.close();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
