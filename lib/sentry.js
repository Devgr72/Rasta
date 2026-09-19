// lib/sentry.js — optional error reporting to Sentry with no SDK: when SENTRY_DSN is set, errors are
// posted as envelopes to the ingest API (fire-and-forget, never throws, never blocks a response).
// Swap in @sentry/node later if you want tracing/profiling; the call sites stay the same.
const crypto = require('crypto');
const os = require('os');

const CLIENT = 'rasta-minimal-sentry/0.2';

function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!u.username || !projectId) return null;
    return { key: u.username, host: u.host, protocol: u.protocol, projectId, endpoint: `${u.protocol}//${u.host}/api/${projectId}/envelope/` };
  } catch { return null; }
}

// "    at fn (file:line:col)" → { function, filename, lineno, colno }. Frames are oldest-first for Sentry.
function framesFrom(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    frames.push({ function: m[1] || '<anonymous>', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|node:internal/.test(m[2]) });
  }
  return frames.reverse();
}

function createSentry({ dsn = process.env.SENTRY_DSN, environment = process.env.NODE_ENV || 'development', release = process.env.SENTRY_RELEASE, fetchImpl = fetch } = {}) {
  const cfg = parseDsn(dsn);
  const enabled = !!cfg;
  if (dsn && !cfg) console.warn('[sentry] SENTRY_DSN is not a valid DSN — error reporting disabled');

  function buildEvent(err, ctx = {}) {
    const isErr = err instanceof Error;
    return {
      event_id: crypto.randomUUID().replace(/-/g, ''),
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: ctx.level || 'error',
      logger: 'rasta',
      server_name: os.hostname(),
      release, environment,
      sdk: { name: CLIENT.split('/')[0], version: CLIENT.split('/')[1] },
      exception: { values: [{ type: isErr ? err.name : 'Error', value: isErr ? err.message : String(err), stacktrace: isErr ? { frames: framesFrom(err.stack) } : undefined }] },
      tags: { ...(ctx.tags || {}), ...(ctx.request_id ? { request_id: ctx.request_id } : {}) },
      extra: ctx.extra || {},
      request: ctx.request ? { method: ctx.request.method, url: ctx.request.url } : undefined,
    };
  }

  /** Send one error. Resolves to the event id (or null when disabled / failed). Never throws. */
  async function captureException(err, ctx = {}) {
    if (!enabled) return null;
    const event = buildEvent(err, ctx);
    const envelope = [
      JSON.stringify({ event_id: event.event_id, sent_at: event.timestamp, dsn }),
      JSON.stringify({ type: 'event', content_type: 'application/json' }),
      JSON.stringify(event),
    ].join('\n') + '\n';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetchImpl(cfg.endpoint, {
        method: 'POST', body: envelope, signal: ctrl.signal,
        headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=${CLIENT}, sentry_key=${cfg.key}` },
      });
      clearTimeout(t);
      if (!r.ok) { console.warn(`[sentry] ingest responded ${r.status}`); return null; }
      return event.event_id;
    } catch (e) { console.warn('[sentry] send failed:', e.message); return null; }
  }

  /** Report crashes that would otherwise only hit stderr. */
  function installProcessHandlers() {
    if (!enabled) return;
    process.on('unhandledRejection', (reason) => { captureException(reason instanceof Error ? reason : new Error(String(reason)), { tags: { source: 'unhandledRejection' } }); });
    process.on('uncaughtException', (err) => { captureException(err, { tags: { source: 'uncaughtException' }, level: 'fatal' }).finally(() => { console.error(err); process.exit(1); }); });
  }

  return { enabled, dsn: cfg, captureException, installProcessHandlers, buildEvent, framesFrom };
}

module.exports = { createSentry, parseDsn, framesFrom };
