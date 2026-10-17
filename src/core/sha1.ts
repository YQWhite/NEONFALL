// Content identifiers also need to work on LAN HTTP origins, where SubtleCrypto is unavailable.
// SHA-1 is used only for package deduplication; authentication uses the server's scrypt implementation.
export function sha1Fallback(data: Uint8Array): string {
  const blocks = Math.ceil((data.length + 9) / 64);
  const words = new Int32Array(80);
  const state = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const rotate = (value: number, shift: number) => value << shift | value >>> (32 - shift);
  for (let block = 0; block < blocks; block++) {
    words.fill(0, 0, 16);
    for (let i = 0; i < 64; i++) {
      const index = block * 64 + i;
      const value = index < data.length ? data[index] : index === data.length ? 0x80 : 0;
      words[i >>> 2] |= value << (24 - (i & 3) * 8);
    }
    if (block === blocks - 1) {
      words[14] = Math.floor(data.length / 0x20000000);
      words[15] = data.length << 3;
    }
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = state;
    for (let i = 0; i < 80; i++) {
      const fn = i < 20 ? b & c | ~b & d : i < 40 ? b ^ c ^ d : i < 60 ? b & c | b & d | c & d : b ^ c ^ d;
      const constant = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotate(a, 5) + fn + e + constant + words[i]) | 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = next;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
  }
  return Array.from(state, value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}
