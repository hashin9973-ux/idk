'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpeechText, splitSpeechIntoChunks, MAX_SPEECH_CHUNKS } = require('../desktop/speech-text');

test('symbol normalization reads common punctuation, operators, arrows, keys, and icons aloud', () => {
  const text = normalizeSpeechText('* # @ & % + / \\\\ | _ ~ ^ = < > $ € © ™ → ✓ 🔒');
  for (const expected of [
    'asterisk', 'number sign', 'at sign', 'ampersand', 'percent', 'plus sign',
    'slash', 'backslash', 'vertical bar', 'underscore', 'tilde', 'caret',
    'equals sign', 'less than sign', 'greater than sign', 'dollar sign',
    'euro sign', 'copyright symbol', 'trademark symbol', 'right arrow',
    'check mark', 'lock icon'
  ]) assert.ok(text.includes(expected), 'missing spoken name: ' + expected);
});

test('unknown symbol code points are spoken explicitly rather than silently lost', () => {
  assert.match(normalizeSpeechText('Unknown: ⧿'), /Unicode symbol code point 29FF/);
  assert.match(normalizeSpeechText('Emoji: 🫠'), /Unicode symbol code point 1FAE0/);
});

test('speech chunks stay bounded and end at punctuation boundaries', () => {
  const source = Array.from({ length: 16 }, (_, i) =>
    'Sentence ' + (i + 1) + ' explains a visible element and its current state.').join(' ');
  const chunks = splitSpeechIntoChunks(source, 120);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= MAX_SPEECH_CHUNKS);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 121, 'chunk unexpectedly exceeds bound: ' + chunk.length);
    assert.match(chunk, /[,.!?;:，。！？；：、…—–]$/u);
  }
  assert.match(chunks[0], /Sentence 1/);
  assert.match(chunks.at(-1), /Sentence 16/);
});


test('short text is split at every punctuation mark instead of waiting for the full paragraph', () => {
  assert.deepEqual(
    splitSpeechIntoChunks('First sentence. Second, short phrase; third!', 120),
    ['First sentence.', 'Second,', 'short phrase;', 'third!']
  );
});

test('adjacent punctuation stays in a single speech chunk', () => {
  assert.deepEqual(
    splitSpeechIntoChunks('Alert?! Next... Done.', 120),
    ['Alert?!', 'Next...', 'Done.']
  );
});

test('long unpunctuated text gets a safe pause boundary without cutting words', () => {
  const source = 'visibleword '.repeat(40).trim();
  const chunks = splitSpeechIntoChunks(source, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /,$/);
    assert.doesNotMatch(chunk, /\bvisiblewor$/);
  }
});

test('empty and invalid chunk inputs behave predictably', () => {
  assert.deepEqual(splitSpeechIntoChunks('  '), []);
  assert.throws(() => splitSpeechIntoChunks('hello', 12), /between 48 and 400/);
});
