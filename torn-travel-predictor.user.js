// ==UserScript==
// @name         Torn Travel Predictor
// @namespace    https://www.torn.com/
// @version      1.0.0
// @description  Learns stock patterns and predicts optimal departure time for buying Xanax in Japan
// @author       Gheric
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      yata.yt
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // MODULE: Config
    // ============================================================

    const Config = Object.freeze({
        country:               'Japan',
        item:                  'Xanax',
        travelMinutes:         158,            // Japan via Airstrip
        pollIntervalMs:        30_000,         // 30 seconds
        historyRetentionDays:  3,
        apiUrl:                'https://yata.yt/api/v1/travel/export/',
        minCyclesForPrediction: 3,
        arrivalBufferSeconds:  300,            // Aim to arrive 5 min after restock
        predictionWindowCount: 12,             // Future restock windows to evaluate
    });

    // ============================================================
    // MODULE: Utils
    // ============================================================

    const Utils = (() => {
        const now = () => Math.floor(Date.now() / 1000);

        const formatTime = (ts) => {
            if (!ts) return '—';
            return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        };

        const formatDuration = (secs) => {
            if (secs == null || secs < 0) return '—';
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = Math.floor(secs % 60);
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        };

        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

        const mean = (arr) =>
            arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

        const median = (arr) => {
            if (!arr.length) return 0;
            const s = [...arr].sort((a, b) => a - b);
            const m = Math.floor(s.length / 2);
            return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        };

        const stdDev = (arr) => {
            if (arr.length < 2) return 0;
            const m = mean(arr);
            return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1));
        };

        const percentile = (arr, p) => {
            if (!arr.length) return 0;
            const s = [...arr].sort((a, b) => a - b);
            const i = (p / 100) * (s.length - 1);
            const lo = Math.floor(i), hi = Math.ceil(i);
            return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
        };

        // Abramowitz & Stegun error function approximation (max error 1.5e-7)
        const erf = (x) => {
            const sgn = x < 0 ? -1 : 1;
            x = Math.abs(x);
            const t = 1 / (1 + 0.3275911 * x);
            const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                            - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
            return sgn * y;
        };

        // P(X ≤ x) for X ~ Normal(mu, sigma)
        const normalCDF = (mu, sigma, x) => {
            if (sigma <= 0) return x >= mu ? 1 : 0;
            return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
        };

        return { now, formatTime, formatDuration, clamp, mean, median, stdDev, percentile, normalCDF };
    })();

    // ============================================================
    // MODULE: Storage (IndexedDB)
    // ============================================================

    class Storage {
        constructor() {
            this.db = null;
        }

        open() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open('TornTravelPredictor', 1);

                req.onupgradeneeded = ({ target: { result: db } }) => {
                    const mkStore = (name, key, idxName) => {
                        if (db.objectStoreNames.contains(name)) return;
                        const s = db.createObjectStore(name, { keyPath: key });
                        if (idxName) s.createIndex(idxName, idxName, { unique: false });
                    };
                    mkStore('stockData',     'timestamp',   'timestamp');
                    mkStore('restockEvents', 'restockTime', 'restockTime');
                    mkStore('selloutEvents', 'soldOutTime', 'soldOutTime');
                    mkStore('cycles',        'restockTime', 'restockTime');

                    if (!db.objectStoreNames.contains('predictions')) {
                        const ps = db.createObjectStore('predictions', { keyPath: 'id', autoIncrement: true });
                        ps.createIndex('madeAt', 'madeAt', { unique: false });
                    }
                };

                req.onsuccess  = ({ target: { result: db } }) => { this.db = db; resolve(); };
                req.onerror    = () => reject(req.error);
            });
        }

        getAll(store) {
            return new Promise((resolve, reject) => {
                const req = this.db.transaction(store, 'readonly').objectStore(store).getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror   = () => reject(req.error);
            });
        }

        put(store, record) {
            return new Promise((resolve, reject) => {
                const req = this.db.transaction(store, 'readwrite').objectStore(store).put(record);
                req.onsuccess = () => resolve(req.result);
                req.onerror   = () => reject(req.error);
            });
        }

        // Delete all records with index value below cutoff
        pruneByIndex(store, index, cutoff) {
            return new Promise((resolve, reject) => {
                const tx  = this.db.transaction(store, 'readwrite');
                const req = tx.objectStore(store).index(index).openCursor(
                    IDBKeyRange.upperBound(cutoff, true)
                );
                req.onsuccess = ({ target: { result: cur } }) => {
                    if (!cur) return;
                    cur.delete();
                    cur.continue();
                };
                tx.oncomplete = resolve;
                tx.onerror    = () => reject(tx.error);
            });
        }

        async pruneAll() {
            const cutoff = Utils.now() - Config.historyRetentionDays * 86400;
            await this.pruneByIndex('stockData',     'timestamp',   cutoff);
            await this.pruneByIndex('restockEvents', 'restockTime', cutoff);
            await this.pruneByIndex('selloutEvents', 'soldOutTime', cutoff);
            await this.pruneByIndex('cycles',        'restockTime', cutoff);
            await this.pruneByIndex('predictions',   'madeAt',      cutoff);
        }
    }

    // ============================================================
    // MODULE: Api
    // ============================================================

    class Api {
        fetch() {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method:    'GET',
                    url:       Config.apiUrl,
                    timeout:   10000,
                    onload:    ({ responseText }) => {
                        try {
                            const raw    = JSON.parse(responseText);
                            const result = Api._extract(raw);
                            result
                                ? resolve(result)
                                : reject(new Error(`${Config.item} not found in ${Config.country}`));
                        } catch (e) {
                            reject(new Error(`Parse error: ${e.message}`));
                        }
                    },
                    onerror:   () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Request timed out')),
                });
            });
        }

        // Fuzzy country match: "Japan" matches "jap", "JAP", "Japan", etc.
        // Covers Torn's 3-letter abbreviations used by YATA ("jap", "can", "uni", ...)
        static _matchCountry(key) {
            if (!key) return false;
            const a = Config.country.toLowerCase();
            const b = String(key).toLowerCase();
            return a === b || a.startsWith(b) || b.startsWith(a);
        }

        static _matchItem(name) {
            return String(name ?? '').toLowerCase() === Config.item.toLowerCase();
        }

        // Parse the YATA travel export response.
        //
        // Actual format (confirmed from yata.json):
        //   { stocks: { "jap": { update: <unix_ts>, stocks: [ { id, name, quantity, cost } ] } },
        //     timestamp: <unix_ts> }
        //
        // Falls back to looser shapes in case the format ever changes.
        static _extract(data) {
            const ts = Utils.now;
            const mc = Api._matchCountry;
            const mi = Api._matchItem;

            const box = (item, countryTs, rootTs) => ({
                timestamp: countryTs ?? rootTs ?? ts(),
                quantity:  item.quantity ?? 0,
                cost:      item.cost ?? 0,
            });

            // ── Primary shape ──────────────────────────────────────────────
            // { stocks: { "jap": { update, stocks: [ { id, name, quantity, cost } ] } }, timestamp }
            if (data?.stocks && typeof data.stocks === 'object' && !Array.isArray(data.stocks)) {
                const cKey = Object.keys(data.stocks).find(mc);
                if (cKey) {
                    const cd = data.stocks[cKey]; // country data
                    // Items in a nested "stocks" array  ← actual YATA format
                    if (Array.isArray(cd.stocks)) {
                        const found = cd.stocks.find(i => mi(i.name));
                        if (found) return box(found, cd.update, data.timestamp);
                    }
                    // Fallback: items as object keys  { "Xanax": { quantity, cost } }
                    const iKey = Object.keys(cd).find(mi);
                    if (iKey) return box(cd[iKey], cd[iKey].update ?? cd.update, data.timestamp);
                }
            }

            // ── Shape B ────────────────────────────────────────────────────
            // { "jap": { update, stocks: [...] }, timestamp }  (no outer "stocks" wrapper)
            if (typeof data === 'object' && !Array.isArray(data)) {
                const cKey = Object.keys(data).find(k => mc(k) && typeof data[k] === 'object');
                if (cKey) {
                    const cd = data[cKey];
                    if (Array.isArray(cd.stocks)) {
                        const found = cd.stocks.find(i => mi(i.name));
                        if (found) return box(found, cd.update, data.timestamp);
                    }
                    const iKey = Object.keys(cd).find(mi);
                    if (iKey) return box(cd[iKey], cd.update, data.timestamp);
                }
            }

            // ── Shape C ────────────────────────────────────────────────────
            // Flat array of records: [ { country, name, quantity, cost, update } ]
            if (Array.isArray(data)) {
                const r = data.find(r => mc(r.country ?? r.Country) && mi(r.name ?? r.item));
                if (r) return box(r, r.update ?? r.timestamp, null);
            }

            // ── Shape D ────────────────────────────────────────────────────
            // { countries: [ { name, items: [ { name, quantity, cost } ] } ] }
            if (Array.isArray(data?.countries)) {
                const c = data.countries.find(c => mc(c.name ?? c.country));
                if (c) {
                    const items = Array.isArray(c.items) ? c.items : Object.values(c.items ?? {});
                    const found = items.find(i => mi(i.name ?? i.item));
                    if (found) return box(found, c.update, data.timestamp);
                }
            }

            console.warn('[TravelPredictor] Parse failed. Top-level keys:', Object.keys(data ?? {}));
            return null;
        }
    }

    // ============================================================
    // MODULE: History — snapshot ingestion and event detection
    // ============================================================

    class History {
        constructor(storage) {
            this.storage = storage;
            this.prev    = null;
        }

        async restore() {
            const all = await this.storage.getAll('stockData');
            if (all.length) {
                this.prev = all.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
            }
        }

        async ingest(snapshot) {
            await this.storage.put('stockData', snapshot);
            const events = {};

            if (this.prev) {
                // Restock: quantity increased
                if (snapshot.quantity > this.prev.quantity) {
                    const ev = { restockTime: snapshot.timestamp, quantity: snapshot.quantity };
                    await this.storage.put('restockEvents', ev);
                    events.restock = ev;
                }

                // Sellout: quantity dropped to zero
                if (snapshot.quantity === 0 && this.prev.quantity > 0) {
                    const ev = { soldOutTime: snapshot.timestamp };
                    await this.storage.put('selloutEvents', ev);
                    events.sellout = ev;
                }
            }

            this.prev = snapshot;
            return events;
        }
    }

    // ============================================================
    // MODULE: CycleDetector — pair restocks with sellouts into cycles
    // ============================================================

    class CycleDetector {
        constructor(storage) {
            this.storage = storage;
        }

        async buildCycles() {
            const [restocks, sellouts, existing] = await Promise.all([
                this.storage.getAll('restockEvents'),
                this.storage.getAll('selloutEvents'),
                this.storage.getAll('cycles'),
            ]);

            restocks.sort((a, b) => a.restockTime - b.restockTime);
            sellouts.sort((a, b) => a.soldOutTime - b.soldOutTime);
            const known = new Set(existing.map(c => c.restockTime));

            for (let i = 0; i < restocks.length - 1; i++) {
                const r    = restocks[i];
                const next = restocks[i + 1];
                if (known.has(r.restockTime)) continue;

                // Find the sellout between this restock and the next
                const sellout = sellouts.find(
                    s => s.soldOutTime > r.restockTime && s.soldOutTime < next.restockTime
                );

                const duration      = next.restockTime - r.restockTime;
                const stockLifetime = sellout ? sellout.soldOutTime - r.restockTime : null;

                await this.storage.put('cycles', {
                    restockTime:           r.restockTime,
                    soldOutTime:           sellout?.soldOutTime ?? null,
                    duration,
                    startingQuantity:      r.quantity,
                    stockLifetime,
                    // Units per second consumed (null if no sellout recorded)
                    averageConsumptionRate: (stockLifetime && r.quantity)
                        ? r.quantity / stockLifetime
                        : null,
                });
            }
        }
    }

    // ============================================================
    // MODULE: Statistics
    // ============================================================

    class Statistics {
        constructor(storage) {
            this.storage = storage;
            this._stats  = null;
        }

        async compute() {
            const cycles = await this.storage.getAll('cycles');
            if (cycles.length < 2) { this._stats = null; return null; }

            const intervals = cycles.map(c => c.duration).filter(Number.isFinite);
            const lifetimes = cycles.map(c => c.stockLifetime).filter(Number.isFinite);
            const rates     = cycles.map(c => c.averageConsumptionRate).filter(Number.isFinite);
            const qtys      = cycles.map(c => c.startingQuantity).filter(Number.isFinite);

            const iv = {
                mean:   Utils.mean(intervals),
                median: Utils.median(intervals),
                stdDev: Utils.stdDev(intervals),
                min:    intervals.length ? Math.min(...intervals) : 0,
                max:    intervals.length ? Math.max(...intervals) : 0,
                p95:    Utils.percentile(intervals, 95),
            };

            // Confidence: lower coefficient of variation = more predictable = higher confidence
            const cv         = iv.stdDev / (iv.mean || 1);
            const confidence = Utils.clamp(100 * (1 - cv), 10, 99);

            this._stats = {
                cycleCount:               cycles.length,
                restockInterval:          iv,
                averageStockLifetime:     Utils.mean(lifetimes),
                averageConsumptionRate:   Utils.mean(rates),
                medianConsumptionRate:    Utils.median(rates),
                maxConsumptionRate:       rates.length ? Math.max(...rates) : 0,
                minConsumptionRate:       rates.length ? Math.min(...rates) : 0,
                averageStartingQuantity:  Utils.mean(qtys),
                lifetimeStdDev:           Utils.stdDev(lifetimes),
                confidence,
            };

            return this._stats;
        }

        get() { return this._stats; }
    }

    // ============================================================
    // MODULE: Predictor
    // ============================================================

    class Predictor {
        constructor(storage, statistics) {
            this.storage    = storage;
            this.statistics = statistics;
            this._errors    = []; // Track abs prediction errors (seconds) for MAE
        }

        async getLastRestock() {
            const events = await this.storage.getAll('restockEvents');
            if (!events.length) return null;
            return events.reduce((a, b) => a.restockTime > b.restockTime ? a : b);
        }

        // Generate future predicted restock timestamps (pure in-memory, no extra DB calls)
        predictedRestockTimes(lastRestockTime, mean, count) {
            const times = [];
            let base = lastRestockTime;
            for (let i = 0; i < count; i++) {
                base += mean;
                times.push(base);
            }
            return times;
        }

        async predict() {
            const stats = this.statistics.get();
            if (!stats || stats.cycleCount < Config.minCyclesForPrediction) {
                return {
                    ready:  false,
                    reason: `Need ${Config.minCyclesForPrediction} cycles, have ${stats?.cycleCount ?? 0}`,
                };
            }

            const last = await this.getLastRestock();
            if (!last) return { ready: false, reason: 'No restock events recorded yet' };

            const now           = Utils.now();
            const { mean, stdDev } = stats.restockInterval;
            const lifetime      = stats.averageStockLifetime || mean * 0.6;

            // Step forward from last known restock to find next predicted restock
            let nextRestock = last.restockTime + mean;
            while (nextRestock < now) nextRestock += mean;

            // Degrade confidence when we're overdue (past predicted time + 1 sigma)
            const overdueSecs   = Math.max(0, now - (last.restockTime + mean));
            const confidenceMod = Math.max(0.4, 1 - overdueSecs / (stdDev || mean));
            const confidence    = Utils.clamp(stats.confidence * confidenceMod, 5, 99);

            return {
                ready:           true,
                nextRestockTime: nextRestock,
                nextSelloutTime: nextRestock + lifetime,
                lastRestockTime: last.restockTime,
                meanInterval:    mean,
                stdDevInterval:  stdDev,
                lifetime,
                confidence,
            };
        }

        async storePrediction(nextRestockTime) {
            if (!nextRestockTime) return;
            // id is omitted so IndexedDB auto-increments it
            await this.storage.put('predictions', { madeAt: Utils.now(), nextRestockTime });
        }

        // After a confirmed restock, score the most recent prediction against reality
        async evaluateAgainstActual(actualRestockTime) {
            const preds = await this.storage.getAll('predictions');
            const best  = preds
                .filter(p => p.madeAt < actualRestockTime)
                .sort((a, b) => b.madeAt - a.madeAt)[0];

            if (best?.nextRestockTime) {
                this._errors.push(Math.abs(actualRestockTime - best.nextRestockTime));
                if (this._errors.length > 30) this._errors.shift();
            }
        }

        meanAbsoluteError() {
            return this._errors.length ? Utils.mean(this._errors) : null;
        }
    }

    // ============================================================
    // MODULE: TravelPlanner
    // ============================================================

    class TravelPlanner {
        constructor(storage, statistics, predictor) {
            this.storage    = storage;
            this.statistics = statistics;
            this.predictor  = predictor;
        }

        async getBestDeparture(currentSnapshot) {
            const pred  = await this.predictor.predict();
            const stats = this.statistics.get();

            if (!pred.ready) {
                return {
                    ready:          false,
                    recommendation: `Collecting data… ${pred.reason}`,
                    confidence:     0,
                };
            }

            const now            = Utils.now();
            const travelSecs     = Config.travelMinutes * 60;
            const { mean }       = stats.restockInterval;
            const lifetime       = pred.lifetime;
            const lifetimeSigma  = stats.lifetimeStdDev || lifetime * 0.3;
            const avgQty         = stats.averageStartingQuantity || 1;
            const avgRate        = stats.averageConsumptionRate  || avgQty / (lifetime || 1);

            // Generate future restock windows from the last known restock (in-memory)
            const restockWindows = this.predictor.predictedRestockTimes(
                pred.lastRestockTime,
                mean,
                Config.predictionWindowCount
            );

            let bestScore  = -1;
            let bestResult = null;

            for (const restockTime of restockWindows) {
                // Ideal departure: arrive Config.arrivalBufferSeconds after restock
                const idealDeparture = restockTime + Config.arrivalBufferSeconds - travelSecs;

                // Search ±30 minutes around ideal, 5-minute resolution
                for (let offset = -1800; offset <= 1800; offset += 300) {
                    const departureTime    = idealDeparture + offset;
                    const lag              = departureTime - now;
                    if (lag < 0) continue; // Can't depart in the past

                    const arrivalTime      = departureTime + travelSecs;
                    const secsSinceRestock = arrivalTime - restockTime;
                    if (secsSinceRestock < 0) continue; // Would arrive before the restock

                    // P(stock still available) — model stock lifetime as Normal
                    const probAvailable = 1 - Utils.normalCDF(lifetime, lifetimeSigma, secsSinceRestock);

                    // Expected remaining stock (linear depletion model)
                    const expectedQty = Math.max(0, avgQty - avgRate * secsSinceRestock);

                    // Score: probability × relative remaining stock
                    const score = probAvailable * (expectedQty / avgQty);

                    if (score > bestScore) {
                        bestScore  = score;
                        bestResult = {
                            ready:                  true,
                            leaveInSeconds:         Math.round(lag),
                            leaveAt:                departureTime,
                            arriveAt:               arrivalTime,
                            predictedRestock:       restockTime,
                            predictedSellOut:       restockTime + lifetime,
                            expectedRemainingStock: Math.round(expectedQty),
                            probAvailable,
                        };
                    }
                }
            }

            if (!bestResult) {
                return {
                    ready:          false,
                    recommendation: 'No favorable window found in next 12 h',
                    confidence:     pred.confidence,
                };
            }

            const confidence  = Math.round(pred.confidence * bestResult.probAvailable);
            const shouldLeave = bestResult.leaveInSeconds <= 120; // ≤ 2 min away

            return {
                ...bestResult,
                shouldLeave,
                confidence,
                recommendation: shouldLeave
                    ? 'Leave now!'
                    : `Leave in ${Utils.formatDuration(bestResult.leaveInSeconds)}`,
            };
        }
    }

    // ============================================================
    // MODULE: UI — floating draggable panel
    // ============================================================

    class UI {
        constructor() {
            this.panel     = null;
            this._dragging = false;
            this._offset   = { x: 0, y: 0 };
        }

        init() {
            this._injectCSS();
            this._buildPanel();
            this._bindDrag();
        }

        _injectCSS() {
            const s = document.createElement('style');
            s.textContent = `
#ttp-panel{position:fixed;top:80px;right:20px;width:295px;background:#11111e;color:#d0d0d0;
    border:1px solid #383868;border-radius:10px;padding:12px 14px;
    font:12px/1.55 'Courier New',monospace;z-index:999999;
    box-shadow:0 6px 28px rgba(0,0,0,.65);user-select:none}
#ttp-panel .hdr{display:flex;justify-content:space-between;align-items:center;
    cursor:move;border-bottom:1px solid #2b2b52;padding-bottom:8px;margin-bottom:10px}
#ttp-panel .hdr-title{font-weight:bold;color:#7eb8f7;font-size:13px;
    display:flex;align-items:center;gap:6px}
#ttp-panel .dot{width:8px;height:8px;border-radius:50%;background:#4caf50;
    display:inline-block;animation:ttp-blink 2s infinite}
#ttp-panel .btn-col{background:none;border:none;color:#666;cursor:pointer;
    font-size:14px;padding:0;line-height:1}
#ttp-panel .body.hidden{display:none}
#ttp-panel .rec{text-align:center;font-size:13px;font-weight:bold;
    background:#0a240a;border:1px solid #255025;border-radius:6px;
    padding:8px 6px;color:#4caf50;margin-bottom:4px}
#ttp-panel .rec.urgent{background:#240a0a;border-color:#7a2020;color:#ef5350;
    animation:ttp-pulse 1s infinite}
#ttp-panel .rec.idle{background:#191930;border-color:#353560;color:#888}
#ttp-panel .conf{text-align:center;color:#555;font-size:11px;margin-bottom:9px}
#ttp-panel .sec{border-top:1px solid #1c1c36;padding-top:7px;margin-top:7px}
#ttp-panel .sec-hd{color:#5080b0;font-size:10px;font-weight:bold;
    text-transform:uppercase;letter-spacing:.7px;margin-bottom:3px}
#ttp-panel .row{display:flex;justify-content:space-between;gap:8px;margin:3px 0}
#ttp-panel .lbl{color:#585878}
#ttp-panel .val{text-align:right;color:#d0d0d0}
#ttp-panel .g{color:#4caf50}
#ttp-panel .y{color:#ffa726}
#ttp-panel .r{color:#ef5350}
@keyframes ttp-blink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes ttp-pulse{0%,100%{opacity:1}50%{opacity:.6}}`;
            document.head.appendChild(s);
        }

        _buildPanel() {
            const el = document.createElement('div');
            el.id = 'ttp-panel';
            el.innerHTML = `
<div class="hdr">
  <span class="hdr-title"><span class="dot"></span>Travel Predictor</span>
  <button class="btn-col" title="Collapse">▲</button>
</div>
<div class="body">
  <div class="rec idle" id="ttp-rec">Initializing…</div>
  <div class="conf" id="ttp-conf"></div>

  <div class="sec">
    <div class="sec-hd">Current Stock · ${Config.item} (${Config.country})</div>
    <div class="row"><span class="lbl">Quantity</span>   <span class="val" id="ttp-qty">—</span></div>
    <div class="row"><span class="lbl">Cost</span>       <span class="val" id="ttp-cost">—</span></div>
    <div class="row"><span class="lbl">Last Updated</span><span class="val" id="ttp-ts">—</span></div>
  </div>

  <div class="sec">
    <div class="sec-hd">Travel Plan</div>
    <div class="row"><span class="lbl">Next Restock</span>  <span class="val" id="ttp-restock">—</span></div>
    <div class="row"><span class="lbl">Est. Sellout</span>  <span class="val" id="ttp-sellout">—</span></div>
    <div class="row"><span class="lbl">Leave At</span>      <span class="val" id="ttp-leave">—</span></div>
    <div class="row"><span class="lbl">Arrive At</span>     <span class="val" id="ttp-arrive">—</span></div>
    <div class="row"><span class="lbl">Stock at Arrival</span><span class="val" id="ttp-astock">—</span></div>
  </div>

  <div class="sec">
    <div class="sec-hd">Statistics</div>
    <div class="row"><span class="lbl">Avg Restock Interval</span><span class="val" id="ttp-avg-iv">—</span></div>
    <div class="row"><span class="lbl">Avg Stock Lifetime</span>  <span class="val" id="ttp-avg-lt">—</span></div>
    <div class="row"><span class="lbl">Cycles Collected</span>    <span class="val" id="ttp-cycles">—</span></div>
    <div class="row"><span class="lbl">Prediction Error</span>    <span class="val" id="ttp-err">—</span></div>
  </div>
</div>`;
            document.body.appendChild(el);
            this.panel = el;

            const btn  = el.querySelector('.btn-col');
            const body = el.querySelector('.body');
            btn.addEventListener('click', () => {
                const hidden = body.classList.toggle('hidden');
                btn.textContent = hidden ? '▼' : '▲';
            });
        }

        _bindDrag() {
            const hdr = this.panel.querySelector('.hdr');
            hdr.addEventListener('mousedown', (e) => {
                if (e.target.classList.contains('btn-col')) return;
                this._dragging = true;
                const r = this.panel.getBoundingClientRect();
                this._offset = { x: e.clientX - r.left, y: e.clientY - r.top };
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!this._dragging) return;
                this.panel.style.left  = `${Math.max(0, e.clientX - this._offset.x)}px`;
                this.panel.style.top   = `${Math.max(0, e.clientY - this._offset.y)}px`;
                this.panel.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => { this._dragging = false; });
        }

        _el(id) { return this.panel.querySelector(`#${id}`); }

        _set(id, text, cls = '') {
            const el = this._el(id);
            if (!el) return;
            el.textContent = text;
            el.className   = `val ${cls}`.trim();
        }

        update({ snapshot, departure, stats, predError }) {
            // Stock section
            if (snapshot) {
                const q = snapshot.quantity;
                this._set('ttp-qty',  q === 0 ? 'OUT OF STOCK' : `${q} units`,
                          q === 0 ? 'val r' : q < 5 ? 'val y' : 'val g');
                this._set('ttp-cost', snapshot.cost ? `$${snapshot.cost.toLocaleString()}` : '—');
                this._set('ttp-ts',   Utils.formatTime(snapshot.timestamp));
            }

            // Recommendation
            const rec = this._el('ttp-rec');
            if (!rec) return;

            if (departure?.ready) {
                rec.textContent = departure.recommendation;
                rec.className   = `rec${departure.shouldLeave ? ' urgent' : ''}`;
                this._set('ttp-conf',    `${departure.confidence}% confidence`);
                this._set('ttp-restock', Utils.formatTime(departure.predictedRestock));
                this._set('ttp-sellout', Utils.formatTime(departure.predictedSellOut));
                this._set('ttp-leave',   departure.shouldLeave ? 'Now' : Utils.formatTime(departure.leaveAt));
                this._set('ttp-arrive',  Utils.formatTime(departure.arriveAt));
                this._set('ttp-astock',  departure.expectedRemainingStock != null
                    ? `~${departure.expectedRemainingStock} units` : '—');
            } else if (departure) {
                rec.textContent = departure.recommendation;
                rec.className   = 'rec idle';
                this._set('ttp-conf', '');
            }

            // Statistics section
            if (stats) {
                this._set('ttp-avg-iv', Utils.formatDuration(stats.restockInterval.mean));
                this._set('ttp-avg-lt', Utils.formatDuration(stats.averageStockLifetime));
                this._set('ttp-cycles', `${stats.cycleCount} cycles`);
            }

            this._set('ttp-err', predError != null ? `±${Utils.formatDuration(predError)}` : 'Accumulating…');
        }
    }

    // ============================================================
    // MODULE: Main — orchestrates all modules
    // ============================================================

    class TravelPredictorApp {
        constructor() {
            this.storage       = new Storage();
            this.api           = new Api();
            this.history       = new History(this.storage);
            this.cycleDetector = new CycleDetector(this.storage);
            this.statistics    = new Statistics(this.storage);
            this.predictor     = new Predictor(this.storage, this.statistics);
            this.travelPlanner = new TravelPlanner(this.storage, this.statistics, this.predictor);
            this.ui            = new UI();
            this._snapshot     = null;
            this._timer        = null;
        }

        async init() {
            await this.storage.open();
            await this.history.restore();  // Reload last snapshot so event detection continues
            await this.statistics.compute();
            this.ui.init();
            await this._tick();
            this._timer = setInterval(() => this._tick(), Config.pollIntervalMs);
        }

        async _tick() {
            try {
                // Prune data older than retention window
                await this.storage.pruneAll();

                // Fetch fresh stock snapshot from YATA
                const snapshot    = await this.api.fetch();
                this._snapshot    = snapshot;

                // Detect restock / sellout events from the new snapshot
                const events      = await this.history.ingest(snapshot);

                // On confirmed restock: score past predictions for self-learning
                if (events.restock) {
                    await this.predictor.evaluateAgainstActual(events.restock.restockTime);
                }

                // Pair any new restock events with sellouts to complete cycles
                await this.cycleDetector.buildCycles();

                // Recompute statistics from all complete cycles
                await this.statistics.compute();

                // Compute best departure recommendation
                const departure   = await this.travelPlanner.getBestDeparture(snapshot);

                // Store this prediction for future self-learning evaluation
                if (departure.ready && departure.predictedRestock) {
                    await this.predictor.storePrediction(departure.predictedRestock);
                }

                this.ui.update({
                    snapshot,
                    departure,
                    stats:     this.statistics.get(),
                    predError: this.predictor.meanAbsoluteError(),
                });

            } catch (err) {
                console.error('[TravelPredictor]', err);
                this.ui.update({
                    snapshot:  this._snapshot,
                    departure: { ready: false, recommendation: `Error: ${err.message}`, confidence: 0 },
                    stats:     this.statistics.get(),
                    predError: null,
                });
            }
        }
    }

    // ============================================================
    // Bootstrap
    // ============================================================

    new TravelPredictorApp()
        .init()
        .catch(err => console.error('[TravelPredictor] Fatal:', err));

})();
