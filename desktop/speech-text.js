'use strict';

const SYMBOL_PRONUNCIATION = Object.freeze({
  '*': 'asterisk', '#': 'number sign', '@': 'at sign', '&': 'ampersand',
  '%': 'percent', '+': 'plus sign', '/': 'slash', '\\': 'backslash',
  '|': 'vertical bar', '_': 'underscore', '~': 'tilde', '^': 'caret',
  '=': 'equals sign', '<': 'less than sign', '>': 'greater than sign',
  '$': 'dollar sign', '£': 'pound sign', '€': 'euro sign', '¥': 'yen sign',
  '¢': 'cent sign', '§': 'section sign', '¶': 'paragraph sign',
  '©': 'copyright symbol', '®': 'registered trademark symbol', '™': 'trademark symbol',
  '°': 'degrees', '±': 'plus or minus', '×': 'times', '÷': 'divided by',
  '√': 'square root', '∞': 'infinity', '≠': 'not equal to', '≈': 'approximately equal to',
  '≤': 'less than or equal to', '≥': 'greater than or equal to',
  '←': 'left arrow', '→': 'right arrow', '↑': 'up arrow', '↓': 'down arrow',
  '↔': 'left right arrow', '↕': 'up down arrow', '↗': 'up right arrow', '↘': 'down right arrow',
  '✓': 'check mark', '✔': 'check mark', '✗': 'cross mark', '✘': 'cross mark',
  '•': 'bullet point', '◦': 'open bullet', '▪': 'square bullet',
  '★': 'star', '☆': 'outline star', '♥': 'heart', '♡': 'outline heart',
  '⇒': 'implies', '⇐': 'implied by',
  '⌘': 'command key', '⌥': 'option key', '⌃': 'control key', '⇧': 'shift key',
  '⏎': 'return key', '⌫': 'delete key', '␣': 'space bar',
  '🔒': 'lock icon', '🔓': 'unlocked lock icon', '⚠': 'warning symbol',
  '⚙': 'gear icon', '⏻': 'power symbol', '✅': 'check mark', '❌': 'cross mark',
  '🚫': 'prohibited symbol', 'ℹ': 'information symbol', '💡': 'light bulb icon',
  '📁': 'folder icon', '📂': 'open folder icon', '🔍': 'search icon',
  '🔔': 'notification bell', '▶': 'play icon', '⏸': 'pause icon', '⏹': 'stop icon',
  '«': 'left double angle quote', '»': 'right double angle quote',
  '‹': 'left single angle quote', '›': 'right single angle quote',
  '（': 'open parenthesis', '）': 'close parenthesis',
  '［': 'open square bracket', '］': 'close square bracket',
  '｛': 'open curly brace', '｝': 'close curly brace'
});

const SPEECH_PUNCTUATION = /[,.!?;:，。！？；：、…—–\n]/u;
const ANY_TRAILING_PUNCTUATION = /[,.!?;:，。！？；：、…—–\n]$/u;
const MAX_SPEECH_CHUNKS = 32;

function normalizeSpeechText(value) {
  const input = String(value == null ? '' : value).normalize('NFC').replace(/\r\n?/gu, '\n');
  let output = '';
  for (const character of input) {
    const known = SYMBOL_PRONUNCIATION[character];
    if (known) {
      output += ' ' + known + ' ';
      continue;
    }
    if (/\p{S}/u.test(character)) {
      const codePoint = character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      output += ' Unicode symbol code point ' + codePoint + ' ';
      continue;
    }
    if (/\p{Cf}/u.test(character)) continue;
    output += character;
  }
  return output
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n+/gu, '. ')
    .replace(/ +([,.!?;:])/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

function splitSpeechIntoChunks(value, maxChars = 56) {
  if (typeof value !== 'string' || !value.trim()) return [];
  if (!Number.isInteger(maxChars) || maxChars < 48 || maxChars > 400) {
    throw new RangeError('maxChars must be an integer between 48 and 400.');
  }
  let remaining = value.trim().replace(/\s+/gu, ' ');
  const chunks = [];
  while (remaining.length) {
    let cut = -1;
    const scanLimit = Math.min(remaining.length, maxChars);
    // Stop at the first punctuation mark, even for short input. This means the
    // next Piper call can be prefetched while the current phrase is spoken.
    for (let i = 0; i < scanLimit; i += 1) {
      if (SPEECH_PUNCTUATION.test(remaining[i])) {
        cut = i + 1;
        while (cut < remaining.length && SPEECH_PUNCTUATION.test(remaining[cut])) cut += 1;
        break;
      }
    }
    if (cut < 0 && remaining.length <= maxChars) cut = remaining.length;
    if (cut < 0) {
      cut = remaining.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars * 0.45)) cut = maxChars;
    }
    let chunk = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trimStart();
    if (!chunk) {
      // A punctuation mark can be first only if malformed/leading whitespace
      // remains; discard that whitespace without producing an empty WAV.
      remaining = remaining.slice(1).trimStart();
      continue;
    }
    if (!ANY_TRAILING_PUNCTUATION.test(chunk)) chunk += ',';
    chunks.push(chunk);
    if (chunks.length > MAX_SPEECH_CHUNKS) {
      throw new RangeError('Speech expands to more than ' + MAX_SPEECH_CHUNKS + ' chunks; shorten the text or split the request.');
    }
  }
  if (chunks.length > MAX_SPEECH_CHUNKS) {
    throw new RangeError('Speech expands to more than ' + MAX_SPEECH_CHUNKS + ' chunks; shorten the text or split the request.');
  }
  return chunks;
}

module.exports = { SYMBOL_PRONUNCIATION, MAX_SPEECH_CHUNKS, normalizeSpeechText, splitSpeechIntoChunks };
