// ==UserScript==
// @name         Torn Item Market Analyzer
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Analyze Torn item market price history with charts and profit tools
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

  // ── Config ────────────────────────────────────────────────────────────────
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbxP7bkclfZq_rrNClyrn5bYQuB7kVNVU0edCIyQHhFW7TuTu9Gg4-kKUaJtuRz0ziA8_Q/exec';

  const TF_ENDPOINT = {
    '1m':  'item_market',
    '5m':  'item_market_5m',
    '15m': 'item_market_15m',
    '30m': 'item_market_30m',
    '1h':  'item_market_1h',
    'day': 'item_market_day',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let panelOpen      = false;
  let activeTab      = 'chart';
  let currentTF      = '15m';
  let currentChartType = 'line';
  let chartData      = [];
  let tableData      = [];
  let itemMappings   = {};
  let itemNames      = [];
  let priceChart     = null;
  let refreshTimer   = null;
  let autoRefreshOn  = false;
  let sortState      = { col: null, dir: 'asc' };
  let autoCalc       = true;
  let bestLoaded     = false;

  // ── Styles ────────────────────────────────────────────────────────────────
  GM_addStyle(`
    /* ════════════════════════════════════════
       Torn Item Market Analyzer — Theme v1.0
       Palette: Torn dark-navy with gold accent
    ════════════════════════════════════════ */

    #ima-toggle {
      position: fixed;
      right: 0;
      top: calc(50% - 100px);
      transform: translateY(-50%);
      background: linear-gradient(180deg, #c9943a 0%, #a87428 100%);
      color: #fff;
      width: 26px;
      padding: 18px 0;
      border-radius: 6px 0 0 6px;
      cursor: pointer;
      z-index: 2147483644;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font: 700 10px/1 'Arial', sans-serif;
      letter-spacing: 2px;
      text-align: center;
      user-select: none;
      box-shadow: -3px 0 12px rgba(0,0,0,0.55);
      transition: opacity 0.2s, filter 0.15s;
      text-shadow: 0 1px 3px rgba(0,0,0,0.4);
      padding-right: 13px;
    }
    #ima-toggle:hover { filter: brightness(1.15); }
    #ima-toggle.open  { opacity: 0; pointer-events: none; }

    /* ── Panel shell ── */
    #ima-panel {
      position: fixed;
      top: 0;
      right: -920px;
      width: min(900px, 100vw);
      height: 100dvh;
      background: #12141f;
      color: #c8cde0;
      z-index: 2147483643;
      display: flex;
      flex-direction: column;
      box-shadow: -8px 0 40px rgba(0,0,0,0.75);
      transition: right 0.32s cubic-bezier(.4,0,.2,1);
      font-family: 'Arial', sans-serif;
      font-size: 13px;
      overflow: hidden;
    }
    #ima-panel.open { right: 0; }

    /* ── Header ── */
    #ima-hdr {
      background: linear-gradient(90deg, #1a1c2b 0%, #1d2035 100%);
      padding: 13px 18px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 2px solid #c9943a;
      flex-shrink: 0;
    }
    #ima-hdr-icon {
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
    #ima-hdr h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #e8c37a;
      letter-spacing: 0.3px;
      flex: 1;
    }
    #ima-hdr-sub {
      font-size: 10px;
      color: #4a5270;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    #ima-close {
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
    #ima-close:hover { background: #2e3452; color: #c8cde0; }

    /* ── Controls ── */
    #ima-controls {
      background: #171929;
      border-bottom: 1px solid #222540;
      padding: 8px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .ima-ctrl-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex-wrap: wrap;
    }
    #ima-controls label {
      font-size: 10px;
      font-weight: 600;
      color: #4a5270;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #ima-controls input[type="text"],
    #ima-controls input[type="date"],
    #ima-controls input[type="time"],
    #ima-controls input[type="number"] {
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
    #ima-controls input:focus { border-color: #c9943a; }
    #ima-controls input::placeholder { color: #323656; }
    #ima-item-name { flex: 1; min-width: 120px; max-width: 260px; }
    #ima-item-id   { width: 70px; flex-shrink: 0; }
    #ima-from, #ima-to   { flex: 1; min-width: 100px; max-width: 145px; }
    #ima-time-from, #ima-time-to { width: 90px; flex-shrink: 0; }
    #ima-controls input[type="date"]::-webkit-calendar-picker-indicator,
    #ima-controls input[type="time"]::-webkit-calendar-picker-indicator {
      filter: invert(0.5) sepia(1) saturate(2) hue-rotate(10deg);
      cursor: pointer;
    }

    /* ── Autocomplete portal ── */
    #ima-ac-portal {
      position: fixed;
      background: #1c1f33;
      border: 1px solid #2a2f4a;
      border-top: none;
      border-radius: 0 0 5px 5px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 2147483647;
      display: none;
    }
    #ima-ac-portal ::-webkit-scrollbar { width: 4px; }
    #ima-ac-portal ::-webkit-scrollbar-thumb { background: #2a2f4a; border-radius: 3px; }
    .ima-ac-item {
      padding: 6px 10px;
      font-size: 12px;
      color: #c8cde0;
      cursor: pointer;
      font-family: 'Arial', sans-serif;
    }
    .ima-ac-item:hover, .ima-ac-item.active {
      background: #2a2f4a;
      color: #e8c37a;
    }

    /* ── Buttons ── */
    .ima-btn {
      background: linear-gradient(135deg, #c9943a, #a87428);
      color: #fff;
      border: none;
      padding: 0 14px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      height: 28px;
      letter-spacing: 0.3px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      transition: filter 0.15s, transform 0.1s;
      flex-shrink: 0;
    }
    .ima-btn:hover    { filter: brightness(1.12); transform: translateY(-1px); }
    .ima-btn:active   { transform: translateY(0); filter: brightness(0.95); }
    .ima-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; }
    .ima-btn.gray     { background: linear-gradient(135deg, #2a2f4a, #1e2238); }
    .ima-btn.blue     { background: linear-gradient(135deg, #3a6fd8, #2a55b0); }
    .ima-btn.green    { background: linear-gradient(135deg, #2a9d5c, #1e7a44); }

    .ima-nav {
      background: #1c1f33;
      border: 1px solid #2a2f4a;
      color: #6b7494;
      width: 26px;
      height: 28px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 15px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
      flex-shrink: 0;
    }
    .ima-nav:hover { background: #2a2f4a; color: #c8cde0; border-color: #3d4466; }

    /* ── Timeframe buttons ── */
    .ima-tf-btn {
      background: transparent;
      border: 1px solid #2a2f4a;
      color: #4a5270;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .ima-tf-btn:hover  { border-color: #c9943a; color: #c8cde0; }
    .ima-tf-btn.active { background: rgba(201,148,58,0.15); border-color: #c9943a; color: #e8c37a; }

    /* ── Status ── */
    #ima-status {
      font-size: 11px;
      color: #3d4466;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #ima-status.err { color: #d95858; }
    #ima-status.ok  { color: #3ec870; }

    /* ── Summary tiles ── */
    #ima-summary {
      display: flex;
      gap: 0;
      flex-shrink: 0;
      background: #171929;
      border-bottom: 1px solid #222540;
    }
    .ima-tile {
      flex: 1;
      padding: 10px 14px 9px;
      border-right: 1px solid #222540;
      position: relative;
    }
    .ima-tile:last-child { border-right: none; }
    .ima-tile::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
    }
    .ima-tile.blue::before   { background: #4d85f4; }
    .ima-tile.gold::before   { background: #c9943a; }
    .ima-tile.green::before  { background: #3ec870; }
    .ima-tile.red::before    { background: #d95858; }
    .ima-tile-lbl {
      font-size: 10px;
      font-weight: 600;
      color: #3d4466;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .ima-tile-val {
      font-size: 15px;
      font-weight: 700;
      line-height: 1;
    }
    .ima-tile.blue  .ima-tile-val { color: #6aa0f7; }
    .ima-tile.gold  .ima-tile-val { color: #c9943a; }
    .ima-tile.green .ima-tile-val { color: #3ec870; }
    .ima-tile.red   .ima-tile-val { color: #e06a6a; }

    /* ── Tab bar ── */
    #ima-tabs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 14px;
      background: #131620;
      border-bottom: 1px solid #1e2135;
      flex-shrink: 0;
    }
    .ima-tab {
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
      white-space: nowrap;
    }
    .ima-tab:hover  { color: #c8cde0; background: #1c1f33; border-color: #2a2f4a; }
    .ima-tab.active { background: #1c2040; border-color: #c9943a; color: #e8c37a; }

    /* ── Content area ── */
    #ima-content {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* ── Chart pane ── */
    #ima-chart-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    #ima-chart-controls {
      display: flex;
      gap: 6px;
      padding: 8px 14px;
      background: #131620;
      border-bottom: 1px solid #1e2135;
      flex-shrink: 0;
      align-items: center;
    }
    .ima-ct-btn {
      background: transparent;
      border: 1px solid #2a2f4a;
      color: #4a5270;
      padding: 4px 14px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .ima-ct-btn:hover  { border-color: #c9943a; color: #c8cde0; }
    .ima-ct-btn.active { background: #1c2040; border-color: #c9943a; color: #e8c37a; }
    #ima-chart-area {
      flex: 1;
      min-height: 0;
      position: relative;
      padding: 10px 14px 12px;
    }
    #ima-price-chart {
      width: 100% !important;
      height: 100% !important;
    }
    #ima-chart-status {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      color: #4a5270;
      font-size: 13px;
      background: transparent;
      pointer-events: none;
    }
    #ima-chart-status.hidden { display: none; }

    /* ── Table pane ── */
    #ima-table-pane {
      height: 100%;
      overflow-y: auto;
      overflow-x: auto;
      display: none;
    }

    /* ── Best items sidebar ── */
    #ima-best-sidebar {
      position: absolute;
      top: 0;
      right: -420px;
      bottom: 0;
      width: 400px;
      background: #1a1d2e;
      border-left: 2px solid #c9943a;
      box-shadow: -8px 0 28px rgba(0,0,0,0.55);
      transition: right 0.28s cubic-bezier(.4,0,.2,1);
      z-index: 10;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #ima-best-sidebar.visible { right: 0; }
    #ima-best-sidebar-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: linear-gradient(90deg, #1a1c2b 0%, #1d2035 100%);
      border-bottom: 1px solid #222540;
      flex-shrink: 0;
    }
    #ima-best-sidebar-hdr span {
      font-size: 13px;
      font-weight: 700;
      color: #e8c37a;
    }
    #ima-best-sidebar-close {
      background: #1f2340;
      border: 1px solid #2e3452;
      color: #4a5270;
      font-size: 14px;
      cursor: pointer;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    #ima-best-sidebar-close:hover { background: #2e3452; color: #c8cde0; }
    #ima-best-sidebar-body {
      padding: 10px 14px;
      flex: 1;
      overflow-y: auto;
    }

    /* ── Best items toggle btn ── */
    #ima-best-btn {
      margin-left: auto;
      background: transparent;
      color: #3d4466;
      border: 1px solid #1e2135;
      padding: 4px 12px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
      white-space: nowrap;
    }
    #ima-best-btn:hover  { color: #c8cde0; border-color: #2a2f4a; }
    #ima-best-btn.active { background: rgba(201,148,58,0.12); border-color: #c9943a; color: #e8c37a; }

    .ima-best-hdr {
      display: grid;
      grid-template-columns: 1fr 110px 110px 80px;
      gap: 8px;
      padding: 6px 10px;
      font-size: 10px;
      font-weight: 700;
      color: #3d4466;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #1e2135;
      margin-bottom: 4px;
    }
    .ima-best-row {
      display: grid;
      grid-template-columns: 1fr 110px 110px 80px;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.12s;
      border-bottom: 1px solid #1a1d2e;
      align-items: center;
    }
    .ima-best-row:hover { background: #1a1d2e; }
    .ima-best-name  { font-size: 12px; color: #c8cde0; font-weight: 500; }
    .ima-best-id    { font-size: 10px; color: #4a5270; margin-top: 2px; }
    .ima-best-price { font-size: 12px; color: #c9943a; font-weight: 600; text-align: right; }
    .ima-best-profit{ font-size: 12px; color: #3ec870; font-weight: 600; text-align: right; }
    .ima-best-marg  { font-size: 12px; color: #6aa0f7; font-weight: 600; text-align: right; }
    #ima-best-status {
      text-align: center;
      color: #4a5270;
      padding: 40px 0;
      font-size: 13px;
    }
    /* Compact grid for sidebar context */
    #ima-best-sidebar .ima-best-hdr,
    #ima-best-sidebar .ima-best-row {
      grid-template-columns: 1fr 85px 80px 60px;
    }

    /* ── Calculator sidebar ── */
    #ima-calc-sidebar {
      position: absolute;
      top: 0;
      right: -340px;
      bottom: 0;
      width: 320px;
      background: #1a1d2e;
      border-left: 2px solid #c9943a;
      box-shadow: -8px 0 28px rgba(0,0,0,0.55);
      transition: right 0.28s cubic-bezier(.4,0,.2,1);
      z-index: 10;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #ima-calc-sidebar.visible { right: 0; }
    #ima-calc-sidebar-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: linear-gradient(90deg, #1a1c2b 0%, #1d2035 100%);
      border-bottom: 1px solid #222540;
      flex-shrink: 0;
    }
    #ima-calc-sidebar-hdr span {
      font-size: 13px;
      font-weight: 700;
      color: #e8c37a;
    }
    #ima-calc-sidebar-close {
      background: #1f2340;
      border: 1px solid #2e3452;
      color: #4a5270;
      font-size: 14px;
      cursor: pointer;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    #ima-calc-sidebar-close:hover { background: #2e3452; color: #c8cde0; }
    #ima-calc-sidebar-body {
      padding: 16px;
      flex: 1;
      overflow-y: auto;
    }

    /* ── Calc toggle btn ── */
    #ima-calc-btn {
      background: transparent;
      color: #3d4466;
      border: 1px solid #1e2135;
      padding: 4px 12px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
      white-space: nowrap;
    }
    #ima-calc-btn:hover  { color: #c8cde0; border-color: #2a2f4a; }
    #ima-calc-btn.active { background: rgba(201,148,58,0.12); border-color: #c9943a; color: #e8c37a; }

    .ima-calc-title {
      font-size: 14px;
      font-weight: 700;
      color: #e8c37a;
      margin-bottom: 18px;
    }
    .ima-calc-grp { margin-bottom: 14px; }
    .ima-calc-lbl {
      font-size: 10px;
      font-weight: 600;
      color: #4a5270;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .ima-calc-inp {
      background: #1c1f33;
      border: 1px solid #2a2f4a;
      color: #c8cde0;
      padding: 8px 12px;
      border-radius: 5px;
      font-size: 13px;
      outline: none;
      width: 100%;
      box-sizing: border-box;
      transition: border-color 0.15s;
      font-family: 'Arial', sans-serif;
    }
    .ima-calc-inp:focus { border-color: #c9943a; }
    .ima-calc-results {
      background: #171929;
      border: 1px solid #222540;
      border-radius: 6px;
      padding: 14px;
      margin-top: 16px;
    }
    .ima-calc-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 0;
      border-bottom: 1px solid #1e2135;
      font-size: 13px;
    }
    .ima-calc-row:last-child { border-bottom: none; }
    .ima-calc-row-lbl { color: #4a5270; }
    .ima-calc-row-val { font-weight: 700; color: #c8cde0; }
    .ima-calc-row-val.profit { color: #3ec870; }
    .ima-calc-row-val.loss   { color: #e06a6a; }
    .ima-calc-note {
      font-size: 11px;
      color: #3d4466;
      margin-top: 12px;
      font-style: italic;
    }

    /* ── Shared table styles ── */
    #ima-panel table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    #ima-panel thead th {
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
    #ima-panel thead th:hover { color: #c8cde0; }
    #ima-panel thead th.r     { text-align: right; }
    #ima-panel thead th::after { content: " ↕"; font-size: 9px; opacity: .25; }
    #ima-panel thead th.s-asc::after  { content: " ↑"; opacity: 1; color: #c9943a; }
    #ima-panel thead th.s-desc::after { content: " ↓"; opacity: 1; color: #c9943a; }
    #ima-panel tbody td {
      padding: 7px 12px;
      border-bottom: 1px solid #1a1d2e;
      white-space: nowrap;
      color: #c8cde0;
    }
    #ima-panel tbody tr:hover td { background: #1a1d2e; }
    #ima-panel tbody tr:nth-child(even) td { background: #141725; }
    #ima-panel tbody tr:nth-child(even):hover td { background: #1a1d2e; }
    #ima-panel td.r     { text-align: right; }
    #ima-panel td.dim   { color: #6b7494; font-size: 11px; }
    #ima-panel td.gold  { text-align: right; color: #c9943a; font-weight: 600; }
    #ima-panel td.green { text-align: right; color: #3ec870; font-weight: 600; }
    #ima-panel td.empty { text-align: center; color: #4a5270; padding: 40px 0; font-size: 13px; }

    /* ── Spinner ── */
    .ima-spin {
      width: 28px; height: 28px;
      border: 3px solid #1e2135;
      border-top-color: #c9943a;
      border-radius: 50%;
      animation: ima-spin 0.75s linear infinite;
    }
    @keyframes ima-spin { to { transform: rotate(360deg); } }

    /* ── Scrollbar ── */
    #ima-panel ::-webkit-scrollbar { width: 5px; height: 5px; }
    #ima-panel ::-webkit-scrollbar-track { background: #12141f; }
    #ima-panel ::-webkit-scrollbar-thumb { background: #2a2f4a; border-radius: 3px; }
    #ima-panel ::-webkit-scrollbar-thumb:hover { background: #3d4466; }

    /* ── Mobile ── */
    @media (max-width: 600px) {
      #ima-panel   { width: 100vw; }
      .ima-col-id  { display: none; }
      #ima-from, #ima-to { min-width: 0; }
      .ima-best-hdr, .ima-best-row {
        grid-template-columns: 1fr 80px 60px;
      }
      .ima-best-marg-col { display: none; }
    }
  `);

  // ── Build UI ───────────────────────────────────────────────────────────────
  function buildUI() {
    const today = new Date().toISOString().slice(0, 10);

    const toggle = el('div', { id: 'ima-toggle', title: 'Item Market Analyzer' }, 'Market');
    toggle.addEventListener('click', togglePanel);

    const panel = el('div', { id: 'ima-panel' });
    panel.innerHTML = `
      <div id="ima-hdr">
        <div id="ima-hdr-icon">&#x1F4C8;</div>
        <div style="flex:1;min-width:0">
          <h2>Item Market Analyzer</h2>
          <div id="ima-hdr-sub">Torn Market Analytics</div>
        </div>
        <button id="ima-close" title="Close">&#x2715;</button>
      </div>

      <div id="ima-controls">
        <div class="ima-ctrl-row">
          <label>Item</label>
          <input id="ima-item-name" type="text" placeholder="Search item name…" autocomplete="off">
          <label>ID</label>
          <input id="ima-item-id" type="text" placeholder="—">
          <span id="ima-status"></span>
        </div>
        <div class="ima-ctrl-row">
          <button class="ima-nav" id="ima-prev" title="Previous period">&#x2039;</button>
          <label>From</label>
          <input id="ima-from" type="date" value="${today}">
          <label>To</label>
          <input id="ima-to"   type="date" value="${today}">
          <button class="ima-nav" id="ima-next" title="Next period">&#x203A;</button>
          <div id="ima-time-grp" style="display:flex;gap:4px;align-items:center">
            <label>Time</label>
            <input id="ima-time-from" type="time">
            <span style="color:#4a5270;font-size:11px">—</span>
            <input id="ima-time-to"   type="time">
          </div>
        </div>
        <div class="ima-ctrl-row">
          <label>TF</label>
          <button class="ima-tf-btn" data-tf="day">1D</button>
          <button class="ima-tf-btn" data-tf="1h">1H</button>
          <button class="ima-tf-btn" data-tf="30m">30M</button>
          <button class="ima-tf-btn active" data-tf="15m">15M</button>
          <button class="ima-tf-btn" data-tf="5m">5M</button>
          <button class="ima-tf-btn" data-tf="1m">1M</button>
          <div style="flex:1"></div>
          <button class="ima-btn" id="ima-apply">Apply</button>
          <button class="ima-btn gray" id="ima-reset">Reset</button>
          <button class="ima-btn blue" id="ima-auto-btn">&#x21BB; Auto</button>
        </div>
      </div>

      <div id="ima-summary">
        <div class="ima-tile blue">
          <div class="ima-tile-lbl">Data Points</div>
          <div class="ima-tile-val" id="ima-s-pts">—</div>
        </div>
        <div class="ima-tile gold">
          <div class="ima-tile-lbl">Avg Price</div>
          <div class="ima-tile-val" id="ima-s-avg">—</div>
        </div>
        <div class="ima-tile green">
          <div class="ima-tile-lbl">Min Price</div>
          <div class="ima-tile-val" id="ima-s-min">—</div>
        </div>
        <div class="ima-tile red">
          <div class="ima-tile-lbl">Max Price</div>
          <div class="ima-tile-val" id="ima-s-max">—</div>
        </div>
      </div>

      <div id="ima-tabs">
        <button class="ima-tab active" data-tab="chart">&#x1F4CA; Chart</button>
        <button class="ima-tab" data-tab="table">&#x1F4CB; Table</button>
        <button id="ima-best-btn">&#x2B50; Best</button>
        <button id="ima-calc-btn">&#x1F9EE; Calc</button>
      </div>

      <div id="ima-content">

        <!-- ── Chart Pane ── -->
        <div id="ima-chart-pane">
          <div id="ima-chart-controls">
            <button class="ima-ct-btn active" data-ct="line">Line</button>
            <button class="ima-ct-btn" data-ct="bar">Bar</button>
            <button class="ima-ct-btn" data-ct="scatter">Scatter</button>
          </div>
          <div id="ima-chart-area">
            <canvas id="ima-price-chart"></canvas>
            <div id="ima-chart-status">
              <span style="color:#4a5270">Enter an item name and click Apply.</span>
            </div>
          </div>
        </div>

        <!-- ── Table Pane ── -->
        <div id="ima-table-pane">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th class="ima-col-id r">ID</th>
                <th>Name</th>
                <th class="r">Avg Price</th>
                <th class="r">Price</th>
                <th class="r">Qty</th>
              </tr>
            </thead>
            <tbody id="ima-tbody">
              <tr><td colspan="6" class="empty">No data loaded.</td></tr>
            </tbody>
          </table>
        </div>

      </div>

      <!-- ── Best Items Sidebar ── -->
      <div id="ima-best-sidebar">
        <div id="ima-best-sidebar-hdr">
          <span>&#x2B50; Best Items to Buy</span>
          <button id="ima-best-sidebar-close" title="Close">&#x2715;</button>
        </div>
        <div id="ima-best-sidebar-body">
          <div class="ima-best-hdr">
            <div>Item</div>
            <div style="text-align:right">Avg Price</div>
            <div style="text-align:right">Profit</div>
            <div class="ima-best-marg-col" style="text-align:right">Margin</div>
          </div>
          <div id="ima-best-list">
            <div id="ima-best-status">Click &#x2B50; Best to load.</div>
          </div>
        </div>
      </div>

      <div id="ima-calc-sidebar">
        <div id="ima-calc-sidebar-hdr">
          <span>&#x1F9EE; Profit Calculator</span>
          <button id="ima-calc-sidebar-close" title="Close">&#x2715;</button>
        </div>
        <div id="ima-calc-sidebar-body">
          <div class="ima-calc-grp">
            <div class="ima-calc-lbl">Buy Price ($)</div>
            <input class="ima-calc-inp" id="ima-c-buy" type="number" min="0" placeholder="0" step="any">
          </div>
          <div class="ima-calc-grp">
            <div class="ima-calc-lbl">Transaction Fee (%)</div>
            <input class="ima-calc-inp" id="ima-c-fee" type="number" min="0" max="100" value="5" step="0.1">
          </div>
          <div class="ima-calc-grp">
            <div class="ima-calc-lbl">
              Target Sell Price ($)
              <span style="color:#3d4466;font-size:9px;text-transform:none;font-weight:400">&nbsp;auto = break-even</span>
            </div>
            <input class="ima-calc-inp" id="ima-c-sell" type="number" min="0" placeholder="0" step="any">
          </div>
          <div class="ima-calc-results">
            <div class="ima-calc-row">
              <span class="ima-calc-row-lbl">Fee Amount</span>
              <span class="ima-calc-row-val" id="ima-c-r-fee">$0.00</span>
            </div>
            <div class="ima-calc-row">
              <span class="ima-calc-row-lbl">Total Cost</span>
              <span class="ima-calc-row-val" id="ima-c-r-cost">$0.00</span>
            </div>
            <div class="ima-calc-row">
              <span class="ima-calc-row-lbl">Profit</span>
              <span class="ima-calc-row-val" id="ima-c-r-profit">$0.00</span>
            </div>
            <div class="ima-calc-row">
              <span class="ima-calc-row-lbl">Profit %</span>
              <span class="ima-calc-row-val" id="ima-c-r-pct">0.00%</span>
            </div>
          </div>
          <div class="ima-calc-note">Tip: Click a data point on the chart to auto-fill prices.</div>
          <div style="margin-top:16px">
            <button class="ima-btn gray" id="ima-c-reset">Reset Calculator</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    // ── Wire events ──
    panel.querySelector('#ima-close')   .addEventListener('click', togglePanel);
    panel.querySelector('#ima-apply')   .addEventListener('click', fetchData);
    panel.querySelector('#ima-reset')   .addEventListener('click', resetFilters);
    panel.querySelector('#ima-prev')    .addEventListener('click', () => shiftDates(-1));
    panel.querySelector('#ima-next')    .addEventListener('click', () => shiftDates(1));
    panel.querySelector('#ima-auto-btn').addEventListener('click', toggleAutoRefresh);
    panel.querySelector('#ima-c-reset')          .addEventListener('click', resetCalculator);
    panel.querySelector('#ima-best-btn')          .addEventListener('click', toggleBestSidebar);
    panel.querySelector('#ima-best-sidebar-close').addEventListener('click', toggleBestSidebar);
    panel.querySelector('#ima-calc-btn')          .addEventListener('click', toggleCalcSidebar);
    panel.querySelector('#ima-calc-sidebar-close').addEventListener('click', toggleCalcSidebar);

    // Tabs
    panel.querySelectorAll('.ima-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        panel.querySelectorAll('.ima-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showTab(activeTab);
        if (activeTab === 'chart' && priceChart) priceChart.resize();
      });
    });

    // Timeframe
    panel.querySelectorAll('.ima-tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.ima-tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTF = btn.dataset.tf;
        document.getElementById('ima-time-grp').style.display = currentTF === 'day' ? 'none' : 'flex';
        const hasItem = document.getElementById('ima-item-name').value.trim() ||
                        document.getElementById('ima-item-id').value.trim();
        if (hasItem) fetchData();
      });
    });

    // Chart type
    panel.querySelectorAll('.ima-ct-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.ima-ct-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentChartType = btn.dataset.ct;
        if (chartData.length) renderChart();
      });
    });

    // Table sort
    panel.querySelectorAll('#ima-table-pane thead th').forEach((th, i) => {
      th.addEventListener('click', () => sortTable(i));
    });

    // Calculator
    initCalculator();

    // Autocomplete
    initAutocomplete();
  }

  function showTab(tab) {
    document.getElementById('ima-chart-pane').style.display = tab === 'chart' ? 'flex' : 'none';
    document.getElementById('ima-table-pane').style.display = tab === 'table' ? 'block' : 'none';
  }

  function toggleBestSidebar() {
    const sidebar = document.getElementById('ima-best-sidebar');
    const btn     = document.getElementById('ima-best-btn');
    const visible = sidebar.classList.toggle('visible');
    btn.classList.toggle('active', visible);
    // close calc if open
    if (visible) {
      document.getElementById('ima-calc-sidebar').classList.remove('visible');
      document.getElementById('ima-calc-btn').classList.remove('active');
    }
    if (visible) fetchBestItems();
  }

  function toggleCalcSidebar() {
    const sidebar = document.getElementById('ima-calc-sidebar');
    const btn     = document.getElementById('ima-calc-btn');
    const visible = sidebar.classList.toggle('visible');
    btn.classList.toggle('active', visible);
    // close best if open
    if (visible) {
      document.getElementById('ima-best-sidebar').classList.remove('visible');
      document.getElementById('ima-best-btn').classList.remove('active');
    }
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    document.getElementById('ima-panel') .classList.toggle('open', panelOpen);
    document.getElementById('ima-toggle').classList.toggle('open', panelOpen);
  }

  // ── Autocomplete ───────────────────────────────────────────────────────────
  function initAutocomplete() {
    // Portal element appended to body so it escapes panel overflow:hidden
    const portal = el('div', { id: 'ima-ac-portal' });
    document.body.appendChild(portal);

    const input = document.getElementById('ima-item-name');
    let acFocus = -1;

    function positionPortal() {
      const r = input.getBoundingClientRect();
      portal.style.top   = r.bottom + 'px';
      portal.style.left  = r.left   + 'px';
      portal.style.width = r.width  + 'px';
    }

    function showAC(matches) {
      if (!matches.length) { closeAC(); return; }
      acFocus = -1;
      portal.innerHTML = matches.map(m =>
        `<div class="ima-ac-item">${esc(m)}</div>`
      ).join('');
      portal.style.display = 'block';
      positionPortal();
      portal.querySelectorAll('.ima-ac-item').forEach(item => {
        item.addEventListener('mousedown', e => { e.preventDefault(); selectItem(item.textContent); });
      });
    }

    function closeAC() {
      portal.style.display = 'none';
      portal.innerHTML = '';
      acFocus = -1;
    }

    function selectItem(name) {
      input.value = name;
      const id = itemMappings[name];
      if (id) document.getElementById('ima-item-id').value = id;
      closeAC();
    }

    function updateACFocus(items) {
      items.forEach((item, i) => item.classList.toggle('active', i === acFocus));
      if (acFocus >= 0) items[acFocus].scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (!val) { closeAC(); return; }
      const matches = itemNames.filter(n => n.toLowerCase().includes(val.toLowerCase())).slice(0, 35);
      showAC(matches);
    });

    input.addEventListener('keydown', e => {
      const items = portal.querySelectorAll('.ima-ac-item');
      if (!items.length) return;
      if      (e.key === 'ArrowDown')  { acFocus = Math.min(acFocus + 1, items.length - 1); updateACFocus(items); e.preventDefault(); }
      else if (e.key === 'ArrowUp')    { acFocus = Math.max(acFocus - 1, 0);                updateACFocus(items); e.preventDefault(); }
      else if (e.key === 'Enter' && acFocus >= 0) { selectItem(items[acFocus].textContent); e.preventDefault(); }
      else if (e.key === 'Escape')     { closeAC(); }
    });

    input.addEventListener('blur', () => {
      setTimeout(closeAC, 200);
      const name = input.value.trim();
      if (itemMappings[name]) document.getElementById('ima-item-id').value = itemMappings[name];
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#ima-item-name') && !e.target.closest('#ima-ac-portal')) closeAC();
    });

    window.addEventListener('resize', () => {
      if (portal.style.display !== 'none') positionPortal();
    });

    // Pre-fetch item list
    gmFetch(`${GAS_URL}?endpoint=unique_item_market_name?select=name,item_id`).then(data => {
      data.forEach(item => { itemMappings[item.name] = item.item_id; });
      itemNames = [...new Set(data.map(e => e.name))];
    }).catch(() => {});
  }

  // ── API ────────────────────────────────────────────────────────────────────
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:    'GET',
        url,
        timeout:   30 * 60 * 1000,
        onload:    r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch(e) { reject(new Error('Invalid JSON')); }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  function buildQueryParams(params) {
    return params.map(p => `${p.field}=${p.operator}.${encodeURIComponent(p.value)}`).join('&');
  }

  // ── Fetch Data ─────────────────────────────────────────────────────────────
  async function fetchData() {
    const itemName = document.getElementById('ima-item-name').value.trim();
    const itemId   = document.getElementById('ima-item-id').value.trim();

    if (!itemName && !itemId) {
      setStatus('Enter an item name or ID.', 'err');
      return;
    }

    setStatus('Loading…');
    showChartStatus(`<div class="ima-spin"></div><span>Loading market data…</span>`);

    const fromVal = document.getElementById('ima-from').value;
    const toVal   = document.getElementById('ima-to').value;

    const startDate = new Date(fromVal || new Date().toISOString().slice(0, 10));
    let   endDate   = new Date(toVal   || new Date().toISOString().slice(0, 10));

    // Add 1 day to endDate to include the entire end day (timezone buffer)
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    if (currentTF !== 'day') {
      const fromTime = document.getElementById('ima-time-from').value;
      const toTime   = document.getElementById('ima-time-to').value;
      if (fromTime) {
        const [h, m] = fromTime.split(':').map(Number);
        startDate.setUTCHours(h, m, 0, 0);
      } else {
        startDate.setUTCHours(0, 0, 0, 0);
      }
      if (toTime) {
        const [h, m] = toTime.split(':').map(Number);
        endDate.setUTCHours(h, m, 59, 999);
      } else {
        endDate.setUTCHours(23, 59, 59, 999);
      }
    } else {
      startDate.setUTCHours(0, 0, 0, 0);
      endDate.setUTCHours(23, 59, 59, 999);
    }

    const params = [
      { field: 'createddate', operator: 'gte', value: startDate.toISOString() },
      { field: 'createddate', operator: 'lte', value: endDate.toISOString() },
    ];
    if (itemName) params.push({ field: 'name',    operator: 'eq', value: itemName });
    if (itemId)   params.push({ field: 'item_id', operator: 'eq', value: parseInt(itemId) });

    const endpoint = TF_ENDPOINT[currentTF] || 'item_market_day';
    const url = `${GAS_URL}?endpoint=${endpoint}&${buildQueryParams(params)}`;

    try {
      const data = await gmFetch(url);
      chartData = data;
      tableData = [...data];

      if (!data.length) {
        showChartStatus('<span>No data found. Try adjusting the filters.</span>');
        updateSummary([]);
        setStatus('No data found.', 'err');
        if (priceChart) { priceChart.destroy(); priceChart = null; }
      } else {
        hideChartStatus();
        updateSummary(data);
        setStatus(`${data.length.toLocaleString()} records`, 'ok');
        renderChart();
        renderTable();
      }
    } catch(e) {
      showChartStatus(`<span style="color:#d95858">Error: ${esc(e.message)}</span>`);
      setStatus('Error: ' + e.message, 'err');
    }
  }

  // ── Chart ──────────────────────────────────────────────────────────────────
  function renderChart() {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (!chartData.length) return;

    const sorted = [...chartData].sort((a, b) => new Date(a.createddate) - new Date(b.createddate));
    const labels = sorted.map(d => {
      const dt = new Date(d.createddate);
      return `${dt.getUTCMonth()+1}/${dt.getUTCDate()} ${dt.getUTCHours()}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
    });

    const isBar     = currentChartType === 'bar';
    const isScatter = currentChartType === 'scatter';

    const mkDataset = (label, field, color) => ({
      label,
      data: sorted.map(d => ({ x: new Date(d.createddate), y: +d[field], z: d.quantity })),
      backgroundColor: isBar
        ? color.replace('1)', '0.65)')
        : color.replace('1)', '0.18)'),
      borderColor: color,
      borderWidth: isScatter ? 1 : 2,
      pointRadius: isScatter ? 5 : 3,
      pointHoverRadius: 6,
      tension: (!isBar && !isScatter) ? 0.1 : 0,
      fill: (!isBar && !isScatter),
      showLine: !isScatter,
    });

    const itemLabel = sorted[0]?.name || 'Item';
    const ctx = document.getElementById('ima-price-chart').getContext('2d');

    priceChart = new Chart(ctx, {
      type: currentChartType === 'scatter' ? 'scatter' : currentChartType,
      data: {
        labels: isScatter ? [] : labels,
        datasets: [
          mkDataset(`${itemLabel} Price`,     'price',         'rgba(255,126,95,1)'),
          mkDataset(`${itemLabel} Avg Price`,  'average_price', 'rgba(77,133,244,1)'),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        plugins: {
          legend: {
            labels: { color: '#c8cde0', font: { size: 11 }, padding: 16 },
          },
          tooltip: {
            backgroundColor: 'rgba(26,29,46,0.97)',
            titleColor: '#ff7e5f',
            bodyColor: '#c8cde0',
            borderColor: 'rgba(255,126,95,0.5)',
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: ctx => {
                const price = `$${(+ctx.parsed.y).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                const z = ctx.raw?.z;
                return z != null
                  ? [`Price: ${price}`, `Qty: ${z}`]
                  : `Price: ${price}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: isScatter ? 'time' : 'category',
            grid:  { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: '#4a5270', maxRotation: 45, autoSkip: true, maxTicksLimit: 10, font: { size: 10 } },
          },
          y: {
            beginAtZero: false,
            grid:  { color: 'rgba(255,255,255,0.06)' },
            ticks: {
              color: '#4a5270',
              font:  { size: 10 },
              callback: v => '$' + Number(v).toLocaleString(),
            },
            title: { display: true, text: 'Price ($)', color: '#4a5270', font: { size: 11 } },
          },
        },
        interaction: { intersect: false, mode: 'nearest' },
        onClick: (e, elements) => {
          if (!elements.length) return;
          const idx  = elements[0].index;
          const data = sorted[idx];
          if (data?.price) autoFillCalculator(+data.price);
        },
      },
    });
  }

  function autoFillCalculator(price) {
    const buyEl  = document.getElementById('ima-c-buy');
    const sellEl = document.getElementById('ima-c-sell');
    const sell   = parseFloat(sellEl.value) || 0;
    const buy    = parseFloat(buyEl.value)  || 0;

    let bothFilled = false;
    if (sell && buy) {
      if (price > sell)      sellEl.value = price;
      else if (price < buy)  buyEl.value  = price;
      else                   buyEl.value  = price;
      bothFilled = true;
    } else if (!sell && buy) {
      if (price > buy) sellEl.value = price;
      else { sellEl.value = buy; buyEl.value = price; }
      bothFilled = true;
    } else {
      buyEl.value = price; // first click — buy only, sidebar stays closed
    }
    autoCalc = false;
    calcResults();

    // Open sidebar only once both buy and sell are set
    if (bothFilled) {
      const sidebar = document.getElementById('ima-calc-sidebar');
      if (!sidebar.classList.contains('visible')) toggleCalcSidebar();
    }
  }

  // ── Table ──────────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = document.getElementById('ima-tbody');
    if (!tableData.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No data found.</td></tr>';
      return;
    }
    tbody.innerHTML = tableData.map(d => {
      const dt = new Date(d.createddate);
      const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')} `
               + `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
      const avg = (+d.average_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const pr  = (+d.price).toLocaleString(undefined,         { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `<tr>
        <td class="dim">${ds}</td>
        <td class="ima-col-id r dim">${d.item_id}</td>
        <td>${esc(d.name)}</td>
        <td class="gold">$${avg}</td>
        <td class="r">$${pr}</td>
        <td class="r">${d.quantity ?? 1}</td>
      </tr>`;
    }).join('');
  }

  function sortTable(col) {
    const ths = document.querySelectorAll('#ima-table-pane thead th');
    const dir = (sortState.col === col && sortState.dir === 'asc') ? 'desc' : 'asc';
    sortState = { col, dir };
    ths.forEach(th => th.classList.remove('s-asc', 's-desc'));
    ths[col].classList.add(dir === 'asc' ? 's-asc' : 's-desc');

    tableData.sort((a, b) => {
      let av, bv;
      switch (col) {
        case 0: av = new Date(a.createddate);      bv = new Date(b.createddate);      break;
        case 1: av = +(a.item_id || 0);            bv = +(b.item_id || 0);            break;
        case 2: av = (a.name||'').toLowerCase();   bv = (b.name||'').toLowerCase();   break;
        case 3: av = +(a.average_price || 0);      bv = +(b.average_price || 0);      break;
        case 4: av = +(a.price || 0);              bv = +(b.price || 0);              break;
        case 5: av = +(a.quantity ?? 1);           bv = +(b.quantity ?? 1);           break;
        default: return 0;
      }
      return dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
    renderTable();
  }

  // ── Best Items ─────────────────────────────────────────────────────────────
  async function fetchBestItems() {
    if (bestLoaded) return;
    const list = document.getElementById('ima-best-list');
    list.innerHTML = `<div id="ima-best-status"><div class="ima-spin" style="margin:0 auto 10px"></div>Loading best items…</div>`;

    try {
      const data = await gmFetch(`${GAS_URL}?endpoint=best_items_to_buy`);
      bestLoaded = true;

      if (!data.length) {
        list.innerHTML = '<div id="ima-best-status">No profitable items found.</div>';
        return;
      }

      list.innerHTML = data.map(item => `
        <div class="ima-best-row" data-name="${esc(item.name)}" data-id="${item.item_id}">
          <div>
            <div class="ima-best-name">${esc(item.name)}</div>
            <div class="ima-best-id">ID: ${item.item_id}</div>
          </div>
          <div class="ima-best-price">${fmtNum(item.avg_actual_price_last_week)}</div>
          <div class="ima-best-profit">${fmtNum(item.margin)}</div>
          <div class="ima-best-marg ima-best-marg-col">+${item.margin_percent}%</div>
        </div>
      `).join('');

      list.querySelectorAll('.ima-best-row').forEach(row => {
        row.addEventListener('click', () => {
          document.getElementById('ima-item-name').value = row.dataset.name;
          document.getElementById('ima-item-id').value   = row.dataset.id;
          if (row.dataset.name) itemMappings[row.dataset.name] = row.dataset.id;
          // Close best sidebar, switch to chart and fetch
          document.getElementById('ima-best-sidebar').classList.remove('visible');
          document.getElementById('ima-best-btn').classList.remove('active');
          activeTab = 'chart';
          document.querySelectorAll('.ima-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'chart'));
          showTab('chart');
          fetchData();
        });
      });
    } catch(e) {
      list.innerHTML = `<div id="ima-best-status" style="color:#d95858">Error: ${esc(e.message)}</div>`;
    }
  }

  // ── Calculator ─────────────────────────────────────────────────────────────
  function initCalculator() {
    document.getElementById('ima-c-buy').addEventListener('input', () => {
      if (autoCalc) updateBreakEven();
      calcResults();
    });
    document.getElementById('ima-c-fee').addEventListener('input', () => {
      if (autoCalc) updateBreakEven();
      calcResults();
    });
    document.getElementById('ima-c-sell').addEventListener('input', () => {
      autoCalc = false;
      calcResults();
    });
    calcResults();
  }

  function updateBreakEven() {
    const buy = parseFloat(document.getElementById('ima-c-buy').value) || 0;
    const fee = parseFloat(document.getElementById('ima-c-fee').value) || 0;
    const be  = fee < 100 ? buy / (1 - fee / 100) : 0;
    document.getElementById('ima-c-sell').value = be.toFixed(2);
  }

  function calcResults() {
    const buy  = parseFloat(document.getElementById('ima-c-buy').value)  || 0;
    const fee  = parseFloat(document.getElementById('ima-c-fee').value)  || 0;
    const sell = parseFloat(document.getElementById('ima-c-sell').value) || 0;

    const feeAmt    = sell * (fee / 100);
    const totalCost = buy + feeAmt;
    const profit    = sell - totalCost;
    const pct       = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    const cls       = profit > 0 ? 'profit' : profit < 0 ? 'loss' : '';

    setCalcVal('ima-c-r-fee',    `$${feeAmt.toFixed(2)}`);
    setCalcVal('ima-c-r-cost',   `$${totalCost.toFixed(2)}`);
    setCalcVal('ima-c-r-profit', `$${profit.toFixed(2)}`,  cls);
    setCalcVal('ima-c-r-pct',    `${pct.toFixed(2)}%`,    cls);
  }

  function resetCalculator() {
    document.getElementById('ima-c-buy').value  = '';
    document.getElementById('ima-c-fee').value  = '5';
    document.getElementById('ima-c-sell').value = '';
    autoCalc = true;
    calcResults();
  }

  function setCalcVal(id, text, cls = '') {
    const e = document.getElementById(id);
    e.textContent = text;
    e.className   = 'ima-calc-row-val' + (cls ? ' ' + cls : '');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  function updateSummary(data) {
    if (!data.length) {
      ['ima-s-pts','ima-s-avg','ima-s-min','ima-s-max'].forEach(id => {
        document.getElementById(id).textContent = '—';
      });
      return;
    }
    const prices = data.map(d => +d.price).filter(p => p > 0);
    const avg = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;

    document.getElementById('ima-s-pts').textContent = data.length.toLocaleString();
    document.getElementById('ima-s-avg').textContent = fmt$(avg);
    document.getElementById('ima-s-min').textContent = fmt$(min);
    document.getElementById('ima-s-max').textContent = fmt$(max);
  }

  // ── Date navigation ────────────────────────────────────────────────────────
  function shiftDates(dir) {
    const fromInput = document.getElementById('ima-from');
    const toInput   = document.getElementById('ima-to');
    if (!fromInput.value || !toInput.value) return;

    const fromMs  = new Date(fromInput.value + 'T00:00:00Z').getTime();
    const toMs    = new Date(toInput.value   + 'T00:00:00Z').getTime();
    const shiftMs = (toMs - fromMs) + 86400_000;

    fromInput.value = isoDate(new Date(fromMs + dir * shiftMs));
    toInput.value   = isoDate(new Date(toMs   + dir * shiftMs));

    const hasItem = document.getElementById('ima-item-name').value.trim() ||
                    document.getElementById('ima-item-id').value.trim();
    if (hasItem) fetchData();
  }

  // ── Auto-refresh ───────────────────────────────────────────────────────────
  function toggleAutoRefresh() {
    const btn = document.getElementById('ima-auto-btn');
    if (autoRefreshOn) {
      clearInterval(refreshTimer);
      refreshTimer  = null;
      autoRefreshOn = false;
      btn.textContent = '↻ Auto';
      btn.classList.remove('green');
    } else {
      autoRefreshOn = true;
      btn.textContent = '↻ ON';
      btn.classList.add('green');
      fetchData();
      refreshTimer = setInterval(fetchData, 60_000);
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  function resetFilters() {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('ima-from')      .value = today;
    document.getElementById('ima-to')        .value = today;
    document.getElementById('ima-item-name') .value = '';
    document.getElementById('ima-item-id')   .value = '';
    document.getElementById('ima-time-from') .value = '';
    document.getElementById('ima-time-to')   .value = '';
    document.getElementById('ima-time-grp')  .style.display = 'flex'; // 15m is default (sub-day)

    document.querySelectorAll('.ima-tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === '15m');
    });
    currentTF = '15m';

    if (autoRefreshOn) toggleAutoRefresh();
    setStatus('');
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    chartData = [];
    tableData = [];
    updateSummary([]);
    renderTable();
    showChartStatus('<span style="color:#4a5270">Enter an item name and click Apply.</span>');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setStatus(msg, cls = '') {
    const e = document.getElementById('ima-status');
    if (e) { e.textContent = msg; e.className = cls; }
  }

  function showChartStatus(html) {
    const s = document.getElementById('ima-chart-status');
    const c = document.getElementById('ima-price-chart');
    if (s) { s.innerHTML = html; s.classList.remove('hidden'); }
    if (c) c.style.visibility = 'hidden';
  }

  function hideChartStatus() {
    const s = document.getElementById('ima-chart-status');
    const c = document.getElementById('ima-price-chart');
    if (s) s.classList.add('hidden');
    if (c) c.style.visibility = 'visible';
  }

  function fmt$(n) {
    if (!n && n !== 0) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(2);
  }

  function fmtNum(n) {
    const num = parseFloat(n) || 0;
    if (num >= 1e12) return '$' + (num / 1e12).toFixed(1) + 'T';
    if (num >= 1e9)  return '$' + (num / 1e9).toFixed(1)  + 'B';
    if (num >= 1e6)  return '$' + (num / 1e6).toFixed(1)  + 'M';
    if (num >= 1e3)  return '$' + (num / 1e3).toFixed(1)  + 'K';
    return '$' + num.toFixed(2);
  }

  function isoDate(d)  { return d.toISOString().slice(0, 10); }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  buildUI();
})();
