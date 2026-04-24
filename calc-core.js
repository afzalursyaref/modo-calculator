/* =====================================================================
 * Modo Calculator — calc-core.js
 * Pure logic module (no DOM, no chrome APIs).
 *
 * Di-load oleh popup.html sebelum popup.js → expose ke globalThis.ModoCore.
 * Di Node (test runner) → dieksport via module.exports.
 *
 * Fungsi yang bergantung pada region user (thousands/decimal/multiSum)
 * menerima `settings` sebagai argumen eksplisit supaya mudah di-test
 * tanpa state global.
 * ===================================================================== */

(function (global) {
  'use strict';

  const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const OP_SYMBOLS = { '+': '+', '-': '−', '*': '×', '/': '÷' };

  function opSymbol(op) {
    return OP_SYMBOLS[op] || op;
  }

  function openParenCount(tokens) {
    let n = 0;
    for (const t of tokens) {
      if (t.type === 'paren') {
        if (t.value === '(') n++;
        else n--;
      }
    }
    return n;
  }

  function normalizeBuffer(buf) {
    if (buf.endsWith('.')) return buf.slice(0, -1);
    if (buf === '' || buf === '-') return '0';
    return buf;
  }

  function formatNumber(rawStr, settings) {
    if (rawStr === '' || rawStr == null) return '';
    if (rawStr === '-') return '-';
    const isNeg = rawStr.startsWith('-');
    const abs = isNeg ? rawStr.slice(1) : rawStr;
    const [intPart, decPart] = abs.split('.');
    const t = settings.thousands;
    const d = settings.decimal;
    let intFormatted = intPart;
    if (t) {
      intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, t);
    }
    let out = intFormatted;
    if (decPart !== undefined) out += d + decPart;
    return (isNeg ? '-' : '') + out;
  }

  function formatResult(num, settings) {
    if (!isFinite(num)) return 'Error';
    let s;
    if (Number.isInteger(num)) {
      s = String(num);
    } else {
      s = num.toPrecision(12);
      if (s.includes('e')) {
        return s.replace('.', settings.decimal);
      }
      s = parseFloat(s).toString();
    }
    return formatNumber(s, settings);
  }

  function numberToToken(n) {
    if (!isFinite(n)) return '0';
    if (Number.isInteger(n)) return String(n);
    // Bersihkan artifact float (0.1+0.2 -> 0.3) sebelum jadi token.
    let s = Math.abs(n) < 1e21 ? parseFloat(n.toPrecision(12)).toString() : n.toExponential();
    if (s.includes('.') && !s.includes('e')) {
      s = s.replace(/\.?0+$/, '');
    }
    return s;
  }

  function tokensToString(tokens, settings) {
    return tokens.map((t) => {
      if (t.type === 'num') return formatNumber(t.value, settings);
      if (t.type === 'op') return ' ' + opSymbol(t.value) + ' ';
      if (t.type === 'paren') return t.value;
      return '';
    }).join('').trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  }

  function evaluateTokens(tokens) {
    if (tokens.length === 0) return null;
    // Shunting-yard -> RPN
    const out = [];
    const ops = [];
    for (const tok of tokens) {
      if (tok.type === 'num') {
        out.push(tok);
      } else if (tok.type === 'op') {
        while (ops.length) {
          const top = ops[ops.length - 1];
          if (top.type === 'op' && PRECEDENCE[top.value] >= PRECEDENCE[tok.value]) {
            out.push(ops.pop());
          } else break;
        }
        ops.push(tok);
      } else if (tok.type === 'paren') {
        if (tok.value === '(') {
          ops.push(tok);
        } else {
          while (
            ops.length &&
            !(ops[ops.length - 1].type === 'paren' && ops[ops.length - 1].value === '(')
          ) {
            out.push(ops.pop());
          }
          if (!ops.length) return null; // unbalanced
          ops.pop();
        }
      }
    }
    while (ops.length) {
      const top = ops.pop();
      if (top.type === 'paren') return null; // unmatched '('
      out.push(top);
    }
    // Evaluate RPN
    const stack = [];
    for (const tok of out) {
      if (tok.type === 'num') {
        stack.push(parseFloat(tok.value));
      } else {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) return null;
        let r;
        switch (tok.value) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/': r = b === 0 ? Infinity : a / b; break;
          default: return null;
        }
        stack.push(r);
      }
    }
    return stack.length === 1 ? stack[0] : null;
  }

  function smartParseNumber(input, settings) {
    if (input == null) return null;
    let s = String(input).trim();
    if (!s) return null;

    let isPercent = false;
    if (s.endsWith('%')) {
      isPercent = true;
      s = s.slice(0, -1).trim();
    }

    let isNeg = false;
    if (/^\(.+\)$/.test(s)) { isNeg = true; s = s.slice(1, -1).trim(); }

    s = s.replace(/[\$€£¥₹₽₩฿]|Rp\.?|IDR|USD|EUR|GBP|JPY/gi, '');
    s = s.replace(/ /g, ' ').trim();

    if (s.startsWith('-')) { isNeg = !isNeg; s = s.slice(1).trim(); }
    if (s.startsWith('+')) s = s.slice(1).trim();

    if (!s) return null;

    const sciMatch = s.match(/^([\d.,\s]+)e([+-]?\d+)$/i);
    if (sciMatch) {
      const base = smartParseNumber(sciMatch[1], settings);
      if (base == null) return null;
      const exp = parseInt(sciMatch[2], 10);
      const v = base * Math.pow(10, exp);
      return (isNeg ? -v : v) / (isPercent ? 100 : 1);
    }

    if (!/^[\d.,\s]+$/.test(s)) return null;
    s = s.replace(/\s+/g, '');

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');

    let normalized;
    if (hasDot && hasComma) {
      const lastDot = s.lastIndexOf('.');
      const lastComma = s.lastIndexOf(',');
      const decimalChar = lastDot > lastComma ? '.' : ',';
      const thousandsChar = decimalChar === '.' ? ',' : '.';
      normalized = s.split(thousandsChar).join('').replace(decimalChar, '.');
    } else if (hasComma) {
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length !== 3) {
        normalized = parts.join('.');
      } else if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
        normalized = settings.decimal === ','
          ? parts.join('.')
          : parts.join('');
      } else {
        normalized = parts.join('');
      }
    } else if (hasDot) {
      const parts = s.split('.');
      if (parts.length === 2 && parts[1].length !== 3) {
        normalized = s;
      } else if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3) {
        normalized = settings.decimal === '.'
          ? s
          : parts.join('');
      } else {
        normalized = parts.join('');
      }
    } else {
      normalized = s;
    }

    const n = parseFloat(normalized);
    if (!isFinite(n)) return null;
    return (isNeg ? -n : n) / (isPercent ? 100 : 1);
  }

  function smartParsePastedText(text, settings) {
    if (!text) return { value: null, info: null };
    const cleaned = text.replace(/\r\n?/g, '\n').trim();
    if (!cleaned) return { value: null, info: null };

    const cells = cleaned.split(/[\t\n]/).map((c) => c.trim()).filter(Boolean);
    if (cells.length === 0) return { value: null, info: null };

    if (cells.length === 1) {
      const v = smartParseNumber(cells[0], settings);
      return { value: v, info: null };
    }

    const numbers = cells.map((c) => smartParseNumber(c, settings)).filter((n) => n != null);
    if (numbers.length === 0) return { value: null, info: null };

    if (settings.multiSum && numbers.length > 1) {
      const sum = numbers.reduce((a, b) => a + b, 0);
      return { value: sum, info: `Jumlah ${numbers.length} sel` };
    }
    return {
      value: numbers[0],
      info: numbers.length > 1 ? `Ambil sel pertama (${numbers.length} terdeteksi)` : null,
    };
  }

  const api = {
    PRECEDENCE,
    opSymbol,
    openParenCount,
    normalizeBuffer,
    formatNumber,
    formatResult,
    numberToToken,
    tokensToString,
    evaluateTokens,
    smartParseNumber,
    smartParsePastedText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.ModoCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
