/* Unit tests for calc-core.js — run via: node --test tests/ */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../calc-core.js');
const {
  formatNumber,
  formatResult,
  numberToToken,
  normalizeBuffer,
  evaluateTokens,
  smartParseNumber,
  smartParsePastedText,
  tokensToString,
  openParenCount,
  opSymbol,
} = core;

const ID = { thousands: '.', decimal: ',', multiSum: true };
const US = { thousands: ',', decimal: '.', multiSum: true };
const FR = { thousands: ' ', decimal: ',', multiSum: true };
const BARE = { thousands: '', decimal: '.', multiSum: true };

const num = (v) => ({ type: 'num', value: String(v) });
const op = (v) => ({ type: 'op', value: v });
const par = (v) => ({ type: 'paren', value: v });

// =============================================================
// formatNumber
// =============================================================
test('formatNumber: ID region groups thousands with dot', () => {
  assert.equal(formatNumber('1234567', ID), '1.234.567');
  assert.equal(formatNumber('1234.56', ID), '1.234,56');
});

test('formatNumber: US region groups thousands with comma', () => {
  assert.equal(formatNumber('1234567', US), '1,234,567');
  assert.equal(formatNumber('1234.56', US), '1,234.56');
});

test('formatNumber: no thousands separator when empty', () => {
  assert.equal(formatNumber('1234567', BARE), '1234567');
});

test('formatNumber: handles negative', () => {
  assert.equal(formatNumber('-1234.5', ID), '-1.234,5');
});

test('formatNumber: edge cases (empty, null, bare minus)', () => {
  assert.equal(formatNumber('', ID), '');
  assert.equal(formatNumber(null, ID), '');
  assert.equal(formatNumber('-', ID), '-');
});

// =============================================================
// formatResult
// =============================================================
test('formatResult: trims float artifact 0.1+0.2', () => {
  assert.equal(formatResult(0.1 + 0.2, US), '0.3');
  assert.equal(formatResult(0.1 + 0.2, ID), '0,3');
});

test('formatResult: integer passthrough', () => {
  assert.equal(formatResult(42, US), '42');
  assert.equal(formatResult(-1000, ID), '-1.000');
});

test('formatResult: Error for non-finite', () => {
  assert.equal(formatResult(Infinity, US), 'Error');
  assert.equal(formatResult(-Infinity, US), 'Error');
  assert.equal(formatResult(NaN, US), 'Error');
});

test('formatResult: scientific notation for huge numbers uses region decimal', () => {
  const r = formatResult(1.5e25, ID);
  assert.ok(r.includes('e'), `expected scientific, got ${r}`);
  assert.ok(!r.includes('.'), 'ID decimal is comma, dot should not appear');
});

// =============================================================
// numberToToken — precision invariant
// =============================================================
test('numberToToken: integer passthrough', () => {
  assert.equal(numberToToken(123), '123');
  assert.equal(numberToToken(-42), '-42');
  assert.equal(numberToToken(0), '0');
});

test('numberToToken: cleans float artifact (fix from review #5)', () => {
  assert.equal(numberToToken(0.1 + 0.2), '0.3');
  assert.equal(numberToToken(3 * 0.1), '0.3');
});

test('numberToToken: non-finite becomes "0"', () => {
  assert.equal(numberToToken(Infinity), '0');
  assert.equal(numberToToken(NaN), '0');
});

test('numberToToken: very small decimals preserve precision', () => {
  assert.equal(numberToToken(0.5), '0.5');
  assert.equal(numberToToken(0.125), '0.125');
});

// =============================================================
// normalizeBuffer
// =============================================================
test('normalizeBuffer: trailing dot stripped', () => {
  assert.equal(normalizeBuffer('5.'), '5');
});

test('normalizeBuffer: empty and bare minus become "0"', () => {
  assert.equal(normalizeBuffer(''), '0');
  assert.equal(normalizeBuffer('-'), '0');
});

test('normalizeBuffer: normal input passthrough', () => {
  assert.equal(normalizeBuffer('42.5'), '42.5');
  assert.equal(normalizeBuffer('-12'), '-12');
});

// =============================================================
// openParenCount / opSymbol
// =============================================================
test('openParenCount: tracks nesting balance', () => {
  assert.equal(openParenCount([par('('), num(5), par('(')]), 2);
  assert.equal(openParenCount([par('('), num(5), par(')')]), 0);
  assert.equal(openParenCount([par(')'), par(')')]), -2);
});

test('opSymbol: display glyphs for operators', () => {
  assert.equal(opSymbol('+'), '+');
  assert.equal(opSymbol('-'), '−'); // U+2212 minus
  assert.equal(opSymbol('*'), '×');
  assert.equal(opSymbol('/'), '÷');
  assert.equal(opSymbol('?'), '?'); // fallback
});

