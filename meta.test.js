// Run: node meta.test.js
const assert = require('assert');
require('./meta.js');
const m = globalThis.scdlTrackMeta;

assert.deepStrictEqual(m('lil peep - suck my blood (prod lederrick)', 'lederrick'), { artist: 'lil peep', title: 'suck my blood (prod lederrick)' });
assert.deepStrictEqual(m('hellboy (prod smokeasac x yung cortex)', 'Lil Peep'), { artist: 'Lil Peep', title: 'hellboy (prod smokeasac x yung cortex)' });
assert.deepStrictEqual(m('w/ lil peep - black fingernails (40 missed calls)', 'SOWHATIMDEAD'), { artist: 'SOWHATIMDEAD, lil peep', title: 'black fingernails (40 missed calls)' });
assert.deepStrictEqual(m('lo-fi beats', 'Up'), { artist: 'Up', title: 'lo-fi beats' }); // unspaced dash is not a separator
assert.deepStrictEqual(m('Юпи – Облака', 'ГЛАВНАЯ'), { artist: 'Юпи', title: 'Облака' });
console.log('meta ok');
