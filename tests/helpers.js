// tests/helpers.js — shared fixtures. Not a *.test.js file, so the runner does not execute it.
const assert = require('node:assert/strict');

/** A valid 1×1 baseline JPEG (JFIF APP0 at bytes 2..20, no EXIF). */
const BASE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

/** Little-endian TIFF inside an APP1 segment: IFD0 {Orientation, ExifIFD→DateTimeOriginal, GPSIFD→lat/lng}. */
function buildExifApp1({ orientation = 6, dateTime = '2026:09:19 10:30:00', lat = [28, 40, 1.92], lng = [77, 13, 42.96] } = {}) {
  const tiff = Buffer.alloc(190);
  let o = 0;
  const u16 = (v) => { tiff.writeUInt16LE(v, o); o += 2; };
  const u32 = (v) => { tiff.writeUInt32LE(v, o); o += 4; };
  const entry = (tag, type, count, valueOrOffset, inlineShort) => { u16(tag); u16(type); u32(count); if (inlineShort) { u16(valueOrOffset); u16(0); } else u32(valueOrOffset); };
  tiff.write('II', 0, 'ascii'); o = 2; u16(0x2a); u32(8);
  u16(3);
  entry(0x0112, 3, 1, orientation, true);
  entry(0x8769, 4, 1, 50);
  entry(0x8825, 4, 1, 88);
  u32(0);
  assert.equal(o, 50);
  u16(1); entry(0x9003, 2, 20, 68); u32(0);
  tiff.write(dateTime + '\0', 68, 'ascii'); o = 88;
  u16(4);
  u16(0x0001); u16(2); u32(2); tiff.write('N\0', o, 'ascii'); o += 4;
  entry(0x0002, 5, 3, 142);
  u16(0x0003); u16(2); u32(2); tiff.write('E\0', o, 'ascii'); o += 4;
  entry(0x0004, 5, 3, 166);
  u32(0);
  assert.equal(o, 142);
  for (const v of [...lat, ...lng]) { u32(Math.round(v * 1000)); u32(1000); }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const hdr = Buffer.alloc(4); hdr.writeUInt16BE(0xffe1, 0); hdr.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([hdr, payload]);
}

/** The base JPEG with an EXIF block spliced in after APP0. Defaults: 28.6672 N, 77.2286 E, orientation 6. */
const jpegWithExif = (opts) => Buffer.concat([BASE_JPEG.subarray(0, 20), buildExifApp1(opts), BASE_JPEG.subarray(20)]);

/** True when a JPEG contains an APP1 (EXIF/XMP) segment before the scan starts. */
function hasApp1(b) {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda) return false;
    if (m === 0xe1) return true;
    i += 2 + b.readUInt16BE(i + 2);
  }
  return false;
}

module.exports = { BASE_JPEG, buildExifApp1, jpegWithExif, hasApp1 };