// =============================================================
// evaluateTokens
// =============================================================
test('evaluateTokens: basic four operations', () => {
  assert.equal(evaluateTokens([num(5), op('+'), num(3)]), 8);
  assert.equal(evaluateTokens([num(10), op('-'), num(4)]), 6);
  assert.equal(evaluateTokens([num(6), op('*'), num(7)]), 42);
  assert.equal(evaluateTokens([num(20), op('/'), num(4)]), 5);
});

test('evaluateTokens: operator precedence (× before +)', () => {
  assert.equal(evaluateTokens([num(2), op('+'), num(3), op('*'), num(4)]), 14);
  assert.equal(evaluateTokens([num(10), op('-'), num(6), op('/'), num(2)]), 7);
});

test('evaluateTokens: left-associativity for same precedence', () => {
  assert.equal(evaluateTokens([num(10), op('-'), num(3), op('-'), num(2)]), 5);
  assert.equal(evaluateTokens([num(20), op('/'), num(4), op('/'), num(5)]), 1);
});

test('evaluateTokens: parentheses override precedence', () => {
  const tokens = [par('('), num(2), op('+'), num(3), par(')'), op('*'), num(4)];
  assert.equal(evaluateTokens(tokens), 20);
});

test('evaluateTokens: nested parens', () => {
  // (2 * (3 + 4)) - 1 = 13
  const tokens = [
    par('('), num(2), op('*'), par('('), num(3), op('+'), num(4), par(')'), par(')'),
    op('-'), num(1),
  ];
  assert.equal(evaluateTokens(tokens), 13);
});

test('evaluateTokens: division by zero returns Infinity', () => {
  assert.equal(evaluateTokens([num(5), op('/'), num(0)]), Infinity);
});

test('evaluateTokens: empty input returns null', () => {
  assert.equal(evaluateTokens([]), null);
});

test('evaluateTokens: unbalanced parens return null', () => {
  assert.equal(evaluateTokens([par('('), num(5), op('+'), num(3)]), null);
  assert.equal(evaluateTokens([num(5), par(')')]), null);
});

test('evaluateTokens: decimal numbers', () => {
  assert.equal(evaluateTokens([num('1.5'), op('*'), num(2)]), 3);
});

// =============================================================
// smartParseNumber — single-value parsing
// =============================================================
test('smartParseNumber: plain integer', () => {
  assert.equal(smartParseNumber('1234', ID), 1234);
  assert.equal(smartParseNumber('0', ID), 0);
});

test('smartParseNumber: US format "1,234.56"', () => {
  assert.equal(smartParseNumber('1,234.56', ID), 1234.56);
  assert.equal(smartParseNumber('1,234,567.89', ID), 1234567.89);
});

test('smartParseNumber: ID/EU format "1.234,56"', () => {
  assert.equal(smartParseNumber('1.234,56', ID), 1234.56);
  assert.equal(smartParseNumber('1.234.567,89', ID), 1234567.89);
});

test('smartParseNumber: French with space thousands', () => {
  assert.equal(smartParseNumber('1 234,56', ID), 1234.56);
  assert.equal(smartParseNumber('1 234 567', ID), 1234567);
});

test('smartParseNumber: non-breaking space (Excel/web copy)', () => {
  // U+00A0 is what Excel and many web pages insert as thousands separator
  assert.equal(smartParseNumber('1 234,56', ID), 1234.56);
  assert.equal(smartParseNumber('1 234 567', ID), 1234567);
});

test('smartParseNumber: currency symbols stripped', () => {
  assert.equal(smartParseNumber('Rp 1.000', ID), 1000);
  assert.equal(smartParseNumber('Rp. 1.000', ID), 1000);
  assert.equal(smartParseNumber('$1,234.56', ID), 1234.56);
  assert.equal(smartParseNumber('€1.234,56', ID), 1234.56);
  assert.equal(smartParseNumber('IDR 50.000', ID), 50000);
});

test('smartParseNumber: percent divides by 100', () => {
  assert.equal(smartParseNumber('50%', ID), 0.5);
  assert.equal(smartParseNumber('12.5%', US), 0.125);
  assert.equal(smartParseNumber('100%', ID), 1);
});

test('smartParseNumber: accounting negative "(123)"', () => {
  assert.equal(smartParseNumber('(1,234.56)', ID), -1234.56);
  assert.equal(smartParseNumber('(500)', ID), -500);
});

test('smartParseNumber: scientific notation', () => {
  assert.equal(smartParseNumber('1.5e3', US), 1500);
  assert.equal(smartParseNumber('1,5e3', ID), 1500);
  assert.equal(smartParseNumber('2e-3', US), 0.002);
});

test('smartParseNumber: explicit sign', () => {
  assert.equal(smartParseNumber('-1234', ID), -1234);
  assert.equal(smartParseNumber('+1234', ID), 1234);
});

test('smartParseNumber: ambiguous "1,234" respects user decimal setting', () => {
  // ID: comma is decimal → "1,234" = 1.234
  assert.equal(smartParseNumber('1,234', ID), 1.234);
  // US: comma is thousands → "1,234" = 1234
  assert.equal(smartParseNumber('1,234', US), 1234);
});

