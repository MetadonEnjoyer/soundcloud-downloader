// Builds an ID3v2.3 tag (UTF-16 text frames + APIC cover) to prepend to MP3 bytes.
globalThis.scdlId3 = (tags) => {
  const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const utf16 = (s) => {
    const b = new Uint8Array(2 + s.length * 2);
    b[0] = 0xff; b[1] = 0xfe; // little-endian BOM
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[2 + i * 2] = c & 0xff;
      b[3 + i * 2] = c >> 8;
    }
    return b;
  };
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const frame = (id, body) => {
    const head = new Uint8Array(10);
    head.set(latin1(id));
    new DataView(head.buffer).setUint32(4, body.length); // v2.3 frame size is a plain 32-bit int
    return cat(head, body);
  };
  const text = (id, v) => (v ? [frame(id, cat([1], utf16(String(v))))] : []);

  const body = cat(
    ...text('TIT2', tags.title),
    ...text('TPE1', tags.artist),
    ...text('TALB', tags.album),
    ...text('TRCK', tags.track),
    ...text('TYER', tags.year),
    ...text('TCON', tags.genre),
    ...text('TPUB', tags.publisher),
    ...text('TSRC', tags.isrc),
    ...(tags.comment ? [frame('COMM', cat([1], latin1('eng'), utf16(''), [0, 0], utf16(tags.comment)))] : []),
    ...(tags.url ? [frame('WOAS', latin1(tags.url))] : []),
    ...(tags.cover ? [frame('APIC', cat([0], latin1(tags.cover.mime), [0, 3, 0], tags.cover.data))] : []), // 3 = front cover
  );
  const n = body.length; // tag size is syncsafe: 7 bits per byte
  return cat(latin1('ID3'), [3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f], body);
};
