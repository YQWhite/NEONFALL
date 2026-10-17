// Validate bounded, inert raster avatars without introducing a native dependency.
'use strict';
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
function invalid(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) invalid('avatar dimensions must be between 1 and 2048 pixels');
  return { width, height };
}
function inspectAvatar(bytes, declaredType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) invalid('empty avatar image');
  if (bytes.length > MAX_AVATAR_BYTES) invalid('avatar must be 2 MiB or smaller', 413);
  let format, size;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid('invalid PNG avatar');
    size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    let at = 8, hasPixels = false, complete = false;
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
      if (at + 12 + length > bytes.length) invalid('truncated PNG avatar');
      if (type === 'acTL') invalid('use a still image for your avatar');
      if (type === 'IDAT') hasPixels = true;
      at += 12 + length;
      if (type === 'IEND') { complete = length === 0 && at === bytes.length; break; }
    }
    if (!hasPixels || !complete) invalid('invalid PNG avatar');
    format = { mime: 'image/png', ext: 'png' };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid('truncated JPEG avatar');
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) invalid('invalid JPEG avatar');
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > bytes.length) invalid('truncated JPEG avatar');
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) invalid('invalid JPEG segment');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) invalid('invalid JPEG dimensions');
        size = dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
      }
      at += length;
    }
    if (!size) invalid('JPEG avatar dimensions missing');
    format = { mime: 'image/jpeg', ext: 'jpg' };
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('invalid WebP length');
    let at = 12, hasPixels = false;
    while (at + 8 <= bytes.length) {
      const type = bytes.toString('ascii', at, at + 4), length = bytes.readUInt32LE(at + 4), data = at + 8;
      if (data + length > bytes.length) invalid('truncated WebP avatar');
      if (type === 'ANIM' || type === 'ANMF') invalid('use a still image for your avatar');
      if (type === 'VP8X') {
        if (length !== 10 || bytes[data] & 2) invalid('use a still image for your avatar');
        size = dimensions(1 + bytes.readUIntLE(data + 4, 3), 1 + bytes.readUIntLE(data + 7, 3));
      } else if (type === 'VP8 ' && length >= 10) {
        if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) invalid('invalid WebP frame');
        const frame = dimensions(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff);
        size ||= frame; hasPixels = true;
      } else if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        const bits = bytes.readUInt32LE(data + 1);
        const frame = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        size ||= frame; hasPixels = true;
      }
      at = data + length + (length & 1);
    }
    if (!size || !hasPixels || at !== bytes.length) invalid('invalid WebP avatar');
    format = { mime: 'image/webp', ext: 'webp' };
  } else invalid('use a PNG, JPEG or WebP avatar', 415);
  const mime = String(declaredType || '').split(';', 1)[0].trim().toLowerCase();
  if (mime !== format.mime) invalid('avatar Content-Type does not match the image', 415);
  return { ...format, ...size };
}
module.exports = { inspectAvatar, MAX_AVATAR_BYTES };
