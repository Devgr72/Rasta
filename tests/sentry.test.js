// tests/sentry.test.js — the minimal Sentry client: DSN parsing, envelope shape, disabled mode.
const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createSentry, parseDsn, framesFrom } = require('../lib/sentry');

describe('parseDsn', () => {
  test('extracts key, host and project id', () => {
    const d = parseDsn('https://abc123@o4507.ingest.us.sentry.io/4507123');
    assert.equal(d.key, 'abc123'); assert.equal(d.host, 'o4507.ingest.us.sentry.io'); assert.equal(d.projectId, '4507123');
    assert.equal(d.endpoint, 'https://o4507.ingest.us.sentry.io/api/4507123/envelope/');
  });
  test('rejects junk', () => {
    assert.equal(parseDsn(''), null); assert.equal(parseDsn(undefined), null);
    assert.equal(parseDsn('not a url'), null); assert.equal(parseDsn('https://sentry.io/123'), null, 'no key');
  });
});

describe('framesFrom', () => {
  test('parses V8 stack lines oldest-first and marks in_app', () => {
    const stack = `Error: boom
    at handler (C:\\app\\server.js:120:9)
    at Layer.handle [as handle_request] (C:\\app\\node_modules\\express\\lib\\router\\layer.js:95:5)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`;
    const f = framesFrom(stack);
    assert.equal(f.length, 3);
    assert.equal(f[2].function, 'handler'); assert.equal(f[2].lineno, 120); assert.equal(f[2].in_app, true);
    assert.equal(f[1].in_app, false); assert.equal(f[0].in_app, false);
  });
});

describe('createSentry', () => {
  const received = [];
  let server, base;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push({ url: req.url, auth: req.headers['x-sentry-auth'], type: req.headers['content-type'], body }); res.writeHead(200); res.end('{}'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  test('disabled without a DSN: captureException resolves null and never calls out', async () => {
    const s = createSentry({ dsn: undefined });
    assert.equal(s.enabled, false);
    assert.equal(await s.captureException(new Error('x')), null);
  });
  test('posts a three-line envelope with the exception, request id tag and auth header', async () => {
    const s = createSentry({ dsn: `http://mykey@127.0.0.1:${server.address().port}/42`, environment: 'test', release: 'rasta@0.2.0' });
    assert.equal(s.enabled, true);
    const err = new Error('database is locked');
    const id = await s.captureException(err, { request_id: 'req-123', request: { method: 'POST', url: '/api/segments' }, extra: { segment: 7 } });
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(received.length, 1);
    const r = received[0];
    assert.equal(r.url, '/api/42/envelope/');
    assert.match(r.auth, /sentry_key=mykey/); assert.match(r.auth, /sentry_version=7/);
    assert.equal(r.type, 'application/x-sentry-envelope');
    const lines = r.body.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].event_id, id);
    assert.equal(lines[1].type, 'event');
    const ev = lines[2];
    assert.equal(ev.exception.values[0].type, 'Error');
    assert.equal(ev.exception.values[0].value, 'database is locked');
    assert.ok(ev.exception.values[0].stacktrace.frames.length > 0);
    assert.equal(ev.tags.request_id, 'req-123');
    assert.equal(ev.request.url, '/api/segments');
    assert.equal(ev.extra.segment, 7);
    assert.equal(ev.environment, 'test'); assert.equal(ev.release, 'rasta@0.2.0');
    void base;
  });
  test('non-Error values and a dead ingest host are handled quietly', async () => {
    const s = createSentry({ dsn: 'http://k@127.0.0.1:9/1' });
    assert.equal(await s.captureException('just a string'), null);
    const ev = s.buildEvent('just a string');
    assert.equal(ev.exception.values[0].value, 'just a string');
  });
});
