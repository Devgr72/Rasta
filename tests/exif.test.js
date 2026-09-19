// tests/exif.test.js — GPS / time / orientation are read from a hand-built EXIF block, then the
// stored bytes carry no metadata except an Orientation-only tag.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readExif, readAndStrip, stripJpegMetadata, stripPngMetadata, parseExifDate } = require('../lib/exif');
const { imageSize } = require('../lib/image-size');

const { BASE_JPEG, jpegWithExif: withExif, hasApp1 } = require('./helpers');

describe('readExif', () => {
  test('reads GPS, DateTimeOriginal and Orientation', async () => {
    const m = await readExif(withExif());
    assert.ok(Math.abs(m.lat - 28.6672) < 1e-4, `lat ${m.lat}`);
    assert.ok(Math.abs(m.lng - 77.2286) < 1e-4, `lng ${m.lng}`);
    assert.equal(m.taken_at, '2026-09-19T10:30:00', 'camera wall-clock time, no zone invented');
    assert.equal(m.orientation, 6);
  });
  test('returns nulls for a photo without EXIF and never throws on junk', async () => {
    assert.deepEqual(await readExif(BASE_JPEG), { lat: null, lng: null, taken_at: null, orientation: null });
    assert.deepEqual(await readExif(Buffer.from('not an image at all')), { lat: null, lng: null, taken_at: null, orientation: null });
  });
  test('parseExifDate handles the EXIF colon format and an optional offset', () => {
    assert.equal(parseExifDate('2024:01:05 08:09:10'), '2024-01-05T08:09:10');
    assert.equal(parseExifDate('2024:01:05 08:09:10', '+05:30'), '2024-01-05T08:09:10+05:30');
    assert.equal(parseExifDate('2024:01:05 08:09:10', 'junk'), '2024-01-05T08:09:10');
    assert.equal(parseExifDate('0000:00:00 00:00:00'), null, 'unset camera clock');
    assert.equal(parseExifDate('garbage'), null);
    assert.equal(parseExifDate(undefined), null);
  });
});

describe('stripping', () => {
  test('readAndStrip removes the EXIF block but keeps a minimal Orientation tag and a decodable image', async () => {
    const src = withExif({ orientation: 6 });
    const { meta, buf, stripped_bytes } = await readAndStrip(src);
    assert.equal(meta.lat != null, true);
    assert.ok(stripped_bytes > 100, `stripped ${stripped_bytes}`);
    assert.ok(buf.length < src.length);
    const again = await readExif(buf);
    assert.equal(again.lat, null, 'GPS gone');
    assert.equal(again.taken_at, null, 'time gone');
    assert.equal(again.orientation, 6, 'orientation preserved');
    assert.deepEqual(imageSize(buf), { type: 'jpeg', width: 1, height: 1 }, 'frame header intact');
    assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
    assert.deepEqual(buf.subarray(-8), src.subarray(-8), 'entropy-coded tail untouched');
  });
  test('orientation 1 (or none) leaves no APP1 at all', async () => {
    const { buf } = await readAndStrip(withExif({ orientation: 1 }));
    assert.equal(hasApp1(buf), false);
    const plain = await readAndStrip(BASE_JPEG);
    assert.equal(plain.stripped_bytes, 0);
    assert.deepEqual(plain.buf, BASE_JPEG);
  });
  test('COM and APP13 segments are dropped too; APP0 and APP2 are kept', () => {
    const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x07]), Buffer.from('hello')]);
    const app13 = Buffer.concat([Buffer.from([0xff, 0xed, 0x00, 0x06]), Buffer.from('iptc')]);
    const app2 = Buffer.concat([Buffer.from([0xff, 0xe2, 0x00, 0x05]), Buffer.from('icc')]);
    const src = Buffer.concat([BASE_JPEG.subarray(0, 20), com, app13, app2, BASE_JPEG.subarray(20)]);
    const out = stripJpegMetadata(src);
    assert.equal(out.length, src.length - com.length - app13.length);
    assert.equal(out.includes(Buffer.from('icc')), true);
    assert.equal(out.includes(Buffer.from('hello')), false);
    assert.deepEqual(imageSize(out), { type: 'jpeg', width: 1, height: 1 });
  });
  test('non-JPEG input is returned untouched by the JPEG stripper', () => {
    const b = Buffer.from('RIFF....WEBPVP8 ');
    assert.equal(stripJpegMetadata(b), b);
  });
  test('PNG textual and eXIf chunks are dropped, IHDR/IDAT/IEND kept', () => {
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4);
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0secret')), chunk('eXIf', Buffer.alloc(30)), chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND', Buffer.alloc(0))]);
    const out = stripPngMetadata(png);
    assert.equal(out.includes(Buffer.from('secret')), false);
    assert.equal(out.includes(Buffer.from('eXIf')), false);
    assert.equal(out.includes(Buffer.from('IDAT')), true);
    assert.deepEqual(imageSize(out), { type: 'png', width: 2, height: 2 });
  });
});