test('smartParseNumber: ambiguous "1.234" respects user decimal setting', () => {
  // ID: dot is thousands → "1.234" = 1234
  assert.equal(smartParseNumber('1.234', ID), 1234);
  // US: dot is decimal → "1.234" = 1.234
  assert.equal(smartParseNumber('1.234', US), 1.234);
});

test('smartParseNumber: unambiguous 3-digit decimal ("1,12" stays decimal)', () => {
  assert.equal(smartParseNumber('1,12', ID), 1.12);
  assert.equal(smartParseNumber('1,5', ID), 1.5);
});

test('smartParseNumber: multi-group thousands ("1,234,567" always thousands)', () => {
  assert.equal(smartParseNumber('1,234,567', ID), 1234567);
  assert.equal(smartParseNumber('1.234.567', US), 1234567);
});

test('smartParseNumber: invalid inputs return null', () => {
  assert.equal(smartParseNumber('abc', ID), null);
  assert.equal(smartParseNumber('', ID), null);
  assert.equal(smartParseNumber('   ', ID), null);
  assert.equal(smartParseNumber(null, ID), null);
  assert.equal(smartParseNumber(undefined, ID), null);
  assert.equal(smartParseNumber('--5', ID), null);
});

test('smartParseNumber: negative scientific with sign', () => {
  assert.equal(smartParseNumber('-1.5e3', US), -1500);
});

test('smartParseNumber: accounting + currency combined', () => {
  assert.equal(smartParseNumber('($1,234.56)', ID), -1234.56);
});

// =============================================================
// smartParsePastedText — Excel multi-cell behavior
// =============================================================
test('smartParsePastedText: single cell returns null info', () => {
  const r = smartParsePastedText('1.234,56', ID);
  assert.equal(r.value, 1234.56);
  assert.equal(r.info, null);
});

test('smartParsePastedText: tab-separated row summed when multiSum on', () => {
  const r = smartParsePastedText('100\t200\t300', ID);
  assert.equal(r.value, 600);
  assert.match(r.info, /3 sel/);
});

test('smartParsePastedText: newline-separated column summed', () => {
  const r = smartParsePastedText('10\n20\n30', ID);
  assert.equal(r.value, 60);
  assert.match(r.info, /3 sel/);
});

test('smartParsePastedText: CRLF normalized', () => {
  const r = smartParsePastedText('10\r\n20\r\n30', ID);
  assert.equal(r.value, 60);
});

test('smartParsePastedText: mixed grid (tabs + newlines)', () => {
  // 2x2 excel selection
  const r = smartParsePastedText('10\t20\n30\t40', ID);
  assert.equal(r.value, 100);
  assert.match(r.info, /4 sel/);
});

test('smartParsePastedText: cells with currency + regional format', () => {
  const r = smartParsePastedText('Rp 1.000\tRp 2.500', ID);
  assert.equal(r.value, 3500);
});

test('smartParsePastedText: non-numeric cells skipped', () => {
  const r = smartParsePastedText('100\tabc\t200', ID);
  assert.equal(r.value, 300);
  assert.match(r.info, /2 sel/);
});

test('smartParsePastedText: multiSum off picks first valid cell', () => {
  const r = smartParsePastedText('100\t200', { ...ID, multiSum: false });
  assert.equal(r.value, 100);
  assert.match(r.info, /Ambil sel pertama/);
});

test('smartParsePastedText: multiSum off with single number has null info', () => {
  const r = smartParsePastedText('100', { ...ID, multiSum: false });
  assert.equal(r.value, 100);
  assert.equal(r.info, null);
});

test('smartParsePastedText: empty or whitespace-only', () => {
  assert.deepEqual(smartParsePastedText('', ID), { value: null, info: null });
  assert.deepEqual(smartParsePastedText('   ', ID), { value: null, info: null });
  assert.deepEqual(smartParsePastedText('\t\n\t', ID), { value: null, info: null });
});

test('smartParsePastedText: all cells invalid returns null', () => {
  assert.deepEqual(smartParsePastedText('abc\tdef', ID), { value: null, info: null });
});

test('smartParsePastedText: negative numbers in sum', () => {
  const r = smartParsePastedText('100\t-50\t-30', ID);
  assert.equal(r.value, 20);
});

// =============================================================
// tokensToString
// =============================================================
test('tokensToString: formats expression with region separators', () => {
  const tokens = [num('1234'), op('+'), num('5.5')];
  assert.equal(tokensToString(tokens, ID), '1.234 + 5,5');
  assert.equal(tokensToString(tokens, US), '1,234 + 5.5');
});

test('tokensToString: parens are tight (no inner spaces)', () => {
  const tokens = [par('('), num(5), op('+'), num(3), par(')')];
  assert.equal(tokensToString(tokens, US), '(5 + 3)');
});

test('tokensToString: empty tokens returns empty string', () => {
  assert.equal(tokensToString([], ID), '');
});
