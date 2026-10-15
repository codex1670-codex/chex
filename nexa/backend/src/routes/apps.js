import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function appDTO(app) {
  const aliases = db.prepare('SELECT alias FROM app_aliases WHERE app_id = ?').all(app.id).map(a => a.alias);
  return {
    id: app.id, displayName: app.display_name, launchUrlWeb: app.launch_url_web,
    hasSearch: !!app.search_url_template, nativeOnly: !!app.native_only, aliases,
  };
}

router.get('/', requireAuth, (_req, res) => {
  const apps = db.prepare('SELECT * FROM app_registry ORDER BY display_name ASC').all();
  res.json({ apps: apps.map(appDTO) });
});

// Resolves a free-text app name/alias (and optional search query) to either:
// - a real web URL to open (native_only = false), or
// - an honest "can't launch native apps from a browser" result (native_only = true), or
// - no match at all.
// This never fakes success; the frontend must actually window.open() the returned url.
router.post('/resolve', requireAuth, (req, res) => {
  const { query, searchFor } = req.body || {};
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Provide an app name.' } });
  }

  let app = db.prepare(`
    SELECT ar.* FROM app_registry ar
    LEFT JOIN app_aliases aa ON aa.app_id = ar.id
    WHERE LOWER(ar.display_name) = ? OR aa.alias = ?
    LIMIT 1
  `).get(normalized, normalized);

  if (!app) {
    app = db.prepare(`
      SELECT ar.* FROM app_registry ar
      LEFT JOIN app_aliases aa ON aa.app_id = ar.id
      WHERE LOWER(ar.display_name) LIKE ? OR aa.alias LIKE ?
      LIMIT 1
    `).get(`%${normalized}%`, `%${normalized}%`);
  }

  if (!app) {
    return res.status(404).json({
      resolved: false,
      message: `I don't have "${query}" in the app catalog for this build.`,
    });
  }

  if (app.native_only) {
    return res.json({
      resolved: true, launchable: false, app: appDTO(app),
      message: `${app.display_name} doesn't have a web version I can open from a browser — this build can't launch native OS apps. You'd need to open it directly on your device.`,
    });
  }

  let url = app.launch_url_web;
  if (searchFor && app.search_url_template) {
    url = app.search_url_template.replace('{q}', encodeURIComponent(searchFor));
  }

  res.json({ resolved: true, launchable: true, app: appDTO(app), url });
});

export default router;
