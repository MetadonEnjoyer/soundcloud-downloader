// Run: node shared.test.js
const assert = require('assert');
require('./shared.js');
const safe = globalThis.scdlSafePart;

assert.strictEqual(safe('a/b:c.mp3'), 'a_b_c.mp3');
assert.strictEqual(safe('Name. '), 'Name');
const long = safe(`${'x'.repeat(300)}.mp3`);
assert.ok(long.endsWith('.mp3') && long.length <= 150, 'long names keep .mp3 and stay within the limit');
assert.strictEqual(safe('CON.mp3'), '_CON.mp3');
assert.strictEqual(safe('nul'), '_nul');
assert.strictEqual(safe('Console - Song.mp3'), 'Console - Song.mp3'); // only exact device names are reserved
assert.strictEqual(safe('Нравится'), 'Нравится');
console.log('shared ok');
