// ==UserScript==
// @name         Torn Item Market Analyzer
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Torn item market price history — powered by torn-imarket-tracker.gvsantiago.com
// @author       Gheric
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js
// @run-at       document-idle
// @connect      torn-imarket-tracker.gvsantiago.com
// ==/UserScript==

(function () {
  'use strict';

  const BASE_URL = 'https://torn-imarket-tracker.gvsantiago.com';

  const TF_BUCKET_MS = {
    '1m': 60000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, 'day': 86400000,
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen        = false;
  let currentTF        = '5m';
  let currentChartType = 'line';
  let currentItemId    = null;
  let rawData          = [];
  let tableData        = [];
  let priceChart       = null;
  let refreshTimer     = null;
  let autoRefreshOn    = false;
  let sortState        = { col: null, dir: 'asc' };
  let awaitingSell     = false;
  let bestLoaded       = false;

  // ── Google Fonts ───────────────────────────────────────────────────────────
  const _link = document.createElement('link');
  _link.rel  = 'stylesheet';
  _link.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500&family=JetBrains+Mono:wght@400;500&display=swap';
  document.head.appendChild(_link);

  // ── CSS ────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    :root {
      --ima-bg:       #07080f;
      --ima-glass:    rgba(255,255,255,0.035);
      --ima-border:   rgba(255,255,255,0.07);
      --ima-hover:    rgba(255,255,255,0.055);
      --ima-accent:   #6ee7f7;
      --ima-adim:     rgba(110,231,247,0.12);
      --ima-accent2:  #818cf8;
      --ima-success:  #4ade80;
      --ima-warn:     #fbbf24;
      --ima-error:    #f87171;
      --ima-text:     #e2e8f0;
      --ima-muted:    #64748b;
      --ima-dim:      #94a3b8;
      --ima-mono:     'JetBrains Mono', monospace;
      --ima-sans:     'Space Grotesk', sans-serif;
      --ima-body:     'Inter', sans-serif;
      --ima-r:        12px;
      --ima-tr:       0.2s cubic-bezier(0.4,0,0.2,1);
    }

    /* ── Toggle tab ── */
    #ima-toggle {
      position: fixed;
      right: 0;
      top: 30%;
      transform: translateY(-30%);
      background: rgba(110,231,247,0.08);
      border: 1px solid rgba(110,231,247,0.2);
      border-right: none;
      color: var(--ima-accent);
      width: 24px;
      padding: 20px 0;
      border-radius: 8px 0 0 8px;
      cursor: pointer;
      z-index: 2147483638;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font: 600 9px/1 var(--ima-mono);
      letter-spacing: 2.5px;
      text-align: center;
      user-select: none;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: background var(--ima-tr), opacity 0.2s;
      padding-right: 10px;
    }
    #ima-toggle:hover { background: rgba(110,231,247,0.14); }
    #ima-toggle.open  { opacity: 0; pointer-events: none; }

    /* ── Panel shell ── */
    #ima-panel {
      position: fixed;
      top: 0;
      right: -820px;
      width: min(800px, 100vw);
      height: 100dvh;
      background: rgba(7,8,15,0.97);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      color: var(--ima-text);
      z-index: 2147483643;
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--ima-border);
      box-shadow: -12px 0 60px rgba(0,0,0,0.8);
      transition: right 0.32s cubic-bezier(.4,0,.2,1);
      font-family: var(--ima-body);
      font-size: 13px;
      overflow: hidden;
    }
    #ima-panel.open { right: 0; }

    /* ── Header ── */
    #ima-hdr {
      padding: 14px 18px 13px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--ima-border);
      flex-shrink: 0;
      background: rgba(110,231,247,0.03);
    }
    #ima-hdr-icon {
      font-family: var(--ima-mono);
      font-size: 13px;
      color: var(--ima-accent);
      font-weight: 500;
    }
    #ima-hdr h2 {
      margin: 0;
      font-family: var(--ima-sans);
      font-size: 14px;
      font-weight: 700;
      color: var(--ima-text);
      flex: 1;
    }
    #ima-hdr-sub { font-family: var(--ima-mono); font-size: 9px; color: var(--ima-muted); letter-spacing: 0.08em; }
    #ima-close {
      background: transparent; border: 1px solid var(--ima-border);
      color: var(--ima-muted); font-size: 14px; cursor: pointer;
      width: 28px; height: 28px; border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      transition: all var(--ima-tr);
    }
    #ima-close:hover { border-color: var(--ima-accent); color: var(--ima-accent); }

    /* ── Controls ── */
    #ima-controls {
      background: rgba(255,255,255,0.015);
      border-bottom: 1px solid var(--ima-border);
      padding: 10px 14px;
      display: flex; flex-direction: column; gap: 7px;
      flex-shrink: 0;
    }
    .ima-ctrl-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
    #ima-controls label {
      font-family: var(--ima-mono); font-size: 9px; font-weight: 500;
      color: var(--ima-accent); text-transform: uppercase; letter-spacing: 0.1em;
      white-space: nowrap; flex-shrink: 0;
    }
    #ima-controls input[type="text"],
    #ima-controls input[type="date"],
    #ima-controls input[type="time"],
    #ima-controls input[type="number"] {
      background: rgba(255,255,255,0.04); border: 1px solid var(--ima-border);
      color: var(--ima-text); padding: 5px 9px; border-radius: 7px;
      font-size: 12px; font-family: var(--ima-body); outline: none;
      min-width: 0; transition: border-color var(--ima-tr);
    }
    #ima-controls input:focus { border-color: rgba(110,231,247,0.4); }
    #ima-controls input::placeholder { color: var(--ima-muted); }
    #ima-item-name  { flex: 1; min-width: 140px; max-width: 280px; }
    #ima-from, #ima-to { flex: 1; min-width: 100px; max-width: 140px; }
    #ima-time-from, #ima-time-to { width: 88px; flex-shrink: 0; }
    #ima-controls input[type="date"]::-webkit-calendar-picker-indicator,
    #ima-controls input[type="time"]::-webkit-calendar-picker-indicator {
      filter: invert(0.4) sepia(1) saturate(3) hue-rotate(160deg); cursor: pointer;
    }

    /* ── Filter collapse ── */
    #ima-date-collapse {
      max-height: 0; overflow: hidden;
      transition: max-height 0.28s cubic-bezier(0.4,0,0.2,1), padding 0.28s cubic-bezier(0.4,0,0.2,1);
      display: flex; flex-direction: column; gap: 7px; padding: 0;
    }
    #ima-date-collapse.open { max-height: 120px; padding-top: 2px; }
    #ima-date-toggle { font-size: 10px; font-family: var(--ima-mono); letter-spacing: 0.05em; }

    /* ── Status ── */
    #ima-status { font-family: var(--ima-mono); font-size: 10px; color: var(--ima-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ima-status.err { color: var(--ima-error); }
    #ima-status.ok  { color: var(--ima-success); }

    /* ── Autocomplete ── */
    #ima-ac-portal {
      position: fixed;
      background: #0f1019; border: 1px solid var(--ima-border);
      border-top: none; border-radius: 0 0 8px 8px;
      max-height: 200px; overflow-y: auto;
      z-index: 2147483647; display: none;
      box-shadow: 0 12px 32px rgba(0,0,0,0.6);
    }
    .ima-ac-item { padding: 7px 11px; font-size: 12px; color: var(--ima-text); cursor: pointer; font-family: var(--ima-body); display: flex; align-items: baseline; gap: 6px; }
    .ima-ac-item:hover, .ima-ac-item.active { background: var(--ima-hover); color: var(--ima-accent); }
    .ima-ac-id { font-family: var(--ima-mono); font-size: 10px; color: var(--ima-muted); }

    /* ── Buttons ── */
    .ima-btn {
      background: var(--ima-accent); color: #07080f;
      border: none; padding: 0 13px; border-radius: 7px;
      font-size: 11px; font-weight: 600; font-family: var(--ima-sans);
      cursor: pointer; white-space: nowrap; height: 28px;
      transition: all var(--ima-tr); flex-shrink: 0;
    }
    .ima-btn:hover    { background: #93f0ff; }
    .ima-btn:disabled { opacity: .35; cursor: not-allowed; }
    .ima-btn.ghost { background: transparent; color: var(--ima-dim); border: 1px solid var(--ima-border); }
    .ima-btn.ghost:hover { background: var(--ima-hover); color: var(--ima-text); }
    .ima-btn.active-toggle { background: var(--ima-adim); color: var(--ima-accent); border: 1px solid rgba(110,231,247,0.3); }

    .ima-nav {
      background: transparent; border: 1px solid var(--ima-border);
      color: var(--ima-muted); width: 26px; height: 28px;
      border-radius: 7px; cursor: pointer; font-size: 14px; font-weight: 700;
      display: inline-flex; align-items: center; justify-content: center;
      transition: all var(--ima-tr); flex-shrink: 0;
    }
    .ima-nav:hover { border-color: rgba(110,231,247,0.35); color: var(--ima-accent); }

    .ima-tf-btn {
      background: transparent; border: 1px solid var(--ima-border); color: var(--ima-muted);
      padding: 3px 9px; border-radius: 6px; font-size: 11px; font-family: var(--ima-mono);
      cursor: pointer; white-space: nowrap; transition: all var(--ima-tr); flex-shrink: 0;
    }
    .ima-tf-btn:hover  { border-color: rgba(110,231,247,0.35); color: var(--ima-text); }
    .ima-tf-btn.active { background: var(--ima-adim); border-color: rgba(110,231,247,0.35); color: var(--ima-accent); }

    /* ── Summary tiles ── */
    #ima-summary { display: flex; flex-shrink: 0; border-bottom: 1px solid var(--ima-border); }
    .ima-tile {
      flex: 1; padding: 10px 14px 9px;
      border-right: 1px solid var(--ima-border); position: relative;
    }
    .ima-tile:last-child { border-right: none; }
    .ima-tile-lbl { font-family: var(--ima-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ima-muted); margin-bottom: 4px; }
    .ima-tile-val { font-family: var(--ima-mono); font-size: 14px; font-weight: 500; line-height: 1; }
    .ima-tile.blue  .ima-tile-val { color: var(--ima-accent); }
    .ima-tile.gold  .ima-tile-val { color: var(--ima-warn); }
    .ima-tile.green .ima-tile-val { color: var(--ima-success); }
    .ima-tile.red   .ima-tile-val { color: var(--ima-error); }

    /* ── Tabs ── */
    #ima-tabs {
      display: flex; align-items: center; gap: 4px; padding: 8px 14px;
      border-bottom: 1px solid var(--ima-border); flex-shrink: 0;
    }
    .ima-tab {
      background: transparent; color: var(--ima-muted); border: 1px solid transparent;
      padding: 5px 14px; border-radius: 7px; font-size: 12px; font-family: var(--ima-sans);
      font-weight: 500; cursor: pointer; transition: all var(--ima-tr); white-space: nowrap;
    }
    .ima-tab:hover  { color: var(--ima-text); background: var(--ima-hover); border-color: var(--ima-border); }
    .ima-tab.active { background: var(--ima-adim); border-color: rgba(110,231,247,0.3); color: var(--ima-accent); }
    #ima-best-btn, #ima-calc-btn {
      margin-left: 4px; background: transparent; color: var(--ima-muted);
      border: 1px solid var(--ima-border); padding: 5px 12px; border-radius: 7px;
      font-size: 11px; font-family: var(--ima-sans); font-weight: 500;
      cursor: pointer; transition: all var(--ima-tr); white-space: nowrap;
    }
    #ima-best-btn:hover, #ima-calc-btn:hover { color: var(--ima-text); border-color: rgba(110,231,247,0.3); }
    #ima-best-btn.active, #ima-calc-btn.active { background: var(--ima-adim); border-color: rgba(110,231,247,0.3); color: var(--ima-accent); }
    #ima-best-btn { margin-left: auto; }

    /* ── Content area ── */
    #ima-content { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

    /* ── Chart pane ── */
    #ima-chart-pane { display: flex; flex-direction: column; height: 100%; }
    #ima-chart-controls {
      display: flex; gap: 5px; padding: 8px 14px;
      border-bottom: 1px solid var(--ima-border); flex-shrink: 0; align-items: center;
    }
    .ima-ct-btn {
      background: transparent; border: 1px solid var(--ima-border); color: var(--ima-muted);
      padding: 4px 13px; border-radius: 6px; font-size: 11px; font-family: var(--ima-sans);
      cursor: pointer; transition: all var(--ima-tr); white-space: nowrap;
    }
    .ima-ct-btn:hover  { border-color: rgba(110,231,247,0.35); color: var(--ima-text); }
    .ima-ct-btn.active { background: var(--ima-adim); border-color: rgba(110,231,247,0.35); color: var(--ima-accent); }
    #ima-chart-area { flex: 1; min-height: 0; position: relative; padding: 10px 14px 12px; }
    #ima-price-chart { width: 100% !important; height: 100% !important; }
    #ima-chart-status {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 10px; color: var(--ima-muted);
      font-size: 13px; pointer-events: none;
    }
    #ima-chart-status.hidden { display: none; }
    .ima-click-hint { font-family: var(--ima-mono); font-size: 9px; color: var(--ima-muted); text-align: center; padding: 5px 14px; border-top: 1px solid var(--ima-border); flex-shrink: 0; letter-spacing: 0.05em; }

    /* ── Table pane ── */
    #ima-table-pane { height: 100%; overflow-y: auto; overflow-x: auto; display: none; }
    #ima-panel table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #ima-panel thead th {
      background: rgba(255,255,255,0.02); color: var(--ima-muted); padding: 8px 12px;
      text-align: left; white-space: nowrap; position: sticky; top: 0; z-index: 2;
      cursor: pointer; user-select: none; font-family: var(--ima-mono); font-size: 9px;
      text-transform: uppercase; letter-spacing: 0.1em;
      border-bottom: 1px solid var(--ima-border); transition: color var(--ima-tr);
    }
    #ima-panel thead th:hover { color: var(--ima-text); }
    #ima-panel thead th.r     { text-align: right; }
    #ima-panel thead th::after { content: " ↕"; font-size: 8px; opacity: .25; }
    #ima-panel thead th.s-asc::after  { content: " ↑"; opacity: 1; color: var(--ima-accent); }
    #ima-panel thead th.s-desc::after { content: " ↓"; opacity: 1; color: var(--ima-accent); }
    #ima-panel tbody td { padding: 7px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); color: var(--ima-dim); white-space: nowrap; }
    #ima-panel tbody tr:hover td { background: var(--ima-hover); }
    #ima-panel td.r     { text-align: right; }
    #ima-panel td.mono  { font-family: var(--ima-mono); }
    #ima-panel td.acc   { text-align: right; font-family: var(--ima-mono); color: var(--ima-accent); }
    #ima-panel td.empty { text-align: center; color: var(--ima-muted); padding: 40px 0; font-size: 13px; }

    /* ── Best items drawer ── */
    #ima-best-drawer {
      position: absolute; top: 0; right: -380px; bottom: 0; width: 360px;
      background: rgba(7,8,15,0.98); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border-left: 1px solid var(--ima-border);
      box-shadow: -8px 0 32px rgba(0,0,0,0.6);
      transition: right 0.28s cubic-bezier(.4,0,.2,1);
      z-index: 10; display: flex; flex-direction: column; overflow: hidden;
    }
    #ima-best-drawer.visible { right: 0; }

    /* ── Calc drawer ── */
    #ima-calc-drawer {
      position: absolute; top: 0; right: -320px; bottom: 0; width: 300px;
      background: rgba(7,8,15,0.98); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border-left: 1px solid var(--ima-border);
      box-shadow: -8px 0 32px rgba(0,0,0,0.6);
      transition: right 0.28s cubic-bezier(.4,0,.2,1);
      z-index: 10; display: flex; flex-direction: column; overflow: hidden;
    }
    #ima-calc-drawer.visible { right: 0; }

    .ima-drawer-hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 13px 16px; border-bottom: 1px solid var(--ima-border); flex-shrink: 0;
      background: rgba(110,231,247,0.03);
    }
    .ima-drawer-title { font-family: var(--ima-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ima-accent); }
    .ima-drawer-close {
      background: transparent; border: 1px solid var(--ima-border); color: var(--ima-muted);
      font-size: 13px; cursor: pointer; width: 24px; height: 24px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center; transition: all var(--ima-tr);
    }
    .ima-drawer-close:hover { border-color: var(--ima-accent); color: var(--ima-accent); }
    .ima-drawer-body { padding: 12px 14px; flex: 1; overflow-y: auto; }

    /* ── Best items list ── */
    .ima-best-fee-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .ima-best-fee-row label { font-family: var(--ima-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ima-accent); }
    .ima-best-fee { background: rgba(255,255,255,0.04); border: 1px solid var(--ima-border); color: var(--ima-text); padding: 4px 8px; border-radius: 7px; font-size: 12px; width: 58px; outline: none; font-family: var(--ima-body); }
    .ima-best-fee:focus { border-color: rgba(110,231,247,0.4); }

    .ima-best-hdr {
      display: grid; grid-template-columns: 1fr 70px 58px 44px;
      gap: 6px; padding: 5px 8px;
      font-family: var(--ima-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--ima-muted); border-bottom: 1px solid var(--ima-border); margin-bottom: 4px;
    }
    .ima-best-hdr span:not(:first-child) { text-align: right; }
    .ima-best-row {
      display: grid; grid-template-columns: 1fr 70px 58px 44px;
      gap: 6px; padding: 7px 8px; border-radius: 8px; cursor: pointer;
      transition: background var(--ima-tr); border-bottom: 1px solid rgba(255,255,255,0.03); align-items: center;
    }
    .ima-best-row:hover { background: var(--ima-hover); }
    .ima-best-name  { font-size: 12px; color: var(--ima-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ima-best-val   { font-family: var(--ima-mono); font-size: 11px; text-align: right; }
    .ima-best-profit { color: var(--ima-success); }
    .ima-best-margin { color: var(--ima-accent); background: var(--ima-adim); border-radius: 4px; padding: 1px 5px; }
    .ima-best-margin.mid  { color: var(--ima-warn);    background: rgba(251,191,36,0.12); }
    .ima-best-margin.high { color: var(--ima-success); background: rgba(74,222,128,0.12); }
    .ima-best-conf  { border-radius: 4px; padding: 1px 4px; }
    .ima-best-conf.lo { color: var(--ima-error);   background: rgba(248,113,113,0.12); }
    .ima-best-conf.md { color: var(--ima-warn);    background: rgba(251,191,36,0.12); }
    .ima-best-conf.hi { color: var(--ima-success); background: rgba(74,222,128,0.12); }
    #ima-best-status { text-align: center; color: var(--ima-muted); padding: 40px 0; font-size: 13px; }

    /* ── Calculator ── */
    .ima-calc-grp { margin-bottom: 14px; }
    .ima-calc-lbl { font-family: var(--ima-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ima-muted); margin-bottom: 5px; }
    .ima-calc-inp {
      background: rgba(255,255,255,0.04); border: 1px solid var(--ima-border); color: var(--ima-text);
      padding: 8px 11px; border-radius: 8px; font-size: 13px; font-family: var(--ima-body);
      outline: none; width: 100%; box-sizing: border-box; transition: border-color var(--ima-tr);
    }
    .ima-calc-inp:focus { border-color: rgba(110,231,247,0.4); }
    .ima-calc-results { background: rgba(255,255,255,0.02); border: 1px solid var(--ima-border); border-radius: 10px; padding: 12px; margin-top: 14px; }
    .ima-calc-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
    .ima-calc-row:last-child { border-bottom: none; }
    .ima-calc-row-lbl { color: var(--ima-muted); font-size: 12px; }
    .ima-calc-row-val { font-family: var(--ima-mono); font-weight: 500; color: var(--ima-dim); }
    .ima-calc-row-val.pos { color: var(--ima-success); }
    .ima-calc-row-val.neg { color: var(--ima-error); }
    .ima-calc-hint  { font-size: 11px; color: var(--ima-muted); margin-top: 12px; }
    .ima-calc-state { font-family: var(--ima-mono); font-size: 10px; color: var(--ima-accent); margin-top: 8px; text-align: center; min-height: 16px; }

    /* ── Spinner ── */
    .ima-spin { width: 26px; height: 26px; border: 2px solid var(--ima-border); border-top-color: var(--ima-accent); border-radius: 50%; animation: ima-spin 0.7s linear infinite; }
    @keyframes ima-spin { to { transform: rotate(360deg); } }

    /* ── Scrollbar ── */
    #ima-panel ::-webkit-scrollbar { width: 4px; height: 4px; }
    #ima-panel ::-webkit-scrollbar-track { background: transparent; }
    #ima-panel ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
    #ima-ac-portal ::-webkit-scrollbar { width: 4px; }
    #ima-ac-portal ::-webkit-scrollbar-thumb { background: var(--ima-border); border-radius: 3px; }

    @media (max-width: 600px) {
      #ima-panel { width: 100vw; }
      .ima-best-hdr, .ima-best-row { grid-template-columns: 1fr 62px 50px; }
    }
  `);

  // ── Build UI ───────────────────────────────────────────────────────────────
  function buildUI() {
    const today = new Date().toISOString().slice(0, 10);

    const toggle = el('div', { id: 'ima-toggle', title: 'Item Market Analyzer' }, '>_ Market');
    toggle.addEventListener('click', togglePanel);

    const panel = el('div', { id: 'ima-panel' });
    panel.innerHTML = `
      <div id="ima-hdr">
        <span id="ima-hdr-icon">&gt;_</span>
        <div style="flex:1;min-width:0">
          <h2>Torn Item Tracker</h2>
          <div id="ima-hdr-sub">torn-imarket-tracker.gvsantiago.com</div>
        </div>
        <button id="ima-close" title="Close">&#x2715;</button>
      </div>

      <div id="ima-controls">
        <div class="ima-ctrl-row">
          <label>Item</label>
          <input id="ima-item-name" type="text" placeholder="Search item name…" autocomplete="off">
          <span id="ima-status"></span>
        </div>
        <div class="ima-ctrl-row">
          <button class="ima-btn ghost" id="ima-date-toggle">&#x2699; Date / Time</button>
          <div style="flex:1"></div>
          <button class="ima-nav" id="ima-prev" title="Previous day">&#x2039;</button>
          <button class="ima-btn" id="ima-apply" style="flex:0;padding:0 16px">Apply</button>
          <button class="ima-nav" id="ima-next" title="Next day">&#x203A;</button>
        </div>
        <div id="ima-date-collapse">
          <div class="ima-ctrl-row">
            <label>From</label>
            <input id="ima-from" type="date" value="${today}">
            <label>To</label>
            <input id="ima-to"   type="date" value="${today}">
          </div>
          <div class="ima-ctrl-row">
            <label>Time</label>
            <input id="ima-time-from" type="time" value="00:00">
            <span style="color:var(--ima-muted);font-size:11px">—</span>
            <input id="ima-time-to"   type="time" value="23:59">
            <button class="ima-btn ghost" id="ima-reset" style="margin-left:auto">Reset</button>
          </div>
        </div>
        <div class="ima-ctrl-row">
          <label>TF</label>
          <button class="ima-tf-btn" data-tf="day">1D</button>
          <button class="ima-tf-btn" data-tf="1h">1H</button>
          <button class="ima-tf-btn" data-tf="30m">30M</button>
          <button class="ima-tf-btn" data-tf="15m">15M</button>
          <button class="ima-tf-btn active" data-tf="5m">5M</button>
          <button class="ima-tf-btn" data-tf="1m">1M</button>
          <div style="flex:1"></div>
          <button class="ima-btn ghost" id="ima-auto-btn">&#x21BB; Auto</button>
        </div>
      </div>

      <div id="ima-summary">
        <div class="ima-tile blue">
          <div class="ima-tile-lbl">Points</div>
          <div class="ima-tile-val" id="ima-s-pts">—</div>
        </div>
        <div class="ima-tile gold">
          <div class="ima-tile-lbl">Avg Price</div>
          <div class="ima-tile-val" id="ima-s-avg">—</div>
        </div>
        <div class="ima-tile green">
          <div class="ima-tile-lbl">Min</div>
          <div class="ima-tile-val" id="ima-s-min">—</div>
        </div>
        <div class="ima-tile red">
          <div class="ima-tile-lbl">Max</div>
          <div class="ima-tile-val" id="ima-s-max">—</div>
        </div>
      </div>

      <div id="ima-tabs">
        <button class="ima-tab active" data-tab="chart">Chart</button>
        <button class="ima-tab" data-tab="table">Table</button>
        <button id="ima-best-btn">Best Items</button>
        <button id="ima-calc-btn">Calculator</button>
      </div>

      <div id="ima-content">
        <div id="ima-chart-pane">
          <div id="ima-chart-controls">
            <button class="ima-ct-btn active" data-ct="line">Line</button>
            <button class="ima-ct-btn" data-ct="bar">Bar</button>
            <button class="ima-ct-btn" data-ct="scatter">Scatter</button>
          </div>
          <div id="ima-chart-area">
            <canvas id="ima-price-chart"></canvas>
            <div id="ima-chart-status">
              <span>Search for an item above and click Apply</span>
            </div>
          </div>
          <div class="ima-click-hint" id="ima-click-hint" style="display:none">
            Click once → set Buy price &nbsp;·&nbsp; Click again → set Sell price &nbsp;·&nbsp; 3rd click resets
          </div>
        </div>

        <div id="ima-table-pane">
          <table>
            <thead>
              <tr>
                <th>Date (TCT)</th>
                <th>Name</th>
                <th class="r">Avg Price</th>
                <th class="r">Price</th>
                <th class="r">Qty</th>
              </tr>
            </thead>
            <tbody id="ima-tbody">
              <tr><td colspan="5" class="empty">No data loaded.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Best Items Drawer -->
      <div id="ima-best-drawer">
        <div class="ima-drawer-hdr">
          <span class="ima-drawer-title">Best Items to Buy</span>
          <button class="ima-drawer-close" id="ima-best-close">&#x2715;</button>
        </div>
        <div class="ima-drawer-body">
          <div class="ima-best-fee-row">
            <label>Fee %</label>
            <input type="number" class="ima-best-fee" id="ima-best-fee" value="5" min="0" max="100" step="0.1">
            <button class="ima-btn" id="ima-best-reload" style="font-size:10px;height:26px;padding:0 10px">Reload</button>
          </div>
          <div class="ima-best-hdr">
            <span>Item</span>
            <span>Profit</span>
            <span>Margin</span>
            <span>Conf</span>
          </div>
          <div id="ima-best-list">
            <div id="ima-best-status">Click Best Items to load.</div>
          </div>
        </div>
      </div>

      <!-- Calculator Drawer -->
      <div id="ima-calc-drawer">
        <div class="ima-drawer-hdr">
          <span class="ima-drawer-title">Profit Calculator</span>
          <button class="ima-drawer-close" id="ima-calc-close">&#x2715;</button>
        </div>
        <div class="ima-drawer-body">
          <div class="ima-calc-grp">
            <div class="ima-calc-lbl">Buy Price ($)</div>
            <input class="ima-calc-inp" id="ima-c-buy" type="number" min="0" placeholder="0" step="any">
          </div>
          <div class="ima-calc-grp">
            <div class="ima-calc-lbl">Transaction Fee (%)</div>
            <input class="ima-calc-inp" id="ima-c-fee" type="number" min="0" max="100" value="5" step="0.1">
          </div>
          <div class="ima-calc-grp">
            <div class="ima-calc-lbl">Target Sell Price ($)</div>
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
              <span class="ima-calc-row-lbl">Margin</span>
              <span class="ima-calc-row-val" id="ima-c-r-pct">0.00%</span>
            </div>
          </div>
          <div class="ima-calc-hint">Click a chart point to fill Buy, click another to fill Sell.</div>
          <div class="ima-calc-state" id="ima-calc-state"></div>
          <div style="margin-top:16px">
            <button class="ima-btn ghost" id="ima-c-reset" style="width:100%;justify-content:center">Reset</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    // Wire events
    panel.querySelector('#ima-close')       .addEventListener('click', togglePanel);
    panel.querySelector('#ima-apply')       .addEventListener('click', fetchData);
    panel.querySelector('#ima-reset')       .addEventListener('click', resetFilters);
    panel.querySelector('#ima-prev')        .addEventListener('click', () => shiftDay(-1));
    panel.querySelector('#ima-next')        .addEventListener('click', () => shiftDay(1));
    panel.querySelector('#ima-auto-btn')    .addEventListener('click', toggleAutoRefresh);
    panel.querySelector('#ima-date-toggle') .addEventListener('click', function () {
      const body = document.getElementById('ima-date-collapse');
      const open = body.classList.toggle('open');
      this.classList.toggle('active-toggle', open);
    });
    panel.querySelector('#ima-c-reset')     .addEventListener('click', resetCalculator);
    panel.querySelector('#ima-best-btn')    .addEventListener('click', toggleBestDrawer);
    panel.querySelector('#ima-best-close')  .addEventListener('click', toggleBestDrawer);
    panel.querySelector('#ima-calc-btn')    .addEventListener('click', toggleCalcDrawer);
    panel.querySelector('#ima-calc-close')  .addEventListener('click', toggleCalcDrawer);
    panel.querySelector('#ima-best-reload') .addEventListener('click', () => fetchBestItems(true));

    panel.querySelectorAll('.ima-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        panel.querySelectorAll('.ima-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showTab(activeTab);
        if (activeTab === 'chart' && priceChart) priceChart.resize();
      });
    });

    panel.querySelectorAll('.ima-tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.ima-tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTF = btn.dataset.tf;
        if (rawData.length) renderChart(rawData);
      });
    });

    panel.querySelectorAll('.ima-ct-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.ima-ct-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentChartType = btn.dataset.ct;
        if (rawData.length) renderChart(rawData);
      });
    });

    panel.querySelectorAll('#ima-table-pane thead th').forEach((th, i) => {
      th.addEventListener('click', () => sortTable(i));
    });

    initCalculator();
    initAutocomplete();
  }

  let activeTab = 'chart';
  function showTab(tab) {
    document.getElementById('ima-chart-pane').style.display = tab === 'chart' ? 'flex' : 'none';
    document.getElementById('ima-table-pane').style.display = tab === 'table' ? 'block' : 'none';
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    document.getElementById('ima-panel') .classList.toggle('open', panelOpen);
    document.getElementById('ima-toggle').classList.toggle('open', panelOpen);
  }

  function toggleBestDrawer() {
    const d = document.getElementById('ima-best-drawer');
    const b = document.getElementById('ima-best-btn');
    const v = d.classList.toggle('visible');
    b.classList.toggle('active', v);
    if (v) {
      document.getElementById('ima-calc-drawer').classList.remove('visible');
      document.getElementById('ima-calc-btn').classList.remove('active');
      fetchBestItems(false);
    }
  }

  function toggleCalcDrawer() {
    const d = document.getElementById('ima-calc-drawer');
    const b = document.getElementById('ima-calc-btn');
    const v = d.classList.toggle('visible');
    b.classList.toggle('active', v);
    if (v) {
      document.getElementById('ima-best-drawer').classList.remove('visible');
      document.getElementById('ima-best-btn').classList.remove('active');
    }
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────
  function initAutocomplete() {
    const portal = el('div', { id: 'ima-ac-portal' });
    document.body.appendChild(portal);
    const input  = document.getElementById('ima-item-name');
    let acFocus  = -1, acTimer;

    function positionPortal() {
      const r = input.getBoundingClientRect();
      portal.style.top   = r.bottom + 'px';
      portal.style.left  = r.left   + 'px';
      portal.style.width = r.width  + 'px';
    }

    function showAC(items) {
      if (!items.length) { closeAC(); return; }
      acFocus = -1;
      portal.innerHTML = items.map(item =>
        `<div class="ima-ac-item" data-id="${item.item_id}" data-name="${esc(item.name)}">
          ${esc(item.name)}<span class="ima-ac-id">#${item.item_id}</span>
        </div>`
      ).join('');
      portal.style.display = 'block';
      positionPortal();
      portal.querySelectorAll('.ima-ac-item').forEach(row => {
        row.addEventListener('mousedown', e => { e.preventDefault(); selectItem(row.dataset.id, row.dataset.name); });
      });
    }

    function closeAC() { portal.style.display = 'none'; portal.innerHTML = ''; acFocus = -1; }

    function selectItem(id, name) {
      currentItemId = parseInt(id);
      input.value   = name;
      closeAC();
      setStatus(`#${id} selected`, 'ok');
    }

    function updateACFocus(items) {
      items.forEach((item, i) => item.classList.toggle('active', i === acFocus));
      if (acFocus >= 0) items[acFocus].scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', () => {
      clearTimeout(acTimer);
      const q = input.value.trim();
      if (!q) { currentItemId = null; closeAC(); return; }
      currentItemId = null;
      acTimer = setTimeout(async () => {
        try { showAC(await apiFetch(`/api/search?q=${encodeURIComponent(q)}`)); } catch { closeAC(); }
      }, 260);
    });

    input.addEventListener('keydown', e => {
      const items = portal.querySelectorAll('.ima-ac-item');
      if (!items.length) return;
      if      (e.key === 'ArrowDown')  { acFocus = Math.min(acFocus + 1, items.length - 1); updateACFocus(items); e.preventDefault(); }
      else if (e.key === 'ArrowUp')    { acFocus = Math.max(acFocus - 1, 0);                updateACFocus(items); e.preventDefault(); }
      else if (e.key === 'Enter' && acFocus >= 0) { const r = items[acFocus]; selectItem(r.dataset.id, r.dataset.name); e.preventDefault(); }
      else if (e.key === 'Escape') closeAC();
    });

    input.addEventListener('blur', () => setTimeout(closeAC, 200));
    document.addEventListener('click', e => {
      if (!e.target.closest('#ima-item-name') && !e.target.closest('#ima-ac-portal')) closeAC();
    });
    window.addEventListener('resize', () => { if (portal.style.display !== 'none') positionPortal(); });
  }

  // ── API ───────────────────────────────────────────────────────────────────
  function apiFetch(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: BASE_URL + path, timeout: 20000,
        onload:    r => { try { resolve(JSON.parse(r.responseText)); } catch(e) { reject(new Error('Invalid JSON')); } },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  // ── Fetch Data ────────────────────────────────────────────────────────────
  async function fetchData() {
    if (!currentItemId) { setStatus('Select an item from the dropdown first.', 'err'); return; }
    setStatus('Loading…');
    showChartStatus('<div class="ima-spin"></div>');

    const fromDate = document.getElementById('ima-from').value;
    const toDate   = document.getElementById('ima-to').value;
    const fromTime = document.getElementById('ima-time-from').value || '00:00';
    const toTime   = document.getElementById('ima-time-to').value   || '23:59';

    const params = new URLSearchParams({ limit: 5000 });
    if (fromDate) params.set('from', `${fromDate}T${fromTime}:00`);
    if (toDate)   params.set('to',   `${toDate}T${toTime}:59`);

    try {
      const data = await apiFetch(`/api/market/${currentItemId}?${params}`);
      rawData = data; tableData = [...data];

      if (!data.length) {
        showChartStatus('<span>No data found — try adjusting the date range</span>');
        updateSummary([]); setStatus('No data.', 'err');
        if (priceChart) { priceChart.destroy(); priceChart = null; }
        document.getElementById('ima-click-hint').style.display = 'none';
        return;
      }

      hideChartStatus();
      updateSummary(data);
      setStatus(`${data.length.toLocaleString()} records`, 'ok');
      renderChart(data);
      renderTable();
      document.getElementById('ima-click-hint').style.display = 'block';
    } catch(e) {
      showChartStatus(`<span style="color:var(--ima-error)">${esc(e.message)}</span>`);
      setStatus('Error: ' + e.message, 'err');
    }
  }

  // ── Timeframe aggregation ─────────────────────────────────────────────────
  function aggregateByTF(rows) {
    const ms = TF_BUCKET_MS[currentTF] || 1800000;
    const buckets = new Map();
    rows.forEach(r => {
      const t = Math.floor(new Date(r.created_at).getTime() / ms) * ms;
      if (!buckets.has(t)) buckets.set(t, []);
      buckets.get(t).push(r);
    });
    return Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]).map(([t, recs]) => {
      const last = recs[recs.length - 1];
      return {
        created_at:    new Date(t).toISOString(),
        price:         Number(last.price),
        average_price: recs.reduce((s, r) => s + Number(r.average_price), 0) / recs.length,
        quantity:      Number(last.quantity),
        name:          last.name,
      };
    });
  }

  // ── Chart ─────────────────────────────────────────────────────────────────
  function renderChart(rows) {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (!rows.length) return;

    const agg   = aggregateByTF(rows);
    const isBar = currentChartType === 'bar';
    const isSc  = currentChartType === 'scatter';

    const priceData = agg.map(r => ({ x: new Date(r.created_at), y: r.price }));
    const avgData   = agg.map(r => ({ x: new Date(r.created_at), y: r.average_price }));
    const qtyData   = agg.map(r => ({ x: new Date(r.created_at), y: r.quantity }));

    priceChart = new Chart(
      document.getElementById('ima-price-chart').getContext('2d'),
      {
        type: isSc ? 'scatter' : 'line',
        data: {
          datasets: [
            {
              label: 'Lowest Offer',
              data: priceData,
              borderColor: '#6ee7f7', backgroundColor: isBar ? 'rgba(110,231,247,0.25)' : 'rgba(110,231,247,0.08)',
              borderWidth: 2, pointRadius: isSc ? 4 : 3, pointHoverRadius: 6,
              fill: !isBar && !isSc, tension: 0.3, type: isBar ? 'bar' : 'line', yAxisID: 'y',
            },
            {
              label: 'Market Avg',
              data: avgData,
              borderColor: '#818cf8', backgroundColor: 'transparent',
              borderWidth: 2, borderDash: [5, 3],
              pointRadius: isSc ? 3 : 0, pointHoverRadius: 5,
              fill: false, tension: 0.3, type: 'line', yAxisID: 'y',
            },
            {
              label: 'Quantity',
              data: qtyData,
              borderColor: 'rgba(251,191,36,0.5)', backgroundColor: 'rgba(251,191,36,0.07)',
              borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3,
              fill: 'origin', tension: 0.2, type: 'line', yAxisID: 'yQty',
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: '#94a3b8', font: { size: 11 }, padding: 14, usePointStyle: true } },
            tooltip: {
              backgroundColor: 'rgba(7,8,15,0.95)', titleColor: '#6ee7f7', bodyColor: '#e2e8f0',
              borderColor: 'rgba(110,231,247,0.2)', borderWidth: 1, padding: 10,
              callbacks: {
                label: ctx => {
                  if (ctx.dataset.label === 'Quantity') return `Qty: ${Number(ctx.parsed.y).toLocaleString()}`;
                  return `${ctx.dataset.label}: $${Number(ctx.parsed.y).toLocaleString()}`;
                },
              },
            },
          },
          scales: {
            x: { type: 'time', ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { position: 'left', ticks: { color: '#64748b', font: { size: 10 }, callback: v => '$' + Number(v).toLocaleString() }, grid: { color: 'rgba(255,255,255,0.04)' } },
            yQty: {
              position: 'right', min: 0,
              max: Math.max(...qtyData.map(p => p.y), 1) * 5,
              grid: { drawOnChartArea: false },
              ticks: { color: 'rgba(251,191,36,0.45)', maxTicksLimit: 4, callback: v => { const mx = Math.max(...qtyData.map(p => p.y), 1); return v <= mx ? Number(v).toLocaleString() : null; } },
            },
          },
          onClick: (e, elements, chart) => {
            let hits = elements;
            if (!hits.length && e.native) {
              hits = chart.getElementsAtEventForMode(e.native, 'nearest', { intersect: false }, false);
            }
            if (!hits.length) return;
            const hit = hits[0];
            if (hit.datasetIndex === 2) return;
            const price = hit.datasetIndex === 0 ? priceData[hit.index]?.y : avgData[hit.index]?.y;
            if (!price) return;
            chartClickFill(price);
          },
        },
      }
    );
  }

  // ── Calculator chart-click fill ───────────────────────────────────────────
  function chartClickFill(price) {
    const buyEl   = document.getElementById('ima-c-buy');
    const sellEl  = document.getElementById('ima-c-sell');
    const stateEl = document.getElementById('ima-calc-state');

    if (!awaitingSell) {
      buyEl.value   = price;
      sellEl.value  = '';
      awaitingSell  = true;
      stateEl.textContent = 'Buy set — click again to set Sell';
      if (!document.getElementById('ima-calc-drawer').classList.contains('visible')) toggleCalcDrawer();
    } else {
      sellEl.value  = price;
      awaitingSell  = false;
      stateEl.textContent = '';
    }
    calcResults();
  }

  // ── Table ─────────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = document.getElementById('ima-tbody');
    if (!tableData.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No data.</td></tr>'; return; }
    tbody.innerHTML = tableData.slice().reverse().slice(0, 500).map(r => {
      const dt = new Date(r.created_at);
      const ds = `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth()+1)}-${p2(dt.getUTCDate())} ${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())} TCT`;
      return `<tr>
        <td class="mono" style="color:var(--ima-muted);font-size:11px">${ds}</td>
        <td>${esc(r.name || '')}</td>
        <td class="acc">$${fmtFull(r.average_price)}</td>
        <td class="mono r">$${fmtFull(r.price)}</td>
        <td class="r">${r.quantity ?? 1}</td>
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
      switch(col) {
        case 0: av = new Date(a.created_at); bv = new Date(b.created_at); break;
        case 1: av = (a.name||'').toLowerCase(); bv = (b.name||'').toLowerCase(); break;
        case 2: av = +a.average_price; bv = +b.average_price; break;
        case 3: av = +a.price; bv = +b.price; break;
        case 4: av = +(a.quantity||1); bv = +(b.quantity||1); break;
        default: return 0;
      }
      return dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
    renderTable();
  }

  // ── Best Items ────────────────────────────────────────────────────────────
  async function fetchBestItems(force) {
    if (bestLoaded && !force) return;
    const list = document.getElementById('ima-best-list');
    list.innerHTML = '<div id="ima-best-status"><div class="ima-spin" style="margin:0 auto 10px"></div></div>';
    bestLoaded = false;

    try {
      const fee  = parseFloat(document.getElementById('ima-best-fee').value) || 5;
      const data = await apiFetch(`/api/best-items?fee=${fee}`);
      bestLoaded = true;

      if (!data.length) { list.innerHTML = '<div id="ima-best-status">No profitable items found yet.</div>'; return; }

      list.innerHTML = data.map(item => {
        const m = Number(item.margin_pct);
        const c = Number(item.confidence_pct);
        const mCls = m >= 15 ? 'high' : m >= 5 ? 'mid' : '';
        const cCls = c >= 80 ? 'hi'   : c >= 50 ? 'md'  : 'lo';
        return `
          <div class="ima-best-row" data-id="${item.item_id}" data-name="${esc(item.name)}">
            <span class="ima-best-name" title="${esc(item.name)}">${esc(item.name)}</span>
            <span class="ima-best-val ima-best-profit">${fmt$(item.net_profit)}</span>
            <span class="ima-best-val ima-best-margin ${mCls}">+${m}%</span>
            <span class="ima-best-val ima-best-conf ${cCls}">${c}%</span>
          </div>`;
      }).join('');

      list.querySelectorAll('.ima-best-row').forEach(row => {
        row.addEventListener('click', () => {
          currentItemId = parseInt(row.dataset.id);
          document.getElementById('ima-item-name').value = row.dataset.name;
          document.getElementById('ima-best-drawer').classList.remove('visible');
          document.getElementById('ima-best-btn').classList.remove('active');
          activeTab = 'chart';
          document.querySelectorAll('.ima-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'chart'));
          showTab('chart');
          fetchData();
        });
      });
    } catch(e) {
      list.innerHTML = `<div id="ima-best-status" style="color:var(--ima-error)">${esc(e.message)}</div>`;
    }
  }

  // ── Calculator ────────────────────────────────────────────────────────────
  function initCalculator() {
    document.getElementById('ima-c-buy') .addEventListener('input', calcResults);
    document.getElementById('ima-c-fee') .addEventListener('input', calcResults);
    document.getElementById('ima-c-sell').addEventListener('input', () => { awaitingSell = false; calcResults(); });
    calcResults();
  }

  function calcResults() {
    const buy  = parseFloat(document.getElementById('ima-c-buy').value)  || 0;
    const fee  = parseFloat(document.getElementById('ima-c-fee').value)  || 0;
    const sell = parseFloat(document.getElementById('ima-c-sell').value) || 0;
    const feeAmt    = sell * (fee / 100);
    const totalCost = buy + feeAmt;
    const profit    = sell - totalCost;
    const pct       = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    const cls       = profit > 0 ? 'pos' : profit < 0 ? 'neg' : '';
    setCalcVal('ima-c-r-fee',    `$${fmtFull(feeAmt)}`);
    setCalcVal('ima-c-r-cost',   `$${fmtFull(totalCost)}`);
    setCalcVal('ima-c-r-profit', `$${fmtFull(profit)}`, cls);
    setCalcVal('ima-c-r-pct',    `${pct.toFixed(2)}%`,  cls);
  }

  function resetCalculator() {
    awaitingSell = false;
    ['ima-c-buy','ima-c-sell'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('ima-c-fee').value = '5';
    document.getElementById('ima-calc-state').textContent = '';
    calcResults();
  }

  function setCalcVal(id, text, cls = '') {
    const e = document.getElementById(id);
    e.textContent = text;
    e.className   = 'ima-calc-row-val' + (cls ? ' ' + cls : '');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  function updateSummary(data) {
    const ids = ['ima-s-pts','ima-s-avg','ima-s-min','ima-s-max'];
    if (!data.length) { ids.forEach(id => document.getElementById(id).textContent = '—'); return; }
    const prices = data.map(d => +d.price).filter(p => p > 0);
    const avg = prices.reduce((s, p) => s + p, 0) / (prices.length || 1);
    document.getElementById('ima-s-pts').textContent = data.length.toLocaleString();
    document.getElementById('ima-s-avg').textContent = fmt$(avg);
    document.getElementById('ima-s-min').textContent = fmt$(Math.min(...prices));
    document.getElementById('ima-s-max').textContent = fmt$(Math.max(...prices));
  }

  // ── Date navigation ───────────────────────────────────────────────────────
  function shiftDay(dir) {
    const fromEl = document.getElementById('ima-from');
    const toEl   = document.getElementById('ima-to');
    const shift  = ms => new Date(ms + dir * 86400000).toISOString().slice(0, 10);
    fromEl.value = shift(new Date(fromEl.value + 'T00:00:00Z').getTime());
    toEl.value   = shift(new Date(toEl.value   + 'T00:00:00Z').getTime());
    if (currentItemId) fetchData();
  }

  // ── Auto-refresh ──────────────────────────────────────────────────────────
  function toggleAutoRefresh() {
    const btn = document.getElementById('ima-auto-btn');
    if (autoRefreshOn) {
      clearInterval(refreshTimer); refreshTimer = null; autoRefreshOn = false;
      btn.textContent = '↻ Auto'; btn.classList.remove('active-toggle');
    } else {
      autoRefreshOn = true; btn.textContent = '↻ On'; btn.classList.add('active-toggle');
      fetchData(); refreshTimer = setInterval(fetchData, 60000);
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  function resetFilters() {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('ima-from')     .value = today;
    document.getElementById('ima-to')       .value = today;
    document.getElementById('ima-item-name').value = '';
    document.getElementById('ima-time-from').value = '00:00';
    document.getElementById('ima-time-to')  .value = '23:59';
    currentItemId = null;
    document.querySelectorAll('.ima-tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === '5m'));
    currentTF = '5m';
    if (autoRefreshOn) toggleAutoRefresh();
    setStatus('');
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    rawData = []; tableData = [];
    updateSummary([]);
    renderTable();
    showChartStatus('<span>Search for an item above and click Apply</span>');
    document.getElementById('ima-click-hint').style.display = 'none';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
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
    const v = Math.abs(n), sg = n < 0 ? '-' : '';
    if (v >= 1e9) return sg + '$' + (v/1e9).toFixed(2) + 'B';
    if (v >= 1e6) return sg + '$' + (v/1e6).toFixed(2) + 'M';
    if (v >= 1e3) return sg + '$' + (v/1e3).toFixed(1) + 'K';
    return sg + '$' + v.toFixed(2);
  }
  function fmtFull(n) { return Number(n||0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  buildUI();
})();
