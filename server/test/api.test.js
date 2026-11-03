import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, base, dir, cookie, project;

const call = (p, { method = 'GET', body, headers = {} } = {}) =>
  fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinpoint-'));
  server = createServer({ dataDir: dir, adminPassword: 'pw' });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  const login = await call('/api/login', { method: 'POST', body: { password: 'pw' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  project = await (await call('/api/projects', { method: 'POST', body: { name: 'Demo', allowed_origins: 'https://ok.example' } })).json();
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const submit = (over = {}, headers = {}) => call('/api/feedback', {
  method: 'POST', headers: { Origin: 'https://ok.example', ...headers },
  body: { project: project.public_key, name: 'Ada', comment: 'Button is unclear', meta: { url: 'https://ok.example/x', region: { x: 1, y: 2, w: 3, h: 4 } }, screenshot: { full: PNG, crop: PNG }, ...over },
});

test('admin endpoints require login', async () => {
  const saved = cookie; cookie = null;
  assert.equal((await call('/api/projects')).status, 401);
  assert.equal((await call('/api/feedback')).status, 401);
  cookie = saved;
});

test('wrong password rejected', async () => {
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
});

test('submit stores feedback with screenshot, and CORS echoes allowed origin', async () => {
  const res = await submit();
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://ok.example');
  const list = await (await call('/api/feedback')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Ada');
  assert.deepEqual(list[0].region, { x: 1, y: 2, w: 3, h: 4 });
  const img = await call(list[0].full_image);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg'.replace('jpeg', 'png'));
});

test('images require login', async () => {
  const list = await (await call('/api/feedback')).json();
  const saved = cookie; cookie = null;
  assert.equal((await call(list[0].full_image)).status, 401);
  cookie = saved;
});

test('origin not on allowlist is rejected', async () => {
  assert.equal((await submit({}, { Origin: 'https://evil.example' })).status, 403);
});

test('unknown project, missing fields, bad image rejected', async () => {
  assert.equal((await submit({ project: 'pk_nope' })).status, 404);
  assert.equal((await submit({ name: '' })).status, 400);
  assert.equal((await submit({ screenshot: { full: 'data:image/png;base64,AAAA' } })).status, 400);
  assert.equal((await submit({ screenshot: { full: 'data:text/html;base64,PGI+' } })).status, 400);
});

test('submission without screenshot is allowed', async () => {
  assert.equal((await submit({ screenshot: {} })).status, 201);
});

test('status update, filter, search, csv', async () => {
  const list = await (await call('/api/feedback')).json();
  const id = list[0].id;
  assert.equal((await call(`/api/feedback/${id}`, { method: 'PATCH', body: { status: 'resolved' } })).status, 200);
  assert.equal((await call(`/api/feedback/${id}`, { method: 'PATCH', body: { status: 'bogus' } })).status, 400);
  const resolved = await (await call('/api/feedback?status=resolved')).json();
  assert.equal(resolved.length, 1);
  const found = await (await call('/api/feedback?q=unclear')).json();
  assert.ok(found.length >= 1);
  const csv = await (await call('/api/feedback.csv')).text();
  assert.match(csv, /Ada/);
});

test('csv neutralises formulas', async () => {
  await submit({ comment: '=HYPERLINK("http://x")' });
  const csv = await (await call('/api/feedback.csv')).text();
  assert.match(csv, /"'=HYPERLINK/);
});

test('delete feedback removes image files', async () => {
  const list = await (await call('/api/feedback')).json();
  const f = list[0];
  const file = path.join(dir, 'images', path.basename(f.full_image));
  assert.ok(fs.existsSync(file));
  assert.equal((await call(`/api/feedback/${f.id}`, { method: 'DELETE' })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(file));
});

test('cross-origin admin writes blocked', async () => {
  const res = await call('/api/projects', { method: 'POST', body: { name: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});
