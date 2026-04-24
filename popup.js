/* =====================================================================
 * Modo Calculator — popup.js
 * Vanilla JS. Berisi:
 *   - Expression parser (shunting-yard, no eval)
 *   - Region formatter & smart paste detector
 *   - Excel paste handler (multi-cell sum)
 *   - History (chrome.storage.local, max 100)
 *   - Settings (chrome.storage.local)
 *   - Picture-in-Picture window untuk always-on-top
 * ===================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // CORE — pure logic dari calc-core.js (dimuat lewat <script> di HTML).
  // Module ini di-test via node:test di tests/. State-dependent wrappers
  // di bawah meneruskan state.settings supaya call site tidak berubah.
  // ---------------------------------------------------------------------
  const Core = globalThis.ModoCore;
  const {
    opSymbol,
    openParenCount,
    normalizeBuffer,
    numberToToken,
    evaluateTokens,
  } = Core;

  // ---------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------
  const state = {
    /** Token list yg menyusun expression. Setiap token: {type:'num'|'op'|'paren', value:string} */
    tokens: [],
    /** Buffer angka yg sedang diketik (string raw, "." sbg desimal internal). */
    buffer: '',
    /** Hasil terakhir setelah '='. */
    lastResult: null,
    /** Flag: setelah '=', input angka baru me-reset expression. */
    justEvaluated: false,
    /** Settings global. */
    settings: {
      thousands: '.',
      decimal: ',',
      theme: 'auto',
      smartPaste: true,
      multiSum: true,
    },
    /** History entries. */
    history: [],
  };

  const MAX_HISTORY = 100;
  const STORAGE_SETTINGS_KEY = 'modo_settings_v1';
  const STORAGE_HISTORY_KEY = 'modo_history_v1';
  const STORAGE_STATE_KEY = 'modo_state_v1';

  // ---------------------------------------------------------------------
  // DOM REFS
  // ---------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const exprEl = $('expr');
  const previewEl = $('preview');
  const resultEl = $('result');
  const keypadEl = $('keypad');
  const toastEl = $('toast');
  const panelHistory = $('panel-history');
  const panelSettings = $('panel-settings');
  const historyListEl = $('history-list');
  const historyEmptyEl = $('history-empty');

  // ---------------------------------------------------------------------
  // SAFE STORAGE WRAPPER (works as web page too, falls back to localStorage)
  // ---------------------------------------------------------------------
  const storage = {
    get(key) {
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.get(key, (res) => resolve(res[key]));
        } else {
          try {
            const raw = localStorage.getItem(key);
            resolve(raw ? JSON.parse(raw) : undefined);
          } catch { resolve(undefined); }
        }
      });
    },
    set(key, value) {
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ [key]: value }, () => resolve());
        } else {
          try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
          resolve();
        }
      });
    },
  };

  // ---------------------------------------------------------------------
  // FORMATTER WRAPPERS — inject state.settings ke core.
  // ---------------------------------------------------------------------
  const formatNumber = (rawStr) => Core.formatNumber(rawStr, state.settings);
  const formatResult = (num) => Core.formatResult(num, state.settings);
  const tokensToString = (tokens) => Core.tokensToString(tokens, state.settings);

  /** Build display string dari tokens + buffer. */
  function buildExpressionDisplay() {
    const parts = state.tokens.map((tok) => {
      if (tok.type === 'num') return formatNumber(tok.value);
      if (tok.type === 'op') return ' ' + opSymbol(tok.value) + ' ';
      if (tok.type === 'paren') return tok.value;
      return tok.value;
    });
    let s = parts.join('');
    if (state.buffer !== '') s += formatNumber(state.buffer);
    return s.trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  }

  // ---------------------------------------------------------------------
  // SMART PASTE & EVALUATOR WRAPPERS — delegasi ke calc-core.
  // ---------------------------------------------------------------------
  const smartParseNumber = (input) => Core.smartParseNumber(input, state.settings);
  const smartParsePastedText = (text) => Core.smartParsePastedText(text, state.settings);


  // ---------------------------------------------------------------------
  // INPUT ACTIONS
  // ---------------------------------------------------------------------
  function inputDigit(d) {
    if (state.justEvaluated) {
      resetAll();
    }
    // Implicit multiplication: angka langsung setelah ')'  -> sisipkan *
    if (state.buffer === '') {
      const last = state.tokens[state.tokens.length - 1];
      if (last && last.type === 'paren' && last.value === ')') {
        state.tokens.push({ type: 'op', value: '*' });
      }
    }
    // Cegah leading zeros: '0' lalu '5' -> '5', tapi '0' lalu '.' tetap '0.'
    if (state.buffer === '0' && d !== '.') {
      state.buffer = d;
    } else {
      state.buffer += d;
    }
    render();
  }

  function inputOpenParen() {
    if (state.justEvaluated) {
      resetAll();
    }
    if (state.buffer !== '') {
      // 5( -> 5 * (
      state.tokens.push({ type: 'num', value: normalizeBuffer(state.buffer) });
      state.tokens.push({ type: 'op', value: '*' });
      state.buffer = '';
    } else {
      const last = state.tokens[state.tokens.length - 1];
      // ...)( -> ...) * (
      if (last && last.type === 'paren' && last.value === ')') {
        state.tokens.push({ type: 'op', value: '*' });
      }
    }
    state.tokens.push({ type: 'paren', value: '(' });
    render();
  }

  function inputCloseParen() {
    if (state.justEvaluated) return;
    // Harus ada '(' yg belum tertutup
    const balance = openParenCount(state.tokens);
    if (balance <= 0) return;
    if (state.buffer !== '') {
      state.tokens.push({ type: 'num', value: normalizeBuffer(state.buffer) });
      state.buffer = '';
    } else {
      const last = state.tokens[state.tokens.length - 1];
      if (!last) return;
      // Tidak boleh tutup setelah operator atau langsung setelah '('
      if (last.type === 'op') return;
      if (last.type === 'paren' && last.value === '(') return;
    }
    state.tokens.push({ type: 'paren', value: ')' });
    render();
  }

  function inputDot() {
    if (state.justEvaluated) resetAll();
    if (state.buffer === '') state.buffer = '0';
    if (!state.buffer.includes('.')) state.buffer += '.';
    render();
  }

  function inputOperator(op) {
    if (state.justEvaluated) {
      // Lanjutkan dari hasil
      state.tokens = [{ type: 'num', value: numberToToken(state.lastResult) }];
      state.buffer = '';
      state.justEvaluated = false;
    }
    if (state.buffer !== '') {
      state.tokens.push({ type: 'num', value: normalizeBuffer(state.buffer) });
      state.buffer = '';
    } else if (state.tokens.length === 0) {
      // Mulai dengan operator: gunakan hasil terakhir atau 0
      const seed = state.lastResult != null ? numberToToken(state.lastResult) : '0';
      state.tokens.push({ type: 'num', value: seed });
    }
    // Setelah '(' atau operator tanpa buffer: replace operator / append ditangani di bawah
    // Replace operator terakhir bila double-press
    const last = state.tokens[state.tokens.length - 1];
    if (last && last.type === 'op') {
      state.tokens[state.tokens.length - 1] = { type: 'op', value: op };
    } else if (last) {
      state.tokens.push({ type: 'op', value: op });
    }
    render();
  }

  function inputEquals() {
    if (state.tokens.length === 0 && state.buffer === '') return;
    let tokens = state.tokens.slice();
    if (state.buffer !== '') {
      tokens.push({ type: 'num', value: normalizeBuffer(state.buffer) });
    } else if (tokens[tokens.length - 1] && tokens[tokens.length - 1].type === 'op') {
      // hapus trailing operator
      tokens = tokens.slice(0, -1);
    }
    if (tokens.length === 0) return;

    // Auto-close paren yg belum ditutup
    let unclosed = openParenCount(tokens);
    while (unclosed > 0) {
      tokens.push({ type: 'paren', value: ')' });
      unclosed--;
    }

    const result = evaluateTokens(tokens);
    if (result == null || !isFinite(result)) {
      flashResult();
      resultEl.textContent = 'Error';
      return;
    }

    const exprStr = tokensToString(tokens);
    saveHistory(exprStr, result);

    state.tokens = [];
    state.buffer = '';
    state.lastResult = result;
    state.justEvaluated = true;
    render(true);
  }

  function inputClear() {
    resetAll();
    state.lastResult = null;
    render();
  }

  function inputSign() {
    if (state.buffer !== '') {
      state.buffer = state.buffer.startsWith('-')
        ? state.buffer.slice(1)
        : '-' + state.buffer;
    } else if (state.justEvaluated && state.lastResult != null) {
      state.lastResult = -state.lastResult;
      resultEl.textContent = formatResult(state.lastResult);
      return;
    }
    render();
  }

  function inputPercent() {
    // Konversi buffer atau hasil ke /100
    if (state.buffer !== '') {
      const n = parseFloat(normalizeBuffer(state.buffer)) / 100;
      state.buffer = numberToToken(n);
    } else if (state.justEvaluated && state.lastResult != null) {
      state.lastResult = state.lastResult / 100;
      resultEl.textContent = formatResult(state.lastResult);
      return;
    }
    render();
  }

  function inputBackspace() {
    if (state.justEvaluated) return;
    if (state.buffer !== '') {
      state.buffer = state.buffer.slice(0, -1);
      if (state.buffer === '-') state.buffer = '';
    } else if (state.tokens.length > 0) {
      const last = state.tokens.pop();
      if (last.type === 'num') {
        state.buffer = last.value;
      }
    }
    render();
  }

  function resetAll() {
    state.tokens = [];
    state.buffer = '';
    state.justEvaluated = false;
  }

  // ---------------------------------------------------------------------
  // PASTE HANDLER
  // ---------------------------------------------------------------------
  function handlePaste(e) {
    if (!state.settings.smartPaste) return;
    e.preventDefault();
    const clip = e.clipboardData || window.clipboardData;
    const text = clip ? clip.getData('text/plain') : '';
    const { value, info } = smartParsePastedText(text);
    if (value == null) {
      showToast('Tidak ada angka valid di clipboard');
      return;
    }
    if (state.justEvaluated) resetAll();
    state.buffer = numberToToken(value);
    if (info) showToast(info + ' = ' + formatResult(value));
    else showToast('Paste: ' + formatResult(value));
    render();
  }

  // ---------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------
  function render(animateResult) {
    exprEl.textContent = buildExpressionDisplay();
    let displayValue;
    if (state.justEvaluated) {
      displayValue = state.lastResult != null ? formatResult(state.lastResult) : '0';
    } else if (state.buffer !== '') {
      displayValue = formatNumber(state.buffer);
    } else if (state.tokens.length > 0) {
      // Tampilkan angka terakhir sbg display utama
      const last = state.tokens[state.tokens.length - 1];
      if (last.type === 'num') displayValue = formatNumber(last.value);
      else {
        const prev = state.tokens[state.tokens.length - 2];
        displayValue = prev && prev.type === 'num' ? formatNumber(prev.value) : '0';
      }
    } else {
      displayValue = '0';
    }
    resultEl.textContent = displayValue;
    fitResult(displayValue);
    if (animateResult) flashResult();
    updateLivePreview(displayValue);
    scheduleSaveState();
  }

  /**
   * Live preview hasil ekspresi sementara, ditampilkan dim dengan prefix "= ".
   * Hanya muncul ketika ekspresi sudah punya operator/paren — supaya tidak
   * duplikat dengan angka di display utama.
   */
  function updateLivePreview(currentDisplay) {
    if (state.justEvaluated) {
      previewEl.classList.remove('show');
      previewEl.textContent = '';
      return;
    }
    let toks = state.tokens.slice();
    if (state.buffer !== '') {
      toks.push({ type: 'num', value: normalizeBuffer(state.buffer) });
    } else if (toks.length && toks[toks.length - 1].type === 'op') {
      toks = toks.slice(0, -1);
    }
    // Auto-close paren utk preview
    let bal = openParenCount(toks);
    while (bal-- > 0) toks.push({ type: 'paren', value: ')' });

    // Butuh minimal 1 operator agar preview berarti
    const hasOp = toks.some((t) => t.type === 'op');
    if (!hasOp || toks.length < 2) {
      previewEl.classList.remove('show');
      previewEl.textContent = '';
      return;
    }

    const live = evaluateTokens(toks);
    if (live == null || !isFinite(live)) {
      previewEl.classList.remove('show');
      previewEl.textContent = '';
      return;
    }
    const formatted = formatResult(live);
    // Jangan duplikat dgn angka di display utama
    if (formatted === currentDisplay) {
      previewEl.classList.remove('show');
      previewEl.textContent = '';
      return;
    }
    previewEl.textContent = formatted;
    previewEl.classList.add('show');
  }

  // ---------------------------------------------------------------------
  // STATE PERSISTENCE — simpan posisi kalkulator agar tidak hilang
  // saat popup ditutup
  // ---------------------------------------------------------------------
  let saveStateTimer = null;
  function scheduleSaveState() {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      storage.set(STORAGE_STATE_KEY, {
        tokens: state.tokens,
        buffer: state.buffer,
        lastResult: state.lastResult,
        justEvaluated: state.justEvaluated,
      });
    }, 120);
  }

  async function loadState() {
    const saved = await storage.get(STORAGE_STATE_KEY);
    if (!saved) return;
    if (Array.isArray(saved.tokens)) state.tokens = saved.tokens;
    if (typeof saved.buffer === 'string') state.buffer = saved.buffer;
    if (typeof saved.lastResult === 'number' || saved.lastResult === null) {
      state.lastResult = saved.lastResult;
    }
    state.justEvaluated = !!saved.justEvaluated;
  }

  function fitResult(text) {
    resultEl.classList.remove('shrink-1', 'shrink-2', 'shrink-3');
    const len = text.length;
    if (len > 22) resultEl.classList.add('shrink-3');
    else if (len > 16) resultEl.classList.add('shrink-2');
    else if (len > 11) resultEl.classList.add('shrink-1');
  }

  function flashResult() {
    resultEl.classList.remove('flash');
    void resultEl.offsetWidth;
    resultEl.classList.add('flash');
  }

  // ---------------------------------------------------------------------
  // TOAST
  // ---------------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // ---------------------------------------------------------------------
  // HISTORY
  // ---------------------------------------------------------------------
  async function loadHistory() {
    state.history = (await storage.get(STORAGE_HISTORY_KEY)) || [];
    renderHistory();
  }

  async function saveHistory(exprStr, result) {
    state.history.unshift({
      expr: exprStr,
      result: result,
      ts: Date.now(),
    });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    await storage.set(STORAGE_HISTORY_KEY, state.history);
    renderHistory();
  }

  function renderHistory() {
    historyListEl.innerHTML = '';
    if (state.history.length === 0) {
      historyEmptyEl.style.display = '';
      return;
    }
    historyEmptyEl.style.display = 'none';
    const frag = document.createDocumentFragment();
    state.history.forEach((h, i) => {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.dataset.index = i;
      li.innerHTML = `
        <div class="h-expr">${escapeHtml(h.expr)}</div>
        <div class="h-result">${escapeHtml(formatResult(h.result))}</div>
      `;
      li.addEventListener('click', () => {
        resetAll();
        state.lastResult = h.result;
        state.justEvaluated = true;
        render(true);
        // Hanya tutup panel saat overlay (mode sempit / PiP)
        if (!isWideMode()) togglePanel(panelHistory, false);
      });
      frag.appendChild(li);
    });
    historyListEl.appendChild(frag);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function clearHistory() {
    state.history = [];
    await storage.set(STORAGE_HISTORY_KEY, []);
    renderHistory();
  }

  // ---------------------------------------------------------------------
  // SETTINGS
  // ---------------------------------------------------------------------
  async function loadSettings() {
    const saved = await storage.get(STORAGE_SETTINGS_KEY);
    if (saved) Object.assign(state.settings, saved);
    applyTheme();
    renderSettings();
  }

  async function saveSettings() {
    await storage.set(STORAGE_SETTINGS_KEY, state.settings);
  }

  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  function renderSettings() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.seg;
      const current = state.settings[key];
      seg.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.val === current);
      });
    });
    $('opt-smartpaste').checked = state.settings.smartPaste;
    $('opt-multisum').checked = state.settings.multiSum;
  }

  function bindSettingsUI() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.seg;
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const val = btn.dataset.val;
        // Validasi: thousands & decimal tidak boleh sama
        if (key === 'thousands' && val === state.settings.decimal && val !== '') {
          showToast('Tidak boleh sama dengan pemisah desimal');
          return;
        }
        if (key === 'decimal' && val === state.settings.thousands && val !== '') {
          showToast('Tidak boleh sama dengan pemisah ribuan');
          return;
        }
        state.settings[key] = val;
        if (key === 'theme') applyTheme();
        renderSettings();
        render();
        renderHistory();
        saveSettings();
      });
    });
    $('opt-smartpaste').addEventListener('change', (e) => {
      state.settings.smartPaste = e.target.checked;
      saveSettings();
    });
    $('opt-multisum').addEventListener('change', (e) => {
      state.settings.multiSum = e.target.checked;
      saveSettings();
    });
  }

  // ---------------------------------------------------------------------
  // PANELS
  // ---------------------------------------------------------------------
  const WIDE_BREAKPOINT = 560;
  let isPipMode = false;
  function isWideMode() {
    // PiP selalu sempit (320px default). Script jalan di context detached
    // window (640px), jadi window.innerWidth menyesatkan saat UI berada di PiP.
    if (isPipMode) return false;
    return window.innerWidth >= WIDE_BREAKPOINT;
  }

  function togglePanel(panel, force) {
    const show = force == null ? panel.hasAttribute('hidden') : force;
    if (show) {
      // Mode sempit: panel saling exclusive (overlay)
      // Mode lebar: history adalah sidebar — tidak perlu ditutup oleh settings
      if (!isWideMode()) {
        [panelHistory, panelSettings].forEach((p) => p.setAttribute('hidden', ''));
      } else if (panel === panelSettings) {
        // settings tetap modal di mode lebar; history sidebar boleh tetap
      }
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
    }
  }

  /**
   * Auto-tampilkan history saat window cukup lebar.
   * Auto-sembunyikan saat menyempit (overlay menutupi calculator = bad UX).
   */
  let lastWide = null;
  function adaptLayoutToSize() {
    const wide = isWideMode();
    if (wide === lastWide) return;
    lastWide = wide;
    if (wide) {
      // Tampilkan history sebagai sidebar
      panelHistory.removeAttribute('hidden');
    } else {
      // Mode sempit -> tutup overlay agar calculator terlihat
      panelHistory.setAttribute('hidden', '');
    }
  }

  // ---------------------------------------------------------------------
  // DETACHED WINDOW & PIP (always-on-top)
  //
  // Strategi 2 lapis:
  // 1. Dari extension popup: chrome.windows.create({type:'popup'})
  //    -> window kalkulator standalone yg tidak ikut tertutup saat klik
  //    di luar. Ini adalah mode "always available".
  // 2. Dari dalam window terpisah itu (tab context normal): tombol yg
  //    sama akan men-trigger documentPictureInPicture utk REAL
  //    always-on-top di atas semua aplikasi.
  // ---------------------------------------------------------------------
  const DETACHED_PARAM = 'detached';
  const isDetached = new URLSearchParams(location.search).has(DETACHED_PARAM);

  let detachedInFlight = false;
  function openDetachedWindow() {
    if (typeof chrome === 'undefined' || !chrome.windows || !chrome.runtime) {
      showToast('Hanya tersedia di Chrome extension');
      return;
    }
    if (detachedInFlight) return;
    detachedInFlight = true;
    const url = chrome.runtime.getURL('popup.html') + '?' + DETACHED_PARAM + '=1';

    // Cek apakah sudah ada window terbuka
    chrome.storage.local.get('modo_detached_id', (res) => {
      const existingId = res.modo_detached_id;
      if (existingId != null) {
        chrome.windows.update(existingId, { focused: true }, () => {
          if (chrome.runtime.lastError) {
            // Window lama sudah ditutup
            createNewDetachedWindow(url);
          } else {
            showToast('Window kalkulator sudah terbuka');
            window.close();
          }
        });
      } else {
        createNewDetachedWindow(url);
      }
    });
  }

  function createNewDetachedWindow(url) {
    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: 640,
        height: 580,
        focused: true,
      },
      (win) => {
        if (win) {
          chrome.storage.local.set({ modo_detached_id: win.id });
        } else {
          detachedInFlight = false;
        }
        // Tutup popup utama
        window.close();
      }
    );
  }

  async function openTruePip() {
    if (!('documentPictureInPicture' in window)) {
      showToast('Update Chrome ke versi 116+');
      return;
    }
    try {
      const pipWin = await documentPictureInPicture.requestWindow({
        width: 320,
        height: 560,
      });

      // Salin stylesheet ke window PiP
      [...document.styleSheets].forEach((sheet) => {
        try {
          const cssRules = [...sheet.cssRules].map((r) => r.cssText).join('');
          const style = pipWin.document.createElement('style');
          style.textContent = cssRules;
          pipWin.document.head.appendChild(style);
        } catch {
          if (sheet.href) {
            const link = pipWin.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            pipWin.document.head.appendChild(link);
          }
        }
      });

      pipWin.document.body.classList.add('pip');
      const appEl = $('app');
      const placeholder = document.createElement('div');
      placeholder.style.display = 'none';
      document.body.replaceChild(placeholder, appEl);
      pipWin.document.body.appendChild(appEl);

      // PiP selalu start di kalkulator — sembunyikan history/settings yg
      // mungkin masih terbuka (sidebar mode) dari detached window.
      isPipMode = true;
      lastWide = false;
      panelHistory.setAttribute('hidden', '');
      panelSettings.setAttribute('hidden', '');

      pipWin.addEventListener('paste', handlePaste);
      pipWin.addEventListener('keydown', handleKeydown);

      pipWin.addEventListener('pagehide', () => {
        try { document.body.replaceChild(appEl, placeholder); } catch {}
        isPipMode = false;
        lastWide = null;
        adaptLayoutToSize();
      }, { once: true });

      showToast('Mode always-on-top aktif');
    } catch (err) {
      showToast('Gagal: ' + err.message);
    }
  }

  function handlePipBtn() {
    // Detached window context -> coba REAL PiP
    // Extension popup -> buka detached window dulu
    if (isDetached) openTruePip();
    else openDetachedWindow();
  }

  // Bersihkan tracking saat detached window ditutup
  if (isDetached && typeof chrome !== 'undefined' && chrome.windows) {
    window.addEventListener('beforeunload', () => {
      chrome.storage.local.remove('modo_detached_id');
    });
  }

  // ---------------------------------------------------------------------
  // KEYBOARD
  // ---------------------------------------------------------------------
  function handleKeydown(e) {
    // Skip jika user lagi mengetik di input lain (mis. di settings)
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'checkbox') return;

    const k = e.key;
    if (/^[0-9]$/.test(k)) { inputDigit(k); pulseBtn(`[data-num="${k}"]`); return; }
    if (k === '.' || k === ',') { inputDot(); pulseBtn('[data-action="dot"]'); return; }
    if (k === '+' || k === '-' || k === '*' || k === '/') {
      inputOperator(k);
      pulseBtn(`[data-op="${k}"]`);
      return;
    }
    if (k === 'Enter' || k === '=') { e.preventDefault(); inputEquals(); pulseBtn('[data-action="equals"]'); return; }
    if (k === 'Escape') { inputClear(); pulseBtn('[data-action="clear"]'); return; }
    if (k === 'Backspace') { inputBackspace(); return; }
    if (k === '%') { inputPercent(); pulseBtn('[data-action="percent"]'); return; }
    if (k === '(') { inputOpenParen(); pulseBtn('[data-action="open-paren"]'); return; }
    if (k === ')') { inputCloseParen(); pulseBtn('[data-action="close-paren"]'); return; }
  }

  function pulseBtn(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 100);
  }

  // ---------------------------------------------------------------------
  // BIND
  // ---------------------------------------------------------------------
  function bindKeypad() {
    keypadEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.num) inputDigit(btn.dataset.num);
      else if (btn.dataset.op) inputOperator(btn.dataset.op);
      else if (btn.dataset.action === 'dot') inputDot();
      else if (btn.dataset.action === 'equals') inputEquals();
      else if (btn.dataset.action === 'clear') inputClear();
      else if (btn.dataset.action === 'sign') inputSign();
      else if (btn.dataset.action === 'percent') inputPercent();
      else if (btn.dataset.action === 'open-paren') inputOpenParen();
      else if (btn.dataset.action === 'close-paren') inputCloseParen();
      else if (btn.dataset.action === 'backspace') inputBackspace();
    });
  }

  function bindUI() {
    $('btn-history').addEventListener('click', () => togglePanel(panelHistory));
    $('btn-settings').addEventListener('click', () => togglePanel(panelSettings));
    $('btn-pip').addEventListener('click', handlePipBtn);
    $('btn-pip').title = isDetached
      ? 'Real always-on-top (Picture-in-Picture)'
      : 'Buka di window terpisah';
    if (isDetached) document.body.classList.add('pip');
    $('clear-history').addEventListener('click', clearHistory);
    $('back-history').addEventListener('click', () => togglePanel(panelHistory, false));
    $('back-settings').addEventListener('click', () => togglePanel(panelSettings, false));

    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('paste', handlePaste);

    // Klik di luar panel utk menutup (hanya saat panel adalah overlay)
    document.addEventListener('click', (e) => {
      // History: hanya tutup di mode sempit (di mode lebar dia adalah sidebar)
      if (
        !isWideMode() &&
        panelHistory.hidden === false &&
        !panelHistory.contains(e.target) &&
        !e.target.closest('#btn-history')
      ) {
        panelHistory.setAttribute('hidden', '');
      }
      // Settings selalu modal
      if (
        panelSettings.hidden === false &&
        !panelSettings.contains(e.target) &&
        !e.target.closest('#btn-settings')
      ) {
        panelSettings.setAttribute('hidden', '');
      }
    });
  }

  // ---------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------
  async function init() {
    await loadSettings();
    await loadHistory();
    await loadState();
    bindKeypad();
    bindSettingsUI();
    bindUI();
    render();
    adaptLayoutToSize();
    window.addEventListener('resize', adaptLayoutToSize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
