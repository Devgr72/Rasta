// tests/storage.test.js — SigV4 against the AWS published vector, the local driver, and the S3
// driver end to end against a tiny in-process S3 look-alike.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { signV4, createStorage, localDriver, s3Driver, mimeFor } = require('../lib/storage');

describe('signV4', () => {
  test('reproduces the AWS documentation example (IAM ListUsers, 2015-08-30)', () => {
    const r = signV4({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1', service: 'iam',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      date: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(r.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    assert.match(r.stringToSign, /f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59$/);
    assert.equal(r.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });
  test('S3 requests sign x-amz-content-sha256 and encode the key path once', () => {
    const r = signV4({ method: 'PUT', url: 'https://bucket.s3.eu-west-1.amazonaws.com/rasta/a%20b.jpg', payloadHash: 'abc', region: 'eu-west-1', accessKeyId: 'k', secretAccessKey: 's' });
    assert.equal(r.headers['x-amz-content-sha256'], 'abc');
    assert.match(r.canonicalRequest, /^PUT\n\/rasta\/a%20b\.jpg\n/);
    assert.match(r.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
  });
});

describe('local driver', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-store-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  test('put / exists / get / delete / url', async () => {
    const s = localDriver({ dir });
    assert.equal(s.kind, 'local');
    assert.equal(await s.exists('x.jpg'), false);
    await s.put('x.jpg', Buffer.from('bytes'), 'image/jpeg');
    assert.equal(await s.exists('x.jpg'), true);
    const g = await s.get('x.jpg');
    assert.equal(g.contentType, 'image/jpeg'); assert.equal(g.size, 5);
    const chunks = []; for await (const c of g.body) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), 'bytes');
    assert.equal(s.url('x.jpg'), '/uploads/x.jpg');
    assert.equal(s.url('../../etc/passwd'), '/uploads/passwd', 'path components are dropped');
    await s.put('x.jpg', Buffer.from('other'), 'image/jpeg');
    assert.equal(fs.readFileSync(path.join(dir, 'x.jpg'), 'utf8'), 'bytes', 'existing files are not overwritten (content-addressed names)');
    assert.equal(await s.delete('x.jpg'), true);
    assert.equal(await s.delete('x.jpg'), false);
    assert.equal(await s.get('x.jpg'), null);
  });
  test('createStorage defaults to local and rejects unknown kinds', () => {
    assert.equal(createStorage({}, { uploadDir: dir }).kind, 'local');
    assert.equal(createStorage({ RASTA_UPLOAD_DIR: dir }).dir, dir);
    assert.throws(() => createStorage({ RASTA_STORAGE: 'ftp' }), /unknown RASTA_STORAGE/);
    assert.throws(() => createStorage({ RASTA_STORAGE: 's3' }), /RASTA_S3_BUCKET/);
  });
  test('mimeFor', () => {
    assert.equal(mimeFor('a.jpg'), 'image/jpeg'); assert.equal(mimeFor('a.PNG'), 'image/png'); assert.equal(mimeFor('a.bin'), 'application/octet-stream');
  });
});

describe('s3 driver against an in-process S3 look-alike', () => {
  const objects = new Map();
  const seen = [];
  let server, endpoint;
  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, sha: req.headers['x-amz-content-sha256'], date: req.headers['x-amz-date'] });
        if (!/^AWS4-HMAC-SHA256 Credential=/.test(req.headers.authorization || '') || req.url.startsWith('/forbidden/')) { res.writeHead(403); return res.end('<Error>AccessDenied</Error>'); }
        const key = req.url;
        if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
        const o = objects.get(key);
        if (req.method === 'HEAD') { res.writeHead(o ? 200 : 404); return res.end(); }
        if (req.method === 'GET') { if (!o) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length }); return res.end(o.body); }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(405); res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  test('put / exists / get / delete round-trip with path-style URLs and signed headers', async () => {
    const s = s3Driver({ bucket: 'rasta-photos', region: 'auto', endpoint, accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret', prefix: 'photos/' });
    assert.equal(s.kind, 's3'); assert.equal(s.pathStyle, true);
    await s.put('abc.jpg', Buffer.from('jpegbytes'), 'image/jpeg');
    assert.equal(seen.at(-1).method, 'PUT');
    assert.equal(seen.at(-1).url, '/rasta-photos/photos/abc.jpg');
    assert.match(seen.at(-1).auth, /Credential=AKIA-TEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(seen.at(-1).sha.length, 64);
    assert.equal(await s.exists('abc.jpg'), true);
    assert.equal(await s.exists('nope.jpg'), false);
    const g = await s.get('abc.jpg');
    assert.equal(g.contentType, 'image/jpeg'); assert.equal(g.size, 9);
    const chunks = []; for await (const c of g.body) chunks.push(Buffer.from(c));
    assert.equal(Buffer.concat(chunks).toString(), 'jpegbytes');
    assert.equal(await s.delete('abc.jpg'), true);
    assert.equal(await s.get('abc.jpg'), null);
  });
  test('url() proxies through /uploads without a public base, or points at the CDN with one', () => {
    const a = s3Driver({ bucket: 'b', endpoint, accessKeyId: 'k', secretAccessKey: 's', prefix: 'p/' });
    assert.equal(a.url('f.jpg'), '/uploads/f.jpg');
    const b = s3Driver({ bucket: 'b', endpoint, accessKeyId: 'k', secretAccessKey: 's', prefix: 'p/', publicUrl: 'https://cdn.example.org/' });
    assert.equal(b.url('f.jpg'), 'https://cdn.example.org/p/f.jpg');
  });
  test('virtual-host style is used for AWS when no endpoint is given', () => {
    const s = s3Driver({ bucket: 'my-bucket', region: 'ap-south-1', accessKeyId: 'k', secretAccessKey: 's' });
    assert.equal(s.pathStyle, false);
    assert.equal(s.endpoint, 'https://s3.ap-south-1.amazonaws.com');
  });
  test('createStorage wires the RASTA_S3_* variables', () => {
    const s = createStorage({ RASTA_STORAGE: 's3', RASTA_S3_BUCKET: 'b', RASTA_S3_ENDPOINT: endpoint, RASTA_S3_ACCESS_KEY_ID: 'k', RASTA_S3_SECRET_ACCESS_KEY: 's', RASTA_S3_PREFIX: 'x/', RASTA_S3_PUBLIC_URL: 'https://pub' });
    assert.equal(s.kind, 's3'); assert.equal(s.bucket, 'b'); assert.equal(s.url('z.png'), 'https://pub/x/z.png');
  });
  test('a rejected PUT surfaces as an error with the status code', async () => {
    const s = s3Driver({ bucket: 'forbidden', endpoint, accessKeyId: 'k', secretAccessKey: 's' });
    await assert.rejects(s.put('f.jpg', Buffer.from('x'), 'image/jpeg'), /S3 PUT 403/);
  });
});
