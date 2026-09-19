// lib/exif.js — read GPS, capture time and orientation from a photo, then strip its metadata.
// Location is kept in the database (photo_lat/photo_lng/taken_at); the stored file carries none of
// it, except a minimal Orientation tag so rotated phone photos still display upright.
const exifr = require('exifr');

/** { lat, lng, taken_at (ISO string), orientation } — every field may be null. Never throws. */
async function readExif(buf) {
  const out = { lat: null, lng: null, taken_at: null, orientation: null };
  try {
    const x = await exifr.parse(buf, {
      tiff: true, ifd0: ['Orientation'], exif: ['DateTimeOriginal', 'OffsetTimeOriginal'], gps: true,
      iptc: false, xmp: false, icc: false, jfif: false, ihdr: false, interop: false, makerNote: false, userComment: false,
      // reviveValues is off on purpose: EXIF times carry no zone, and reviving them as a local Date
      // would shift every photo by the *server's* timezone. We keep the camera's wall-clock string.
      translateKeys: true, translateValues: false, reviveValues: false, sanitize: true, mergeOutput: true,
    });
    if (x) {
      if (Number.isFinite(x.latitude) && Number.isFinite(x.longitude) && (x.latitude !== 0 || x.longitude !== 0)) { out.lat = x.latitude; out.lng = x.longitude; }
      const t = parseExifDate(x.DateTimeOriginal, x.OffsetTimeOriginal);
      if (t) out.taken_at = t;
      if (Number.isInteger(x.Orientation) && x.Orientation >= 1 && x.Orientation <= 8) out.orientation = x.Orientation;
    }
  } catch { /* no EXIF, truncated EXIF, unsupported container — all fine */ }
  return out;
}

/**
 * "2026:09:19 10:30:00" → "2026-09-19T10:30:00", plus the offset ("+05:30") when the camera
 * recorded one. Without an offset the value is the local wall-clock time, deliberately unsuffixed.
 */
function parseExifDate(s, offset) {
  if (s instanceof Date) s = `${s.getFullYear()}:${String(s.getMonth() + 1).padStart(2, '0')}:${String(s.getDate()).padStart(2, '0')} ${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}:${String(s.getSeconds()).padStart(2, '0')}`;
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m || m[1] === '0000') return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (Number.isNaN(new Date(iso + 'Z').getTime())) return null;
  const off = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : '';
  return iso + off;
}

// A 32-byte EXIF block holding only IFD0/Orientation (little-endian TIFF).
function orientationOnlyApp1(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(0x2a, 2); tiff.writeUInt32LE(8, 4); // header
  tiff.writeUInt16LE(1, 8);                       // one IFD entry
  tiff.writeUInt16LE(0x0112, 10);                 // Orientation
  tiff.writeUInt16LE(3, 12);                      // SHORT
  tiff.writeUInt32LE(1, 14);                      // count
  tiff.writeUInt16LE(orientation, 18);            // value (left-justified in the 4-byte slot)
  tiff.writeUInt32LE(0, 22);                      // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0); seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

/**
 * Remove metadata segments from a JPEG: APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), COM. JFIF
 * (APP0), ICC colour profiles (APP2) and Adobe (APP14) are kept — they affect how pixels render.
 * If `keepOrientation` is 2..8 a minimal EXIF with just that tag is written back.
 * Non-JPEG buffers are returned unchanged.
 */
function stripJpegMetadata(buf, keepOrientation = null) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return buf;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  let inserted = false;
  const insertOrientation = () => { if (!inserted && keepOrientation >= 2 && keepOrientation <= 8) { parts.push(orientationOnlyApp1(keepOrientation)); inserted = true; } };
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break; // corrupt — keep the rest as is
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) { insertOrientation(); parts.push(buf.subarray(i)); i = buf.length; break; } // SOS: entropy data to the end
    const len = buf.readUInt16BE(i + 2);
    const segment = buf.subarray(i, i + 2 + len);
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe; // APP1, APP13, COM
    if (marker !== 0xe0) insertOrientation(); // put the orientation block right after JFIF (or first)
    if (!drop) parts.push(segment);
    i += 2 + len;
  }
  if (i < buf.length) parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

/** PNG: drop eXIf and textual chunks; keep everything that affects rendering. */
function stripPngMetadata(buf) {
  if (!(buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG')) return buf;
  const drop = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + len;
    if (!drop.has(type)) parts.push(buf.subarray(i, Math.min(end, buf.length)));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

/** Read location/time/orientation, then return the metadata-free bytes. */
async function readAndStrip(buf) {
  const meta = await readExif(buf);
  let clean = buf;
  if (buf[0] === 0xff && buf[1] === 0xd8) clean = stripJpegMetadata(buf, meta.orientation);
  else if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') clean = stripPngMetadata(buf);
  return { meta, buf: clean, stripped_bytes: buf.length - clean.length };
}

module.exports = { readExif, stripJpegMetadata, stripPngMetadata, readAndStrip, orientationOnlyApp1, parseExifDate };
