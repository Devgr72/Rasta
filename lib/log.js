// lib/log.js — structured JSON logging with a request id on every HTTP line (pino + pino-http).
// The `[vision]` / `[segment]` console lines used during demos are left alone on purpose.
//   LOG_LEVEL   info | debug | warn | error | silent   (default info; tests set silent)
//   LOG_FORMAT  json | pretty                          (default: pretty on a TTY, json otherwise)
const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
const format = process.env.LOG_FORMAT || (process.stdout.isTTY && process.env.NODE_ENV !== 'production' ? 'pretty' : 'json');

let transport;
if (format === 'pretty') {
  try { require.resolve('pino-pretty'); transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }; }
  catch { /* pino-pretty not installed — fall back to JSON */ }
}

const logger = pino({
  level,
  base: { service: 'rasta' },
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
  transport,
});

// Static assets and photos are noisy and uninteresting; API and page loads are logged.
const QUIET = /^\/(vendor|uploads)\/|\.(css|js|map|png|ico|svg|woff2?)(\?|$)/;

const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const given = req.headers['x-request-id'];
    const id = typeof given === 'string' && /^[\w.-]{8,128}$/.test(given) ? given : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  autoLogging: { ignore: (req) => QUIET.test(req.url) },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  customSuccessMessage: (req, res, ms) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(ms)}ms`,
  customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customProps: (req) => ({ ip: req.ip }),
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, ua: req.headers['user-agent'] }),
    res: (res) => ({ status: res.statusCode }),
  },
});

module.exports = { logger, httpLogger, level, format };
