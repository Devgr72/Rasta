// lib/storage.js — where photo files live. Two drivers behind one interface:
//   local (default): files under RASTA_UPLOAD_DIR, served at /uploads/<name> by express.static
//   s3:    any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) via SigV4-signed fetch, no SDK
// Interface: kind, put(name, buf, contentType), exists(name), get(name), delete(name), url(name).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const mimeFor = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

// RFC 3986 encoding as AWS expects it (encodeURIComponent leaves !'()* alone; AWS does not).
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * AWS Signature Version 4 for a single request. Returns the headers to send (input headers plus
 * x-amz-date, x-amz-content-sha256 and Authorization). Pure function of its inputs — testable
 * against the published AWS test vectors.
 */
function signV4({ method, url, headers = {}, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, ''); // 20150830T123600Z
  const shortDate = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])) };
  h.host = u.host;
  h['x-amz-date'] = amzDate;
  if (service === 's3') h['x-amz-content-sha256'] = payloadHash;
  if (sessionToken) h['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(h).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${h[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalUri = u.pathname.split('/').map((seg) => (service === 's3' ? rfc3986(decodeURIComponent(seg)) : rfc3986(rfc3986(decodeURIComponent(seg))))).join('/') || '/';
  const params = [...u.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, shortDate), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: h, canonicalRequest, stringToSign, signature };
}

// ---------- local ----------
function localDriver({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const safe = (name) => path.join(dir, path.basename(name));
  return {
    kind: 'local',
    dir,
    async put(name, buf) { const p = safe(name); if (!fs.existsSync(p)) fs.writeFileSync(p, buf); return { stored: true }; },
    async exists(name) { return fs.existsSync(safe(name)); },
    async get(name) {
      const p = safe(name);
      if (!fs.existsSync(p)) return null;
      return { body: fs.createReadStream(p), contentType: mimeFor(name), size: fs.statSync(p).size };
    },
    async delete(name) { try { fs.unlinkSync(safe(name)); return true; } catch { return false; } },
    url(name) { return `/uploads/${path.basename(name)}`; },
  };
}

// ---------- s3-compatible ----------
function s3Driver(cfg) {
  const { bucket, region = 'auto', accessKeyId, secretAccessKey, sessionToken, prefix = '', publicUrl = '' } = cfg;
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error('RASTA_STORAGE=s3 needs RASTA_S3_BUCKET, RASTA_S3_ACCESS_KEY_ID and RASTA_S3_SECRET_ACCESS_KEY');
  const endpoint = (cfg.endpoint || `https://s3.${region}.amazonaws.com`).replace(/\/$/, '');
  const pathStyle = cfg.forcePathStyle != null ? cfg.forcePathStyle : !!cfg.endpoint; // custom endpoints (R2, MinIO) are path-style
  const keyFor = (name) => `${prefix}${path.basename(name)}`;
  const objectUrl = (name) => {
    const key = keyFor(name).split('/').map(rfc3986).join('/');
    if (pathStyle) return `${endpoint}/${bucket}/${key}`;
    const u = new URL(endpoint); return `${u.protocol}//${bucket}.${u.host}/${key}`;
  };
  async function request(method, name, { body, headers = {} } = {}) {
    const url = objectUrl(name);
    const payloadHash = body ? sha256hex(body) : sha256hex('');
    const signed = signV4({ method, url, headers, payloadHash, region, service: 's3', accessKeyId, secretAccessKey, sessionToken });
    const r = await fetch(url, { method, headers: signed.headers, body });
    return r;
  }
  return {
    kind: 's3',
    bucket, endpoint, prefix, pathStyle,
    async put(name, buf, contentType) {
      const r = await request('PUT', name, { body: buf, headers: { 'content-type': contentType || mimeFor(name), 'content-length': String(buf.length) } });
      if (!r.ok) throw new Error(`S3 PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return { stored: true };
    },
    async exists(name) { const r = await request('HEAD', name); return r.ok; },
    async get(name) {
      const r = await request('GET', name);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`S3 GET ${r.status}`);
      return { body: r.body, contentType: r.headers.get('content-type') || mimeFor(name), size: Number(r.headers.get('content-length')) || null };
    },
    async delete(name) { const r = await request('DELETE', name); return r.ok || r.status === 404; },
    // With a public/CDN base URL the browser fetches straight from the bucket; otherwise the
    // server proxies /uploads/<name> so the API contract is identical under both drivers.
    url(name) { return publicUrl ? `${publicUrl.replace(/\/$/, '')}/${keyFor(name)}` : `/uploads/${path.basename(name)}`; },
  };
}

function createStorage(env = process.env, { uploadDir } = {}) {
  const kind = (env.RASTA_STORAGE || 'local').toLowerCase();
  if (kind === 's3') {
    return s3Driver({
      bucket: env.RASTA_S3_BUCKET,
      region: env.RASTA_S3_REGION || 'auto',
      endpoint: env.RASTA_S3_ENDPOINT,
      accessKeyId: env.RASTA_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.RASTA_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
      prefix: env.RASTA_S3_PREFIX || '',
      publicUrl: env.RASTA_S3_PUBLIC_URL || '',
      forcePathStyle: env.RASTA_S3_FORCE_PATH_STYLE == null ? undefined : env.RASTA_S3_FORCE_PATH_STYLE === '1',
    });
  }
  if (kind !== 'local') throw new Error(`unknown RASTA_STORAGE "${kind}" (use local or s3)`);
  return localDriver({ dir: uploadDir || env.RASTA_UPLOAD_DIR || path.join(__dirname, '..', 'uploads') });
}

module.exports = { createStorage, signV4, localDriver, s3Driver, mimeFor, sha256hex };
