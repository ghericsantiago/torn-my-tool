// ==UserScript==
// @name         Torn Portfolio Tracker
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Track buy/sell transactions with market prices and potential income
// @author       Gheric
// @match        https://www.torn.com
// @match        https://www.torn.com/index.php
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://www.torn.com/gym.php
// @match        https://www.torn.com/hospitalview.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  const BUY_LOG_TYPES  = [1103, 1112, 1220, 1225, 4201, 4200];
  const SELL_LOG_TYPES = [1104, 1113, 1221, 1226, 4210, 4220];
  const LOG_TYPE_STORE = {
    1103: 'Item Market',  1104: 'Item Market',
    1112: 'Point Market', 1113: 'Point Market',
    1220: 'Bazaar',       1221: 'Bazaar',
    1225: 'Armoury',      1226: 'Armoury',
    4200: 'Trade',        4201: 'Trade',
    4210: 'Trade',        4220: 'Trade',
  };

  const STORE_BADGE_CLASS = {
    'Item Market':  'bdg-blue',
    'Point Market': 'bdg-yellow',
    'Bazaar':       'bdg-orange',
    'Armoury':      'bdg-red',
    'Trade':        'bdg-purple',
    'Abroad':       'bdg-teal',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let panelOpen        = false;
  let activeTab        = 'buy';
  let originalBuyData  = [];
  let originalSellData = [];
  let filteredBuyData  = [];
  let filteredSellData = [];
  let itemCatalog      = {};
  let valueChart       = null;
  let sortState        = { col: null, dir: 'asc' };

  // ── Styles ────────────────────────────────────────────────────────────────
  GM_addStyle(`
    /* ═══════════════════════════════════════
       Torn Portfolio Tracker — Theme v1.1
       Palette: Torn dark-navy with gold accent
    ═══════════════════════════════════════ */

    /* ── Toggle tab ── */
    #pt-toggle {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      background: linear-gradient(180deg, #c9943a 0%, #a87428 100%);
      color: #fff;
      width: 26px;
      padding: 18px 0;
      border-radius: 6px 0 0 6px;
      cursor: pointer;
      z-index: 2147483646;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font: 700 10px/1 'Arial', sans-serif;
      letter-spacing: 2px;
      text-align: center;
      user-select: none;
      box-shadow: -3px 0 12px rgba(0,0,0,0.55);
      transition: opacity 0.2s, filter 0.15s;
      text-shadow: 0 1px 3px rgba(0,0,0,0.4);
    }
    #pt-toggle:hover { filter: brightness(1.15); }
    #pt-toggle.open  { opacity: 0; pointer-events: none; }

    /* ── Panel shell ── */
    #pt-panel {
      position: fixed;
      top: 0;
      right: -920px;
      width: min(900px, 100vw);
      height: 100dvh;
      background: #12141f;
      color: #c8cde0;
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      box-shadow: -8px 0 40px rgba(0,0,0,0.75);
      transition: right 0.32s cubic-bezier(.4,0,.2,1);
      font-family: 'Arial', sans-serif;
      font-size: 13px;
      overflow: hidden;
    }
    #pt-panel.open { right: 0; }

    /* ── Header ── */
    #pt-hdr {
      background: linear-gradient(90deg, #1a1c2b 0%, #1d2035 100%);
      padding: 13px 18px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 2px solid #c9943a;
      flex-shrink: 0;
    }
    #pt-hdr-icon {
      width: 28px;
      height: 28px;
      background: linear-gradient(135deg, #c9943a, #a87428);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    #pt-hdr h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #e8c37a;
      letter-spacing: 0.3px;
      flex: 1;
    }
    #pt-hdr-sub {
      font-size: 10px;
      color: #4a5270;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    #pt-close {
      background: #1f2340;
      border: 1px solid #2e3452;
      color: #4a5270;
      font-size: 16px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      width: 28px;
      height: 28px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    #pt-close:hover { background: #2e3452; color: #c8cde0; }

    /* ── Controls ── */
    #pt-controls {
      background: #171929;
      border-bottom: 1px solid #222540;
      padding: 9px 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      flex-shrink: 0;
    }
    #pt-controls label {
      font-size: 10px;
      font-weight: 600;
      color: #4a5270;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    #pt-controls input {
      background: #1c1f33;
      border: 1px solid #2a2f4a;
      color: #c8cde0;
      padding: 5px 9px;
      border-radius: 5px;
      font-size: 12px;
      outline: none;
      min-width: 0;
      transition: border-color 0.15s;
    }
    #pt-controls input:focus { border-color: #c9943a; }
    #pt-controls input::placeholder { color: #323656; }
    #pt-key    { width: 140px; font-family: monospace; font-size: 11px; }
    #pt-from,
    #pt-to     { width: 126px; }
    #pt-search { width: 110px; }
    #pt-tax    { width: 50px; text-align: center; }

    /* colour the date input calendar icon on Webkit */
    #pt-controls input[type="date"]::-webkit-calendar-picker-indicator {
      filter: invert(0.5) sepia(1) saturate(2) hue-rotate(10deg);
      cursor: pointer;
    }

    .pt-btn {
      background: linear-gradient(135deg, #c9943a, #a87428);
      color: #fff;
      border: none;
      padding: 0 16px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      height: 28px;
      letter-spacing: 0.3px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      transition: filter 0.15s, transform 0.1s;
    }
    .pt-btn:hover    { filter: brightness(1.12); transform: translateY(-1px); }
    .pt-btn:active   { transform: translateY(0); filter: brightness(0.95); }
    .pt-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; }
    .pt-btn.blue  { background: linear-gradient(135deg, #3a6fd8, #2a55b0); }
    .pt-btn.gray  { background: linear-gradient(135deg, #2a2f4a, #1e2238); }

    #pt-status {
      font-size: 11px;
      color: #3d4466;
      flex: 1;
      min-width: 80px;
    }
    #pt-status.err { color: #d95858; }
    #pt-status.ok  { color: #3ec870; }

    /* ── Summary tiles ── */
    #pt-summary {
      display: flex;
      gap: 0;
      padding: 0;
      flex-shrink: 0;
      background: #171929;
      border-bottom: 1px solid #222540;
    }
    .pt-tile {
      flex: 1;
      padding: 11px 14px 10px;
      border-right: 1px solid #222540;
      position: relative;
    }
    .pt-tile:last-child { border-right: none; }
    .pt-tile::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
    }
    .pt-tile.blue::before   { background: #4d85f4; }
    .pt-tile.red::before    { background: #d95858; }
    .pt-tile.green::before  { background: #3ec870; }
    .pt-tile.purple::before { background: #9b6cf5; }
    .pt-tile-lbl {
      font-size: 10px;
      font-weight: 600;
      color: #3d4466;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .pt-tile-val {
      font-size: 16px;
      font-weight: 700;
      line-height: 1;
    }
    .pt-tile.blue   .pt-tile-val { color: #6aa0f7; }
    .pt-tile.red    .pt-tile-val { color: #e06a6a; }
    .pt-tile.green  .pt-tile-val { color: #3ec870; }
    .pt-tile.purple .pt-tile-val { color: #a87af6; }

    /* ── Tab bar ── */
    #pt-tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 14px;
      background: #131620;
      border-bottom: 1px solid #1e2135;
      flex-shrink: 0;
    }
    .pt-tab {
      background: transparent;
      color: #3d4466;
      border: 1px solid transparent;
      padding: 5px 16px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
      letter-spacing: 0.2px;
    }
    .pt-tab:hover  { color: #c8cde0; background: #1c1f33; border-color: #2a2f4a; }
    .pt-tab.active {
      background: #1c2040;
      border-color: #c9943a;
      color: #e8c37a;
    }
    .pt-tab-n {
      font-size: 10px;
      font-weight: 700;
      background: rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 1px 6px;
      margin-left: 5px;
    }
    .pt-tab.active .pt-tab-n { background: rgba(201,148,58,0.2); color: #c9943a; }

    #pt-chart-btn {
      margin-left: auto;
      background: transparent;
      color: #3d4466;
      border: 1px solid #1e2135;
      padding: 4px 12px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    #pt-chart-btn:hover { color: #c8cde0; border-color: #2a2f4a; }

    /* ── Chart ── */
    #pt-chart-wrap {
      background: #131620;
      border-bottom: 1px solid #1e2135;
      flex-shrink: 0;
      overflow: hidden;
      max-height: 0;
      transition: max-height 0.3s ease, padding 0.3s ease;
      padding: 0 16px;
    }
    #pt-chart-wrap.show { max-height: 215px; padding: 12px 16px; }
    #pt-chart-wrap canvas { max-height: 190px; }

    /* ── Table scroll container ── */
    #pt-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      background: #12141f;
    }
    #pt-tbl-wrap { overflow-x: auto; }

    #pt-spinner {
      display: none;
      justify-content: center;
      align-items: center;
      padding: 56px;
    }
    #pt-spinner.show { display: flex; }
    .pt-spin {
      width: 30px; height: 30px;
      border: 3px solid #1e2135;
      border-top-color: #c9943a;
      border-radius: 50%;
      animation: pt-spin 0.75s linear infinite;
    }
    @keyframes pt-spin { to { transform: rotate(360deg); } }

    /* ── Table ── */
    #pt-panel table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    #pt-panel thead th {
      background: #171929;
      color: #4a5270;
      padding: 8px 12px;
      text-align: left;
      white-space: nowrap;
      position: sticky;
      top: 0;
      z-index: 2;
      cursor: pointer;
      user-select: none;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #1e2135;
      transition: color 0.15s;
    }
    #pt-panel thead th:hover { color: #c8cde0; }
    #pt-panel thead th.r     { text-align: right; }
    #pt-panel thead th::after { content: " ↕"; font-size: 9px; opacity: .25; }
    #pt-panel thead th.s-asc::after  { content: " ↑"; opacity: 1; color: #c9943a; }
    #pt-panel thead th.s-desc::after { content: " ↓"; opacity: 1; color: #c9943a; }

    #pt-panel tbody td {
      padding: 7px 12px;
      border-bottom: 1px solid #1a1d2e;
      white-space: nowrap;
      color: #c8cde0 !important;
    }
    #pt-panel tbody tr { transition: background 0.1s; }
    #pt-panel tbody tr:hover td { background: #1a1d2e; }
    #pt-panel tbody tr:nth-child(even) td { background: #141725; }
    #pt-panel tbody tr:nth-child(even):hover td { background: #1a1d2e; }

    #pt-panel td.r     { text-align: right; }
    #pt-panel td.dim   { color: #6b7494 !important; font-size: 11px; }
    #pt-panel td.red   { text-align: right; color: #e06a6a !important; font-weight: 600; }
    #pt-panel td.green { text-align: right; color: #3ec870 !important; font-weight: 600; }
    #pt-panel td.gold  { text-align: right; color: #c9943a !important; font-weight: 600; }
    #pt-panel td.empty { text-align: center; color: #4a5270 !important; padding: 40px 0; font-size: 13px; }

    /* ── Store badges ── */
    .pt-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.3px;
    }
    .bdg-blue   { background: rgba(77,133,244,0.15); color: #6aa0f7; border: 1px solid rgba(77,133,244,0.25); }
    .bdg-orange { background: rgba(201,148,58,0.15); color: #c9943a; border: 1px solid rgba(201,148,58,0.25); }
    .bdg-yellow { background: rgba(234,197,65,0.15); color: #e8c541; border: 1px solid rgba(234,197,65,0.25); }
    .bdg-red    { background: rgba(217,88,88,0.15);  color: #e06a6a; border: 1px solid rgba(217,88,88,0.25); }
    .bdg-purple { background: rgba(155,108,245,0.15);color: #a87af6; border: 1px solid rgba(155,108,245,0.25); }
    .bdg-teal   { background: rgba(56,200,180,0.15); color: #38c8b4; border: 1px solid rgba(56,200,180,0.25); }
    .bdg-gray   { background: rgba(58,64,96,0.4);    color: #4a5270; border: 1px solid #2a2f4a; }

    /* item name cell */
    #pt-panel td.item-name { color: #c8cde0; font-weight: 500; }

    /* ── Scrollbar ── */
    #pt-panel ::-webkit-scrollbar { width: 5px; height: 5px; }
    #pt-panel ::-webkit-scrollbar-track { background: #12141f; }
    #pt-panel ::-webkit-scrollbar-thumb { background: #2a2f4a; border-radius: 3px; }
    #pt-panel ::-webkit-scrollbar-thumb:hover { background: #3d4466; }

    /* ── Mobile ── */
    @media (max-width: 600px) {
      #pt-panel   { width: 100vw; }
      #pt-toggle.open { right: 100vw; }
      .pt-col-store, .pt-col-date { display: none !important; }
      #pt-key  { width: 120px; }
      #pt-from, #pt-to { width: 108px; }
      .pt-tile-val { font-size: 14px; }
      .pt-tile-lbl { font-size: 9px; }
    }
  `);

  // ── Build panel ───────────────────────────────────────────────────────────
  function buildUI() {
    localStorage.removeItem('tornItemCatalog');
    localStorage.removeItem('tornItemCatalog_v2');

    const savedKey = localStorage.getItem('tornApiKey') || 'v6Yo75UQIYvWYrhT';
    const now  = new Date();
    const week = new Date(+now - 7 * 86400_000);

    const toggle = el('div', { id: 'pt-toggle', title: 'Portfolio Tracker' }, 'Portfolio');
    toggle.addEventListener('click', togglePanel);

    const panel = el('div', { id: 'pt-panel' });
    panel.innerHTML = `
      <div id="pt-hdr">
        <div id="pt-hdr-icon">&#x1F4B0;</div>
        <div style="flex:1;min-width:0">
          <h2>Portfolio Tracker</h2>
          <div id="pt-hdr-sub">Torn Transaction Analytics</div>
        </div>
        <button id="pt-close" title="Close">&#x2715;</button>
      </div>

      <div id="pt-controls">
        <label>Key</label>
        <input id="pt-key" type="password" placeholder="API key" value="${esc(savedKey)}" autocomplete="off">
        <label>From</label>
        <input id="pt-from" type="date" value="${isoDate(week)}">
        <label>To</label>
        <input id="pt-to" type="date" value="${isoDate(now)}">
        <label>Tax%</label>
        <input id="pt-tax" type="number" value="5" min="0" max="100" step="0.1">
        <input id="pt-search" type="text" placeholder="&#x1F50D; Search item...">
        <button class="pt-btn" id="pt-load">Load Data</button>
        <span id="pt-status"></span>
      </div>

      <div id="pt-summary">
        <div class="pt-tile blue">
          <div class="pt-tile-lbl">Total Items</div>
          <div class="pt-tile-val" id="pt-s-items">—</div>
        </div>
        <div class="pt-tile red">
          <div class="pt-tile-lbl">Total Spent</div>
          <div class="pt-tile-val" id="pt-s-spent">—</div>
        </div>
        <div class="pt-tile green">
          <div class="pt-tile-lbl">Total Sold</div>
          <div class="pt-tile-val" id="pt-s-sold">—</div>
        </div>
        <div class="pt-tile purple">
          <div class="pt-tile-lbl">Potential Income</div>
          <div class="pt-tile-val" id="pt-s-income">—</div>
        </div>
      </div>

      <div id="pt-tabs">
        <button class="pt-tab active" data-tab="buy">
          Purchased <span class="pt-tab-n" id="pt-n-buy">0</span>
        </button>
        <button class="pt-tab" data-tab="sell">
          Sold <span class="pt-tab-n" id="pt-n-sell">0</span>
        </button>
        <button id="pt-chart-btn">&#x1F4C8; Chart</button>
      </div>

      <div id="pt-chart-wrap">
        <canvas id="pt-chart"></canvas>
      </div>

      <div id="pt-body">
        <div id="pt-spinner"><div class="pt-spin"></div></div>
        <div id="pt-tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="pt-col-store">Store</th>
                <th class="r">Qty</th>
                <th class="r">Avg</th>
                <th class="r">Total</th>
                <th class="r">Mkt Price</th>
                <th class="r">Est. Income</th>
                <th class="r">$/Unit</th>
                <th class="r pt-col-date">Last</th>
              </tr>
            </thead>
            <tbody id="pt-tbody">
              <tr><td colspan="9" class="empty">Select a date range and click Load Data.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    panel.querySelector('#pt-close')    .addEventListener('click', togglePanel);
    panel.querySelector('#pt-load')     .addEventListener('click', loadData);
    panel.querySelector('#pt-tax')      .addEventListener('input', rerender);
    panel.querySelector('#pt-chart-btn').addEventListener('click', onChartToggle);

    let searchTimer;
    panel.querySelector('#pt-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(rerender, 300);
    });

    panel.querySelectorAll('.pt-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        panel.querySelectorAll('.pt-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        rerender();
      });
    });

    panel.querySelectorAll('thead th').forEach((th, i) => {
      th.addEventListener('click', () => sortBy(i));
    });

    if (savedKey) loadData();
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    document.getElementById('pt-panel').classList.toggle('open', panelOpen);
    document.getElementById('pt-toggle').classList.toggle('open', panelOpen);
  }

  function onChartToggle() {
    const wrap = document.getElementById('pt-chart-wrap');
    const btn  = document.getElementById('pt-chart-btn');
    const show = wrap.classList.toggle('show');
    btn.textContent = show ? '✕ Chart' : '📈 Chart';
    if (show) renderChart();
  }

  // ── API ───────────────────────────────────────────────────────────────────
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload:    r => { try { resolve(JSON.parse(r.responseText)); } catch(e) { reject(new Error('Invalid JSON')); } },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // ── Load data ─────────────────────────────────────────────────────────────
  async function loadData() {
    const key  = document.getElementById('pt-key').value.trim();
    const from = document.getElementById('pt-from').value;
    const to   = document.getElementById('pt-to').value;

    if (!key)        { setStatus('Enter your API key.', 'err'); return; }
    if (!from || !to){ setStatus('Select a date range.', 'err'); return; }

    localStorage.setItem('tornApiKey', key);

    const btn = document.getElementById('pt-load');
    btn.disabled = true;
    showLoading(true);

    try {
      if (!Object.keys(itemCatalog).length) {
        const cached = localStorage.getItem('tornItemCatalog_v3');
        if (cached) {
          itemCatalog = JSON.parse(cached);
        } else {
          setStatus('Fetching item catalog…');
          const data = await gmFetch(`https://api.torn.com/torn/?selections=items&key=${key}`);
          if (data.error) throw new Error(data.error.error);
          itemCatalog = {};
          for (const [id, item] of Object.entries(data.items)) {
            itemCatalog[id] = { name: item.name, price: item.market_value ?? 0 };
          }
          localStorage.setItem('tornItemCatalog_v3', JSON.stringify(itemCatalog));
        }
      }

      const fromTs = toUnix(from, false);
      const toTs   = toUnix(to,   true);
      setStatus('Fetching transaction logs…');

      const [buyRaw, sellRaw] = await Promise.all([
        gmFetch(`https://api.torn.com/v2/user/log?key=${key}&log=${BUY_LOG_TYPES.join(',')}&from=${fromTs}&to=${toTs}`),
        gmFetch(`https://api.torn.com/v2/user/log?key=${key}&log=${SELL_LOG_TYPES.join(',')}&from=${fromTs}&to=${toTs}`),
      ]);

      if (buyRaw.error)  throw new Error(buyRaw.error.error);
      if (sellRaw.error) throw new Error(sellRaw.error.error);

      const buyLogs  = Object.values(buyRaw.log  || {});
      const sellLogs = Object.values(sellRaw.log || {});

      originalBuyData  = processLogs(buyLogs);
      originalSellData = processLogs(sellLogs);

      rerender();
      setStatus(
        `${buyLogs.length + sellLogs.length} log entries · ${originalBuyData.length} buys · ${originalSellData.length} sells`,
        'ok'
      );
    } catch (e) {
      setStatus('Error: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      showLoading(false);
    }
  }

  // ── Process logs ──────────────────────────────────────────────────────────
  function storeFromTitle(title) {
    const t = (title || '').toLowerCase();
    if (t.includes('bazaar'))                                    return 'Bazaar';
    if (t.includes('item market') || t.includes('city market')) return 'Item Market';
    if (t.includes('point market'))                              return 'Point Market';
    if (t.includes('armoury') || t.includes('armory'))          return 'Armoury';
    if (t.includes('trade'))                                     return 'Trade';
    if (t.includes('abroad') || t.includes('foreign'))          return 'Abroad';
    return 'Unknown';
  }

  function processLogs(logs) {
    const map = new Map();
    logs.forEach(log => {
      const d      = log.data || {};
      const itemId = d.item ?? d.items?.[0]?.id;
      if (!itemId) return;

      const cat     = itemCatalog[itemId] || { name: `Item ${itemId}`, price: 0 };
      const logType = log.log ?? log.log_type ?? log.type;
      const store   = LOG_TYPE_STORE[logType] || log.category || storeFromTitle(log.title);
      const qty     = d.quantity ?? d.items?.[0]?.qty ?? 1;
      const cost    = d.cost_total ?? d.cost ?? 0;
      const ts      = log.timestamp * 1000;

      if (!map.has(itemId)) {
        map.set(itemId, {
          item_id: itemId, item_name: cat.name, store_type: store,
          current_price: cat.price, total_quantity: 0, total_amount: 0, last_transaction: ts,
        });
      }
      const e = map.get(itemId);
      e.total_quantity += qty;
      e.total_amount   += cost;
      if (ts > e.last_transaction) e.last_transaction = ts;
    });

    return Array.from(map.values()).map(e => ({
      ...e,
      avg_cost: e.total_quantity > 0 ? e.total_amount / e.total_quantity : 0,
    }));
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function rerender() {
    const search = document.getElementById('pt-search').value.toLowerCase();
    filteredBuyData  = originalBuyData .filter(i => i.item_name.toLowerCase().includes(search));
    filteredSellData = originalSellData.filter(i => i.item_name.toLowerCase().includes(search));

    document.getElementById('pt-n-buy') .textContent = filteredBuyData.length;
    document.getElementById('pt-n-sell').textContent = filteredSellData.length;

    const data = activeTab === 'buy' ? filteredBuyData : filteredSellData;
    renderTable(data);
    updateSummary();
    if (document.getElementById('pt-chart-wrap').classList.contains('show')) renderChart();
  }

  function badgeClass(store) {
    return STORE_BADGE_CLASS[store] || 'bdg-gray';
  }

  function renderTable(data) {
    const taxRate = getTaxRate();
    const isBuy   = activeTab === 'buy';
    const tbody   = document.getElementById('pt-tbody');

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">No transactions found for this range.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(item => {
      const income    = item.current_price > 0
        ? Math.round(item.current_price * item.total_quantity * (1 - taxRate / 100))
        : null;
      const perUnit   = item.current_price > 0
        ? Math.round(item.current_price * (1 - taxRate / 100))
        : null;
      const amtClass = isBuy ? 'red' : 'green';
      return `<tr>
        <td class="item-name">${esc(item.item_name)}</td>
        <td class="pt-col-store"><span class="pt-badge ${badgeClass(item.store_type)}">${esc(item.store_type)}</span></td>
        <td class="r">${item.total_quantity.toLocaleString()}</td>
        <td class="${amtClass}">$${Math.round(item.avg_cost).toLocaleString()}</td>
        <td class="${amtClass}">$${item.total_amount.toLocaleString()}</td>
        <td class="gold">${item.current_price > 0 ? '$' + item.current_price.toLocaleString() : '<span style="color:#2e3452">—</span>'}</td>
        <td class="${income !== null ? 'green' : ''}">
          ${income !== null ? '$' + income.toLocaleString() : '<span style="color:#2e3452">—</span>'}
        </td>
        <td class="${perUnit !== null ? 'gold' : ''}">
          ${perUnit !== null ? '$' + perUnit.toLocaleString() : '<span style="color:#2e3452">—</span>'}
        </td>
        <td class="dim r pt-col-date">${fmtDate(item.last_transaction)}</td>
      </tr>`;
    }).join('');
  }

  function updateSummary() {
    const taxRate  = getTaxRate();
    const buyTotal = filteredBuyData .reduce((s, i) => s + i.total_amount, 0);
    const sellTotal= filteredSellData.reduce((s, i) => s + i.total_amount, 0);
    const income   = filteredBuyData .reduce((s, i) =>
      s + i.current_price * i.total_quantity * (1 - taxRate / 100), 0);

    document.getElementById('pt-s-items') .textContent = filteredBuyData.length + filteredSellData.length;
    document.getElementById('pt-s-spent') .textContent = fmt$(buyTotal);
    document.getElementById('pt-s-sold')  .textContent = fmt$(sellTotal);
    document.getElementById('pt-s-income').textContent = fmt$(income);
  }

  function renderChart() {
    const ctx = document.getElementById('pt-chart').getContext('2d');
    const map = new Map();

    filteredBuyData.forEach(i => {
      if (!map.has(i.item_id)) map.set(i.item_id, { name: i.item_name, buy: 0, sell: 0 });
      map.get(i.item_id).buy += i.total_amount;
    });
    filteredSellData.forEach(i => {
      if (!map.has(i.item_id)) map.set(i.item_id, { name: i.item_name, buy: 0, sell: 0 });
      map.get(i.item_id).sell += i.total_amount;
    });

    const rows = [...map.values()]
      .filter(i => i.buy > 0 || i.sell > 0)
      .sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell))
      .slice(0, 12);

    // Update existing chart in-place to avoid flicker; only create on first call
    if (valueChart) {
      valueChart.data.labels            = rows.map(i => i.name);
      valueChart.data.datasets[0].data  = rows.map(i => i.buy);
      valueChart.data.datasets[1].data  = rows.map(i => i.sell);
      valueChart.update('none');
      return;
    }

    valueChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(i => i.name),
        datasets: [
          { label: 'Bought', data: rows.map(i => i.buy),
            backgroundColor: 'rgba(217,88,88,0.65)', borderColor: '#e06a6a', borderWidth: 1, borderRadius: 3 },
          { label: 'Sold',   data: rows.map(i => i.sell),
            backgroundColor: 'rgba(62,200,112,0.65)', borderColor: '#3ec870', borderWidth: 1, borderRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        animation: { duration: 300 },
        plugins: {
          legend: { labels: { color: '#4a5270', font: { size: 10 }, boxWidth: 10 } },
          tooltip: {
            backgroundColor: '#1a1d2e',
            borderColor: '#2a2f4a',
            borderWidth: 1,
            titleColor: '#c8cde0',
            bodyColor: '#8a90b0',
            callbacks: { label: c => ` ${c.dataset.label}: $${Math.round(c.parsed.y).toLocaleString()}` },
          },
        },
        scales: {
          x: { ticks: { color: '#3d4466', font: { size: 9 }, maxRotation: 40 }, grid: { color: '#1a1d2e' } },
          y: { ticks: { color: '#3d4466', font: { size: 9 },
               callback: v => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : v >= 1e3 ? '$'+(v/1e3).toFixed(0)+'K' : '$'+v },
               grid: { color: '#1a1d2e' } },
        },
      },
    });
  }

  // ── Sort ──────────────────────────────────────────────────────────────────
  function sortBy(colIndex) {
    const data    = activeTab === 'buy' ? filteredBuyData : filteredSellData;
    const taxRate = getTaxRate();
    const ths     = document.querySelectorAll('#pt-panel thead th');

    const dir = sortState.col === colIndex && sortState.dir === 'asc' ? 'desc' : 'asc';
    sortState = { col: colIndex, dir };

    ths.forEach(th => th.classList.remove('s-asc', 's-desc'));
    ths[colIndex].classList.add(dir === 'asc' ? 's-asc' : 's-desc');

    data.sort((a, b) => {
      let av, bv;
      switch (colIndex) {
        case 0: av = a.item_name.toLowerCase();  bv = b.item_name.toLowerCase(); break;
        case 1: av = a.store_type.toLowerCase(); bv = b.store_type.toLowerCase(); break;
        case 2: av = a.total_quantity;   bv = b.total_quantity; break;
        case 3: av = a.avg_cost;         bv = b.avg_cost; break;
        case 4: av = a.total_amount;     bv = b.total_amount; break;
        case 5: av = a.current_price;    bv = b.current_price; break;
        case 6: av = a.current_price * a.total_quantity * (1 - taxRate / 100);
                bv = b.current_price * b.total_quantity * (1 - taxRate / 100); break;
        case 7: av = a.current_price * (1 - taxRate / 100);
                bv = b.current_price * (1 - taxRate / 100); break;
        case 8: av = a.last_transaction; bv = b.last_transaction; break;
        default: return 0;
      }
      return dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });

    if (activeTab === 'buy') filteredBuyData = data;
    else filteredSellData = data;

    renderTable(data);
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  function exportCSV() {
    const taxRate = getTaxRate();
    const rows = [
      ...filteredBuyData .map(i => ({ ...i, _type: 'Buy'  })),
      ...filteredSellData.map(i => ({ ...i, _type: 'Sell' })),
    ];
    if (!rows.length) { alert('No data to export.'); return; }

    let csv = 'Type,Item,Store,Qty,Avg Price,Total,Market Price,Potential Income,Last\n';
    rows.forEach(i => {
      const inc = i.current_price > 0
        ? Math.round(i.current_price * i.total_quantity * (1 - taxRate / 100)) : '';
      csv += `"${i._type}","${i.item_name}","${i.store_type}",${i.total_quantity},${Math.round(i.avg_cost)},${i.total_amount},${i.current_price || ''},${inc},"${fmtDate(i.last_transaction)}"\n`;
    });

    const url  = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = `torn_portfolio_${isoDate(new Date())}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getTaxRate() {
    const e = document.getElementById('pt-tax');
    return e ? Math.max(0, Math.min(100, parseFloat(e.value) || 0)) : 5;
  }
  function toUnix(dateStr, end) {
    return Math.floor(new Date(dateStr + (end ? 'T23:59:59Z' : 'T00:00:00Z')).getTime() / 1000);
  }
  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function fmtDate(ts) {
    return ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
  }
  function fmt$(n) {
    if (!n) return '$0';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    return '$' + Math.round(n).toLocaleString();
  }
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function setStatus(msg, cls = '') {
    const e = document.getElementById('pt-status');
    if (e) { e.textContent = msg; e.className = cls; }
  }
  function showLoading(show) {
    const sp = document.getElementById('pt-spinner');
    const tw = document.getElementById('pt-tbl-wrap');
    if (sp) sp.classList.toggle('show', show);
    if (tw) tw.style.display = show ? 'none' : '';
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  buildUI();
})();
