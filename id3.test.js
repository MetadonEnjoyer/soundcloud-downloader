// Run: node id3.test.js
const assert = require('assert');
require('./id3.js');

const cover = { mime: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 1, 2, 3]) };
const tag = globalThis.scdlId3({ title: 'Песня ♪', artist: 'Артист', year: '2024', url: 'https://soundcloud.com/a/b', cover, album: '' });

assert.strictEqual(Buffer.from(tag.subarray(0, 3)).toString('latin1'), 'ID3');
assert.deepStrictEqual([...tag.subarray(3, 5)], [3, 0]);
const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9];
assert.strictEqual(size, tag.length - 10);

const frames = {};
for (let o = 10; o < tag.length;) {
  const id = Buffer.from(tag.subarray(o, o + 4)).toString('latin1');
  const len = new DataView(tag.buffer, tag.byteOffset + o + 4).getUint32(0);
  frames[id] = tag.subarray(o + 10, o + 10 + len);
  o += 10 + len;
}
assert.deepStrictEqual(Object.keys(frames), ['TIT2', 'TPE1', 'TYER', 'WOAS', 'APIC']); // empty album skipped
assert.strictEqual(Buffer.from(frames.TIT2.subarray(3)).toString('utf16le'), 'Песня ♪');
assert.strictEqual(Buffer.from(frames.WOAS).toString('latin1'), 'https://soundcloud.com/a/b');
assert.deepStrictEqual([...frames.APIC.subarray(-5)], [...cover.data]);
console.log('id3 ok');
