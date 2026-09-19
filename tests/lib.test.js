// tests/lib.test.js — the semaphore that caps model calls and the header-only image sizer.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Semaphore } = require('../lib/semaphore');
const { imageSize } = require('../lib/image-size');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Semaphore', () => {
  test('never runs more than `limit` jobs at once and drains fully', async () => {
    const s = new Semaphore(3);
    let cur = 0, max = 0, done = 0;
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.run(async () => {
      cur++; max = Math.max(max, cur);
      await sleep(5 + (i % 3) * 3);
      cur--; done++;
    })));
    assert.equal(max, 3);
    assert.equal(done, 10);
    assert.equal(s.active, 0);
    assert.equal(s.waiting, 0);
  });
  test('a throwing job releases its slot', async () => {
    const s = new Semaphore(1);
    await assert.rejects(s.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(s.active, 0);
    const v = await s.run(async () => 42);
    assert.equal(v, 42);
  });
  test('waiters are served in FIFO order', async () => {
    const s = new Semaphore(1);
    const order = [];
    const jobs = [1, 2, 3].map((n) => s.run(async () => { order.push(n); await sleep(2); }));
    await Promise.all(jobs);
    assert.deepEqual(order, [1, 2, 3]);
  });
  test('limit is at least 1 even for bad input', () => {
    assert.equal(new Semaphore(0).limit, 1);
    assert.equal(new Semaphore('x').limit, 1);
    assert.equal(new Semaphore(2.7).limit, 2);
  });
});

describe('imageSize', () => {
  const png = (w, h) => { const b = Buffer.alloc(24); b.write('\x89PNG\r\n\x1a\n', 'binary'); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  test('PNG', () => assert.deepEqual(imageSize(png(640, 480)), { type: 'png', width: 640, height: 480 }));
  test('GIF', () => { const b = Buffer.alloc(13); b.write('GIF89a'); b.writeUInt16LE(320, 6); b.writeUInt16LE(200, 8); assert.deepEqual(imageSize(b), { type: 'gif', width: 320, height: 200 }); });
  test('JPEG (walks past APP0 to SOF0)', () => {
    const b = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    assert.deepEqual(imageSize(b), { type: 'jpeg', width: 1, height: 1 });
    // synthetic 4000×3000 SOF0 after an APP1 segment
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x04, 0x00, 0x00])]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03]);
    const j = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(20)]);
    assert.deepEqual(imageSize(j), { type: 'jpeg', width: 4000, height: 3000 });
  });
  test('WebP VP8X extended header', () => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12);
    b.writeUIntLE(1599, 24, 3); b.writeUIntLE(1199, 27, 3);
    assert.deepEqual(imageSize(b), { type: 'webp', width: 1600, height: 1200 });
  });
  test('unknown bytes return null', () => {
    assert.equal(imageSize(Buffer.from('hello there, definitely not an image')), null);
    assert.equal(imageSize(Buffer.alloc(3)), null);
    assert.equal(imageSize('not a buffer'), null);
  });
});
