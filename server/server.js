// Pinpoint server: feedback API, widget hosting and dashboard in one process.
// Zero dependencies; needs Node >= 22.5 for node:sqlite.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY = 10 * 1024 * 1024;
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const LOGIN_LIMIT = { windowMs: 60_000, max: 10 };
const SESSION_MS = 7 * 24 * 3600 * 1000;
const STATUSES = ['new', 'acknowledged', 'resolved', 'archived'];

export function createServer(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? path.join(__dirname, 'data'));
  const imageDir = path.join(dataDir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });

  let adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(9).toString('base64url');
    console.warn(`ADMIN_PASSWORD not set. Generated one for this run: ${adminPassword}`);
  }
  const secret = loadSecret(path.join(dataDir, 'secret.key'));

  const db = new DatabaseSync(path.join(dataDir, 'pinpoint.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL UNIQUE,
      allowed_origins TEXT NOT NULL DEFAULT '["*"]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      comment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      page_url TEXT,
      page_title TEXT,
      full_path TEXT,
      crop_path TEXT,
      region TEXT,
      scroll TEXT,
      viewport TEXT,
      selector TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_project ON feedback(project_id, created_at DESC);
  `);

  const q = {
    projects: db.prepare('SELECT p.*, (SELECT COUNT(*) FROM feedback f WHERE f.project_id = p.id) AS feedback_count, (SELECT COUNT(*) FROM feedback f WHERE f.project_id = p.id AND f.status = \'new\') AS new_count FROM projects p ORDER BY created_at DESC'),
    projectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    projectByKey: db.prepare('SELECT * FROM projects WHERE public_key = ?'),
    insertProject: db.prepare('INSERT INTO projects (id, name, public_key, allowed_origins, created_at) VALUES (?, ?, ?, ?, ?)'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    feedbackById: db.prepare('SELECT f.*, p.name AS project_name FROM feedback f JOIN projects p ON p.id = f.project_id WHERE f.id = ?'),
    feedbackFiles: db.prepare('SELECT full_path, crop_path FROM feedback WHERE project_id = ?'),
    insertFeedback: db.prepare(`INSERT INTO feedback (id, project_id, name, comment, page_url, page_title, full_path, crop_path, region, scroll, viewport, selector, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteFeedback: db.prepare('DELETE FROM feedback WHERE id = ?'),
    setStatus: db.prepare('UPDATE feedback SET status = ? WHERE id = ?'),
  };

  const rate = new Map();
  function limited(bucket, key, { windowMs, max }) {
    const now = Date.now();
    const k = `${bucket}:${key}`;
    const hits = (rate.get(k) ?? []).filter((t) => now - t < windowMs);
    hits.push(now);
    rate.set(k, hits);
    if (rate.size > 5000) for (const [kk, v] of rate) if (!v.some((t) => now - t < windowMs)) rate.delete(kk);
    return hits.length > max;
  }

  // ---- auth ----
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
  function makeToken() {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  }
  function isAdmin(req) {
    const m = /(?:^|;\s*)pp_session=([^;]+)/.exec(req.headers.cookie ?? '');
    if (!m) return false;
    const [exp, sig] = decodeURIComponent(m[1]).split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const want = sign(exp);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }

  // ---- helpers ----
  function send(res, status, body, headers = {}) {
    const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : body);
  }
  const err = (res, status, message, headers) => send(res, status, { error: message }, headers);

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Payload too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const normOrigin = (o) => String(o).trim().replace(/\/+$/, '').toLowerCase();

  function parseOrigins(input) {
    const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
      .map(normOrigin)
      .filter(Boolean);
    return list.length ? list : ['*'];
  }
  function originAllowed(project, origin) {
    const allowed = JSON.parse(project.allowed_origins);
    if (allowed.includes('*')) return true;
    return !!origin && allowed.includes(normOrigin(origin));
  }

  function decodeImage(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
    if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpg)) return null;
    return { buf, ext: m[1] === 'png' ? 'png' : 'jpg' };
  }

  const json = (s) => (s ? JSON.parse(s) : null);
  const publicFeedback = (r) => ({
    id: r.id, project_id: r.project_id, project_name: r.project_name, name: r.name, comment: r.comment, status: r.status,
    page_url: r.page_url, page_title: r.page_title,
    full_image: r.full_path ? `/images/${r.full_path}` : null,
    crop_image: r.crop_path ? `/images/${r.crop_path}` : null,
    region: json(r.region), scroll: json(r.scroll), viewport: json(r.viewport),
    selector: r.selector, user_agent: r.user_agent, created_at: r.created_at,
  });
  const publicProject = (p) => ({
    id: p.id, name: p.name, public_key: p.public_key, allowed_origins: JSON.parse(p.allowed_origins),
    created_at: p.created_at, feedback_count: p.feedback_count ?? 0, new_count: p.new_count ?? 0,
  });

  function removeFiles(...names) {
    for (const n of names) if (n) fs.rm(path.join(imageDir, path.basename(n)), { force: true }, () => {});
  }

  function listFeedback(url) {
    const where = [];
    const args = [];
    const project = url.searchParams.get('project');
    const status = url.searchParams.get('status');
    const text = url.searchParams.get('q');
    if (project) { where.push('f.project_id = ?'); args.push(project); }
    if (status && STATUSES.includes(status)) { where.push('f.status = ?'); args.push(status); }
    else if (!status) where.push("f.status != 'archived'");
    if (text) {
      const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
      where.push("(f.comment LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\' OR f.page_url LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    const sql = `SELECT f.*, p.name AS project_name FROM feedback f JOIN projects p ON p.id = f.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.created_at DESC LIMIT 500`;
    return db.prepare(sql).all(...args);
  }

  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return `"${s.replace(/"/g, '""')}"`;
  };

  const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
  function serveStatic(res, file, headers = {}) {
    fs.readFile(file, (e, data) => {
      if (e) return err(res, 404, 'Not found');
      send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', ...headers });
    });
  }

  // ---- routes ----
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const ip = req.socket.remoteAddress ?? '';
    const origin = req.headers.origin;

    // public: widget assets
    if (route === 'GET /embed.js')
      return serveStatic(res, path.join(PUBLIC_DIR, 'embed.js'), { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
    if (route === 'GET /vendor/html-to-image.js')
      return serveStatic(res, path.join(PUBLIC_DIR, 'vendor/html-to-image.js'), { 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    if (route === 'GET /' || route === 'GET /dashboard') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'dashboard.html'), {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      });
    }

    // public: submit feedback
    if (req.method === 'OPTIONS' && url.pathname === '/api/feedback')
      return send(res, 204, '', { 'Access-Control-Allow-Origin': origin ?? '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });

    if (route === 'POST /api/feedback') {
      const cors = { 'Access-Control-Allow-Origin': origin ?? '*', Vary: 'Origin' };
      const body = await readBody(req);
      const project = q.projectByKey.get(str(body.project, 100));
      if (!project) return err(res, 404, 'Unknown project', cors);
      if (!originAllowed(project, origin)) return err(res, 403, 'Origin not allowed for this project', cors);
      if (limited('submit', `${ip}:${project.id}`, RATE_LIMIT)) return err(res, 429, 'Too many submissions, try again in a minute', cors);
      if (body.website) return send(res, 201, { ok: true }, cors); // honeypot: pretend success

      const name = str(body.name, 100);
      const comment = str(body.comment, 5000);
      if (!name || !comment) return err(res, 400, 'name and comment are required', cors);

      const id = crypto.randomUUID();
      let fullPath = null;
      let cropPath = null;
      const shots = body.screenshot ?? {};
      for (const [kind, key] of [['full', 'full'], ['crop', 'crop']]) {
        if (shots[key] == null) continue;
        const img = decodeImage(shots[key]);
        if (!img) return err(res, 400, `Invalid ${kind} screenshot`, cors);
        const file = `${id}-${kind}.${img.ext}`;
        fs.writeFileSync(path.join(imageDir, file), img.buf);
        if (kind === 'full') fullPath = file; else cropPath = file;
      }

      const meta = body.meta ?? {};
      const small = (v) => (v && typeof v === 'object' ? JSON.stringify(v).slice(0, 500) : null);
      q.insertFeedback.run(
        id, project.id, name, comment,
        str(meta.url, 2000), str(meta.title, 300), fullPath, cropPath,
        small(meta.region), small(meta.scroll), small(meta.viewport),
        str(meta.selector, 500), str(req.headers['user-agent'], 500), Date.now(),
      );
      return send(res, 201, { ok: true, id }, cors);
    }

    // admin: login
    if (route === 'POST /api/login') {
      if (limited('login', ip, LOGIN_LIMIT)) return err(res, 429, 'Too many attempts');
      const body = await readBody(req);
      if (!crypto.timingSafeEqual(sha(body.password ?? ''), sha(adminPassword))) return err(res, 401, 'Wrong password');
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `pp_session=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (route === 'POST /api/logout')
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'pp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });

    // everything below requires the admin session
    const isApi = url.pathname.startsWith('/api/');
    if (isApi || url.pathname.startsWith('/images/')) {
      if (!isAdmin(req)) return err(res, 401, 'Not logged in');
      // CSRF defence for state-changing calls: cookie is SameSite=Strict; also require same-origin if Origin is present
      if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) return err(res, 403, 'Cross-origin request blocked');
    } else return err(res, 404, 'Not found');

    if (route === 'GET /api/session') return send(res, 200, { ok: true });

    if (url.pathname.startsWith('/images/') && req.method === 'GET') {
      const file = path.basename(url.pathname);
      return serveStatic(res, path.join(imageDir, file), { 'Cache-Control': 'private, max-age=3600' });
    }

    if (route === 'GET /api/projects') return send(res, 200, q.projects.all().map(publicProject));
    if (route === 'POST /api/projects') {
      const body = await readBody(req);
      const name = str(body.name, 100);
      if (!name) return err(res, 400, 'name is required');
      const id = crypto.randomUUID();
      const key = 'pk_' + crypto.randomBytes(9).toString('base64url');
      q.insertProject.run(id, name, key, JSON.stringify(parseOrigins(body.allowed_origins)), Date.now());
      return send(res, 201, publicProject(q.projectById.get(id)));
    }

    let m = /^\/api\/projects\/([\w-]+)$/.exec(url.pathname);
    if (m) {
      const project = q.projectById.get(m[1]);
      if (!project) return err(res, 404, 'Project not found');
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const name = body.name !== undefined ? str(body.name, 100) : project.name;
        const origins = body.allowed_origins !== undefined ? parseOrigins(body.allowed_origins) : JSON.parse(project.allowed_origins);
        if (!name) return err(res, 400, 'name cannot be empty');
        db.prepare('UPDATE projects SET name = ?, allowed_origins = ? WHERE id = ?').run(name, JSON.stringify(origins), project.id);
        return send(res, 200, publicProject(q.projectById.get(project.id)));
      }
      if (req.method === 'DELETE') {
        const files = q.feedbackFiles.all(project.id);
        q.deleteProject.run(project.id);
        for (const f of files) removeFiles(f.full_path, f.crop_path);
        return send(res, 200, { ok: true });
      }
    }

    if (route === 'GET /api/feedback') return send(res, 200, listFeedback(url).map(publicFeedback));

    if (route === 'GET /api/feedback.csv') {
      const rows = listFeedback(url);
      const head = ['id', 'project', 'name', 'comment', 'status', 'page_url', 'selector', 'created_at', 'screenshot'];
      const lines = [head.join(',')].concat(rows.map((r) =>
        [r.id, r.project_name, r.name, r.comment, r.status, r.page_url, r.selector, new Date(r.created_at).toISOString(), r.full_path ? `/images/${r.full_path}` : '']
          .map(csvCell).join(',')));
      return send(res, 200, lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="feedback.csv"' });
    }

    m = /^\/api\/feedback\/([\w-]+)$/.exec(url.pathname);
    if (m) {
      const row = q.feedbackById.get(m[1]);
      if (!row) return err(res, 404, 'Feedback not found');
      if (req.method === 'GET') return send(res, 200, publicFeedback(row));
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (!STATUSES.includes(body.status)) return err(res, 400, `status must be one of ${STATUSES.join(', ')}`);
        q.setStatus.run(body.status, row.id);
        return send(res, 200, publicFeedback(q.feedbackById.get(row.id)));
      }
      if (req.method === 'DELETE') {
        q.deleteFeedback.run(row.id);
        removeFiles(row.full_path, row.crop_path);
        return send(res, 200, { ok: true });
      }
    }

    return err(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) err(res, e.status ?? 500, e.status ? e.message : 'Internal error');
      if (!e.status) console.error(e);
    });
  });
  server.on('close', () => db.close());
  return server;
}

function loadSecret(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    const s = crypto.randomBytes(32);
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => console.log(`Pinpoint running on http://localhost:${port}  (dashboard: /dashboard)`));
}
