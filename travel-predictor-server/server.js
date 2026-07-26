'use strict';

const express  = require('express');
const { DatabaseSync } = require('node:sqlite');   // built-in Node.js 22+
const { WebSocketServer } = require('ws');
const fetch    = require('node-fetch');
const http     = require('http');
const path     = require('path');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const PORT          = process.env.PORT || 3000;
const POLL_INTERVAL = 30_000;
const YATA_URL      = 'https://yata.yt/api/v1/travel/export/';
const MIN_CYCLES    = 3;

// Mutable settings (loaded from DB after init)
let settings = {
    retentionDays:   3,
    minCycles:       MIN_CYCLES,
    apiKey:          '',
    travelCapacity:  28,
    sellCommission:  5,
    travelTimes:     null,   // null = use COUNTRIES defaults; object = per-country overrides
    ticketPreset:    'standard',
    departureBuffer: 5,      // extra minutes to subtract from departure (bank withdraw / lag buffer)
};

// Country name → YATA key + Standard (no perk) travel time in minutes
// Source: Torn City wiki travel table (without book)
const COUNTRIES = Object.freeze({
    'Mexico':          { key: 'mex', minutes:  24 },
    'Cayman Islands':  { key: 'cay', minutes:  33 },
    'Canada':          { key: 'can', minutes:  39 },
    'Hawaii':          { key: 'haw', minutes: 127 },
    'United Kingdom':  { key: 'uni', minutes: 151 },
    'Argentina':       { key: 'arg', minutes: 158 },
    'Switzerland':     { key: 'swi', minutes: 166 },
    'Japan':           { key: 'jap', minutes: 213 },
    'China':           { key: 'chi', minutes: 229 },
    'UAE':             { key: 'uae', minutes: 257 },
    'South Africa':    { key: 'sou', minutes: 282 },
});

// Returns the configured travel time for a country (airstrip-adjusted),
// falling back to the COUNTRIES default.
function travelMinutesFor(country) {
    const tt = settings.travelTimes;
    if (tt && typeof tt[country] === 'number' && tt[country] > 0) return tt[country];
    return COUNTRIES[country]?.minutes ?? 158;
}

// ─────────────────────────────────────────────────────────────
// Log buffer (circular, max 1000 entries)
// ─────────────────────────────────────────────────────────────

const LOG_MAX = 1000;
const logBuffer = [];

function serverLog(level, msg) {
    const entry = { ts: Date.now(), level, msg };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_MAX) logBuffer.shift();
    const t = new Date(entry.ts).toISOString().replace('T', ' ').slice(0, 19);
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    fn(`[${t}] [${level}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────
// Utility functions (pure)
// ─────────────────────────────────────────────────────────────

const now   = () => Math.floor(Date.now() / 1000);
const mean  = a  => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const median = a => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdDev = a => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const percentile = (a, p) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const i = (p / 100) * (s.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const erf = x => {
    const sgn = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sgn * y;
};
const normalCDF = (mu, sigma, x) => {
    if (sigma <= 0) return x >= mu ? 1 : 0;
    return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
};
const fmtDuration = secs => {
    if (!secs || secs < 0) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};

// ─────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────

const db = new DatabaseSync(path.join(__dirname, 'predictor.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS watched_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    country        TEXT NOT NULL,
    item           TEXT NOT NULL,
    travel_minutes INTEGER NOT NULL DEFAULT 158,
    UNIQUE(country, item)
);

CREATE TABLE IF NOT EXISTS stock_snapshots (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    country  TEXT NOT NULL, item TEXT NOT NULL,
    ts       INTEGER NOT NULL, quantity INTEGER NOT NULL, cost INTEGER NOT NULL,
    UNIQUE(country, item, ts)
);
CREATE INDEX IF NOT EXISTS idx_snaps ON stock_snapshots(country, item, ts);

CREATE TABLE IF NOT EXISTS restock_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL, item TEXT NOT NULL,
    ts      INTEGER NOT NULL, quantity INTEGER NOT NULL,
    UNIQUE(country, item, ts)
);
CREATE INDEX IF NOT EXISTS idx_restocks ON restock_events(country, item, ts);

CREATE TABLE IF NOT EXISTS sellout_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    country TEXT NOT NULL, item TEXT NOT NULL,
    ts      INTEGER NOT NULL,
    UNIQUE(country, item, ts)
);
CREATE INDEX IF NOT EXISTS idx_sellouts ON sellout_events(country, item, ts);

CREATE TABLE IF NOT EXISTS cycles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    country           TEXT NOT NULL, item TEXT NOT NULL,
    restock_ts        INTEGER NOT NULL,
    sold_out_ts       INTEGER,
    duration          INTEGER,
    starting_quantity INTEGER,
    stock_lifetime    INTEGER,
    consumption_rate  REAL,
    UNIQUE(country, item, restock_ts)
);
CREATE INDEX IF NOT EXISTS idx_cycles ON cycles(country, item, restock_ts);

CREATE TABLE IF NOT EXISTS predictions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    country      TEXT NOT NULL, item TEXT NOT NULL,
    made_at      INTEGER NOT NULL,
    predicted_ts INTEGER,
    confidence   REAL
);
CREATE INDEX IF NOT EXISTS idx_preds ON predictions(country, item, made_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

// ─────────────────────────────────────────────────────────────
// Settings — persisted in DB, loaded at startup
// ─────────────────────────────────────────────────────────────

function loadSettings() {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    for (const { key, value } of rows) {
        if (key in settings) settings[key] = JSON.parse(value);
    }
}

function saveSetting(key, value) {
    settings[key] = value;
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)`).run(key, JSON.stringify(value));
}

// ─────────────────────────────────────────────────────────────
// YATA API — fetch once per tick, extract per (country, item)
// ─────────────────────────────────────────────────────────────

let _apiCache = null, _apiCacheAt = 0;
let _tornCache = null, _tornCacheAt = 0;
let _tornCatCache = null; // { itemName: category/type }

async function fetchTornPrices() {
    if (_tornCache && (Date.now() - _tornCacheAt) < 300_000) return _tornCache;
    if (!settings.apiKey) throw new Error('No API key configured in settings');
    serverLog('INFO', 'Fetching Torn item prices...');
    try {
        const res  = await fetch(`https://api.torn.com/torn/?selections=items&key=${settings.apiKey}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.error || `Torn API error code ${data.error.code}`);
        const prices = {}, cats = {};
        for (const item of Object.values(data.items ?? {})) {
            if (item.name) {
                prices[item.name] = item.market_value ?? 0;
                cats[item.name]   = item.type ?? 'Other';
            }
        }
        _tornCache    = prices;
        _tornCatCache = cats;
        _tornCacheAt  = Date.now();
        serverLog('OK', `Torn prices updated — ${Object.keys(prices).length} items`);
        return prices;
    } catch (err) {
        serverLog('ERROR', `Torn API fetch failed: ${err.message}`);
        throw err;
    }
}

async function fetchYata() {
    if (_apiCache && (Date.now() - _apiCacheAt) < 25_000) return _apiCache;
    serverLog('INFO', 'Fetching YATA travel export...');
    try {
        const res  = await fetch(YATA_URL, { timeout: 10000 });
        _apiCache  = await res.json();
        _apiCacheAt = Date.now();
        const countryCount = Object.keys(_apiCache?.stocks ?? {}).length;
        const itemCount    = Object.values(_apiCache?.stocks ?? {}).reduce((s, c) => s + (c.stocks?.length ?? 0), 0);
        serverLog('OK', `YATA fetch success — ${countryCount} countries, ${itemCount} items`);
        return _apiCache;
    } catch (err) {
        serverLog('ERROR', `YATA fetch failed: ${err.message}`);
        throw err;
    }
}

function extractItem(data, country, item) {
    // Fuzzy country match: "Japan" matches "jap", "JAP", etc.
    const mc = k => {
        if (!k) return false;
        const a = country.toLowerCase(), b = String(k).toLowerCase();
        return a === b || a.startsWith(b) || b.startsWith(a);
    };
    const mi = n => String(n ?? '').toLowerCase() === item.toLowerCase();

    const box = (i, cTs, rTs) => ({
        timestamp: cTs ?? rTs ?? now(),
        quantity:  i.quantity ?? 0,
        cost:      i.cost ?? 0,
    });

    // Primary YATA format: { stocks: { "jap": { update, stocks: [ { name, quantity, cost } ] } } }
    if (data?.stocks && typeof data.stocks === 'object') {
        const cKey = Object.keys(data.stocks).find(mc);
        if (cKey) {
            const cd = data.stocks[cKey];
            if (Array.isArray(cd.stocks)) {
                const found = cd.stocks.find(i => mi(i.name));
                if (found) return box(found, cd.update, data.timestamp);
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
// History — event detection
// ─────────────────────────────────────────────────────────────

const prevSnap = {}; // { "Country:Item": snapshot } — restored from DB on start

function restorePrevSnaps() {
    const rows = db.prepare(
        `SELECT country, item, ts, quantity, cost FROM stock_snapshots s
         WHERE ts = (SELECT MAX(ts) FROM stock_snapshots WHERE country = s.country AND item = s.item)`
    ).all();
    for (const r of rows) {
        prevSnap[`${r.country}:${r.item}`] = { timestamp: r.ts, quantity: r.quantity, cost: r.cost };
    }
}

const insSn  = db.prepare(`INSERT OR IGNORE INTO stock_snapshots(country,item,ts,quantity,cost) VALUES(?,?,?,?,?)`);
const insRe  = db.prepare(`INSERT OR IGNORE INTO restock_events(country,item,ts,quantity) VALUES(?,?,?,?)`);
const insSo  = db.prepare(`INSERT OR IGNORE INTO sellout_events(country,item,ts) VALUES(?,?,?)`);

function ingest(country, item, snap) {
    insSn.run(country, item, snap.timestamp, snap.quantity, snap.cost);
    const key  = `${country}:${item}`;
    const prev = prevSnap[key];
    const ev   = {};

    if (prev) {
        if (snap.quantity > prev.quantity) {
            insRe.run(country, item, snap.timestamp, snap.quantity);
            ev.restock = { ts: snap.timestamp, quantity: snap.quantity };
        }
        if (snap.quantity === 0 && prev.quantity > 0) {
            insSo.run(country, item, snap.timestamp);
            ev.sellout = { ts: snap.timestamp };
        }
    }

    prevSnap[key] = snap;
    return ev;
}

// ─────────────────────────────────────────────────────────────
// Cycle Builder
// ─────────────────────────────────────────────────────────────

const insCy = db.prepare(`
    INSERT OR IGNORE INTO cycles(country,item,restock_ts,sold_out_ts,duration,starting_quantity,stock_lifetime,consumption_rate)
    VALUES(?,?,?,?,?,?,?,?)`);

function buildCycles(country, item) {
    const restocks = db.prepare(`SELECT ts, quantity FROM restock_events WHERE country=? AND item=? ORDER BY ts`).all(country, item);
    const sellouts = db.prepare(`SELECT ts FROM sellout_events WHERE country=? AND item=? ORDER BY ts`).all(country, item);
    const known    = new Set(db.prepare(`SELECT restock_ts FROM cycles WHERE country=? AND item=?`).all(country, item).map(r => r.restock_ts));

    for (let i = 0; i < restocks.length - 1; i++) {
        const r = restocks[i], next = restocks[i + 1];
        if (known.has(r.ts)) continue;
        const so        = sellouts.find(s => s.ts > r.ts && s.ts < next.ts);
        const duration  = next.ts - r.ts;
        const lifetime  = so ? so.ts - r.ts : null;
        const rate      = (lifetime && r.quantity) ? r.quantity / lifetime : null;
        insCy.run(country, item, r.ts, so?.ts ?? null, duration, r.quantity, lifetime, rate);
    }
}

// ─────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────

function computeStats(country, item) {
    const rows = db.prepare(`SELECT duration, stock_lifetime, consumption_rate, starting_quantity FROM cycles WHERE country=? AND item=?`).all(country, item);
    if (rows.length < 2) return null;

    const intervals = rows.map(r => r.duration).filter(v => v != null && isFinite(v));
    const lifetimes = rows.map(r => r.stock_lifetime).filter(v => v != null && isFinite(v));
    const rates     = rows.map(r => r.consumption_rate).filter(v => v != null && isFinite(v));
    const qtys      = rows.map(r => r.starting_quantity).filter(v => v != null && isFinite(v));

    const iv = {
        mean: mean(intervals), median: median(intervals), stdDev: stdDev(intervals),
        min: Math.min(...intervals), max: Math.max(...intervals), p95: percentile(intervals, 95),
    };

    const confidence = clamp(100 * (1 - iv.stdDev / (iv.mean || 1)), 10, 99);

    return {
        cycleCount:              rows.length,
        restockInterval:         iv,
        averageStockLifetime:    mean(lifetimes),
        lifetimeStdDev:          stdDev(lifetimes),
        averageConsumptionRate:  mean(rates),
        averageStartingQuantity: mean(qtys),
        confidence,
    };
}

// ─────────────────────────────────────────────────────────────
// Predictor
// ─────────────────────────────────────────────────────────────

const predErrors = {}; // { "Country:Item": number[] }

function getLastRestock(country, item) {
    return db.prepare(`SELECT ts, quantity FROM restock_events WHERE country=? AND item=? ORDER BY ts DESC LIMIT 1`).get(country, item);
}

function countCycles(country, item) {
    return db.prepare(`SELECT COUNT(*) as cnt FROM cycles WHERE country=? AND item=?`).get(country, item)?.cnt ?? 0;
}

function predict(country, item) {
    const stats = computeStats(country, item);
    if (!stats || stats.cycleCount < MIN_CYCLES) {
        return { ready: false, reason: `Need ${MIN_CYCLES} cycles, have ${stats?.cycleCount ?? countCycles(country, item)}` };
    }
    const last = getLastRestock(country, item);
    if (!last) return { ready: false, reason: 'No restock events yet' };

    const n = now();
    const { mean: mu, stdDev: sigma } = stats.restockInterval;
    const lifetime = stats.averageStockLifetime || mu * 0.6;

    let nextRestock = last.ts + mu;
    while (nextRestock < n) nextRestock += mu;

    const overdueSecs = Math.max(0, n - (last.ts + mu));
    const confMod     = Math.max(0.4, 1 - overdueSecs / (sigma || mu));
    const confidence  = clamp(stats.confidence * confMod, 5, 99);

    return {
        ready: true, nextRestockTime: nextRestock, nextSelloutTime: nextRestock + lifetime,
        lastRestockTime: last.ts, meanInterval: mu, stdDevInterval: sigma, lifetime, confidence, stats,
    };
}

function getBestDeparture(country, item, travelMinutes) {
    const pred = predict(country, item);
    if (!pred.ready) return { ready: false, recommendation: `Collecting data… ${pred.reason}`, confidence: 0 };

    const { stats } = pred;
    const n          = now();
    const travelSecs = travelMinutes * 60;
    const mu         = stats.restockInterval.mean;
    const lifetime   = pred.lifetime;
    const lifeSigma  = stats.lifetimeStdDev || lifetime * 0.3;
    const avgQty     = stats.averageStartingQuantity || 1;
    const avgRate    = stats.averageConsumptionRate  || avgQty / (lifetime || 1);

    // Generate 12 future restock windows
    const windows = [];
    let base = pred.lastRestockTime;
    for (let i = 0; i < 12; i++) { base += mu; windows.push(base); }

    let bestScore = -1, best = null;

    for (const rt of windows) {
        const ideal = rt + 300 - travelSecs; // aim to arrive 5 min after restock
        for (let offset = -1800; offset <= 1800; offset += 300) {
            const dep  = ideal + offset;
            const lag  = dep - n;
            if (lag < 0) continue;
            const arr  = dep + travelSecs;
            const age  = arr - rt;
            if (age < 0) continue;
            const prob = 1 - normalCDF(lifetime, lifeSigma, age);
            const qty  = Math.max(0, avgQty - avgRate * age);
            const sc   = prob * (qty / avgQty);
            if (sc > bestScore) {
                bestScore = sc;
                best = { leaveInSeconds: Math.round(lag), leaveAt: dep, arriveAt: arr,
                         predictedRestock: rt, predictedSellOut: rt + lifetime,
                         expectedRemainingStock: Math.round(qty), probAvailable: prob };
            }
        }
    }

    if (!best) return { ready: false, recommendation: 'No favorable window', confidence: pred.confidence };

    const conf      = Math.round(pred.confidence * best.probAvailable);
    const shouldGo  = best.leaveInSeconds <= 120;

    return {
        ...best, ready: true, shouldLeave: conf,
        confidence: conf,
        recommendation: shouldGo ? 'Leave now!' : `Leave in ${fmtDuration(best.leaveInSeconds)}`,
    };
}

const insPred = db.prepare(`INSERT INTO predictions(country,item,made_at,predicted_ts,confidence) VALUES(?,?,?,?,?)`);

function storePrediction(country, item, predictedTs, confidence) {
    insPred.run(country, item, now(), predictedTs, confidence);
}

function evaluatePrediction(country, item, actualTs) {
    const key  = `${country}:${item}`;
    const pred = db.prepare(
        `SELECT predicted_ts FROM predictions WHERE country=? AND item=? AND made_at<? ORDER BY made_at DESC LIMIT 1`
    ).get(country, item, actualTs);
    if (pred?.predicted_ts) {
        if (!predErrors[key]) predErrors[key] = [];
        predErrors[key].push(Math.abs(actualTs - pred.predicted_ts));
        if (predErrors[key].length > 30) predErrors[key].shift();
    }
}

const getMAE = (country, item) => {
    const e = predErrors[`${country}:${item}`];
    return e?.length ? mean(e) : null;
};

// ─────────────────────────────────────────────────────────────
// Prune
// ─────────────────────────────────────────────────────────────

function prune() {
    const cutoff = now() - settings.retentionDays * 86400;
    ['stock_snapshots', 'restock_events', 'sellout_events'].forEach(t =>
        db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff)
    );
    db.prepare(`DELETE FROM cycles WHERE restock_ts < ?`).run(cutoff);
    db.prepare(`DELETE FROM predictions WHERE made_at < ?`).run(cutoff);
}

// ─────────────────────────────────────────────────────────────
// Polling loop — fetches YATA once, updates all watched items
// ─────────────────────────────────────────────────────────────

const wsClients = new Set();

async function tick() {
    try {
        prune();
        const apiData = await fetchYata();
        const watched = db.prepare(`SELECT country, item, travel_minutes FROM watched_items`).all();
        const updates = [];

        for (const { country, item, travel_minutes } of watched) {
            const snap = extractItem(apiData, country, item);
            if (!snap) {
                serverLog('WARN', `Item not found in YATA data: ${country} / ${item}`);
                continue;
            }

            const ev = ingest(country, item, snap);
            if (ev.restock) {
                serverLog('INFO', `Restock detected: ${country} / ${item} → ${ev.restock.quantity} units`);
                evaluatePrediction(country, item, ev.restock.ts);
            }
            if (ev.sellout) {
                serverLog('INFO', `Sellout detected: ${country} / ${item}`);
            }
            buildCycles(country, item);

            const dep = getBestDeparture(country, item, travel_minutes + (settings.departureBuffer || 0));
            if (dep.ready && dep.predictedRestock) storePrediction(country, item, dep.predictedRestock, dep.confidence);

            updates.push({
                country, item,
                snapshot:  snap,
                departure: dep,
                stats:     computeStats(country, item),
                mae:       getMAE(country, item),
                events:    ev,
            });
        }

        broadcast({ type: 'update', data: updates, serverTime: now() });
        serverLog('INFO', `Poll complete — ${updates.length} item(s) updated, ${wsClients.size} client(s) connected`);
    } catch (err) {
        serverLog('ERROR', `Poll failed: ${err.message}`);
        broadcast({ type: 'error', message: err.message });
    }
}

function broadcast(msg) {
    const raw = JSON.stringify(msg);
    wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(raw); });
}

// ─────────────────────────────────────────────────────────────
// Express routes
// ─────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Available countries
app.get('/api/countries', (_req, res) =>
    res.json(Object.entries(COUNTRIES).map(([name, v]) => ({ name, ...v })))
);

// All unique item names available in the current YATA snapshot
app.get('/api/items', async (_req, res) => {
    let apiData;
    try { apiData = await fetchYata(); } catch (e) {
        return res.status(503).json({ error: 'YATA data unavailable' });
    }
    const names = new Set();
    if (apiData?.stocks && typeof apiData.stocks === 'object') {
        for (const cd of Object.values(apiData.stocks)) {
            if (!Array.isArray(cd.stocks)) continue;
            for (const i of cd.stocks) {
                if (i.name) names.add(i.name);
            }
        }
    }
    res.json([...names].sort((a, b) => a.localeCompare(b)));
});

// Find every country in the current YATA snapshot that carries a given item
app.get('/api/countries-for-item', async (req, res) => {
    const { item } = req.query;
    if (!item) return res.status(400).json({ error: 'item required' });

    let apiData;
    try { apiData = await fetchYata(); } catch (e) {
        return res.status(503).json({ error: 'YATA data unavailable' });
    }

    const found = [];
    if (apiData?.stocks && typeof apiData.stocks === 'object') {
        for (const [yataKey, cd] of Object.entries(apiData.stocks)) {
            if (!Array.isArray(cd.stocks)) continue;
            const match = cd.stocks.find(i => i.name?.toLowerCase() === item.toLowerCase());
            if (!match) continue;

            // Map YATA abbreviation back to full country name
            const entry = Object.entries(COUNTRIES).find(([, v]) => {
                const a = yataKey.toLowerCase(), b = v.key.toLowerCase();
                return a === b;
            });
            if (!entry) continue;

            const [countryName] = entry;
            found.push({
                country:  countryName,
                item:     match.name,    // use the casing from YATA
                quantity: match.quantity,
                cost:     match.cost,
                travelMinutes: travelMinutesFor(countryName),
            });
        }
    }

    res.json(found);
});

// Full catalog: all countries with their current YATA item listings
app.get('/api/catalog', async (_req, res) => {
    let apiData;
    try { apiData = await fetchYata(); } catch (e) {
        return res.status(503).json({ error: 'YATA data unavailable' });
    }

    const countries = [];
    if (apiData?.stocks && typeof apiData.stocks === 'object') {
        for (const [yataKey, cd] of Object.entries(apiData.stocks)) {
            const entry = Object.entries(COUNTRIES).find(([, v]) =>
                v.key.toLowerCase() === yataKey.toLowerCase()
            );
            if (!entry) continue;
            const [countryName] = entry;
            const items = (cd.stocks ?? [])
                .filter(i => i.name)
                .map(i => ({ name: i.name, quantity: i.quantity ?? 0, cost: i.cost ?? 0 }))
                .sort((a, b) => a.name.localeCompare(b.name));
            countries.push({ name: countryName, travelMinutes: travelMinutesFor(countryName), items });
        }
    }
    countries.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ updatedAt: Math.round(_apiCacheAt / 1000), countries });
});

// Watched items CRUD
app.get('/api/watched', (_req, res) =>
    res.json(db.prepare(`SELECT * FROM watched_items ORDER BY country, item`).all())
);

app.post('/api/watched', (req, res) => {
    const { country, item } = req.body;
    if (!country || !item) return res.status(400).json({ error: 'country and item required' });
    if (!COUNTRIES[country]) return res.status(400).json({ error: `Unknown country: ${country}` });
    const minutes = travelMinutesFor(country);
    try {
        db.prepare(`INSERT OR IGNORE INTO watched_items(country, item, travel_minutes) VALUES(?,?,?)`).run(country, item, minutes);
        res.json({ ok: true });
        tick().catch(() => {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/watched/:id', (req, res) => {
    db.prepare(`DELETE FROM watched_items WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
});

// Current status (used for initial page load)
app.get('/api/status', (_req, res) => {
    const watched = db.prepare(`SELECT * FROM watched_items`).all();
    res.json(watched.map(({ country, item, travel_minutes }) => {
        const snap = db.prepare(
            `SELECT ts, quantity, cost FROM stock_snapshots WHERE country=? AND item=? ORDER BY ts DESC LIMIT 1`
        ).get(country, item);
        return { country, item, snapshot: snap, departure: getBestDeparture(country, item, travel_minutes + (settings.departureBuffer || 0)), stats: computeStats(country, item), mae: getMAE(country, item) };
    }));
});

// Stock history for charts
app.get('/api/history', (req, res) => {
    const { country, item, hours = '24' } = req.query;
    if (!country || !item) return res.status(400).json({ error: 'country and item required' });
    const cutoff = now() - Number(hours) * 3600;
    res.json({
        snapshots: db.prepare(`SELECT ts, quantity, cost FROM stock_snapshots WHERE country=? AND item=? AND ts>=? ORDER BY ts`).all(country, item, cutoff),
        restocks:  db.prepare(`SELECT ts, quantity FROM restock_events WHERE country=? AND item=? AND ts>=? ORDER BY ts`).all(country, item, cutoff),
        sellouts:  db.prepare(`SELECT ts FROM sellout_events WHERE country=? AND item=? AND ts>=? ORDER BY ts`).all(country, item, cutoff),
    });
});

// Cycle data for interval histogram
app.get('/api/cycles', (req, res) => {
    const { country, item } = req.query;
    if (!country || !item) return res.status(400).json({ error: 'country and item required' });
    res.json(db.prepare(`SELECT * FROM cycles WHERE country=? AND item=? ORDER BY restock_ts`).all(country, item));
});

// Full statistics
app.get('/api/stats', (req, res) => {
    const { country, item } = req.query;
    if (!country || !item) return res.status(400).json({ error: 'country and item required' });
    res.json(computeStats(country, item) ?? { ready: false });
});

// Torn market prices (proxied server-side to keep API key off the browser)
app.get('/api/torn-prices', async (_req, res) => {
    try {
        const prices = await fetchTornPrices();
        res.json(prices);
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
});

// Settings
app.get('/api/settings', (_req, res) => res.json({ ...settings, apiKey: settings.apiKey ? '••••••••' : '' }));

app.post('/api/settings', (req, res) => {
    const { retentionDays, apiKey } = req.body;
    if (retentionDays !== undefined) {
        const days = Number(retentionDays);
        if (!Number.isFinite(days) || days < 1 || days > 90)
            return res.status(400).json({ error: 'retentionDays must be 1–90' });
        saveSetting('retentionDays', days);
    }
    if (apiKey !== undefined) {
        const key = String(apiKey).trim();
        saveSetting('apiKey', key);
        _tornCache = null;
        serverLog('INFO', key ? 'Torn API key updated, price cache cleared' : 'Torn API key cleared');
    }
    if (req.body.travelCapacity !== undefined) {
        const cap = Number(req.body.travelCapacity);
        if (!Number.isFinite(cap) || cap < 1 || cap > 999)
            return res.status(400).json({ error: 'travelCapacity must be 1–999' });
        saveSetting('travelCapacity', Math.round(cap));
    }
    if (req.body.sellCommission !== undefined) {
        const com = Number(req.body.sellCommission);
        if (!Number.isFinite(com) || com < 0 || com > 100)
            return res.status(400).json({ error: 'sellCommission must be 0–100' });
        saveSetting('sellCommission', com);
    }
    if (req.body.departureBuffer !== undefined) {
        const buf = Number(req.body.departureBuffer);
        if (!Number.isFinite(buf) || buf < 0 || buf > 60)
            return res.status(400).json({ error: 'departureBuffer must be 0–60' });
        saveSetting('departureBuffer', Math.round(buf));
    }
    if (req.body.ticketPreset !== undefined) {
        const p = String(req.body.ticketPreset);
        if (['standard','airstrip','wlt','bct','custom'].includes(p)) {
            saveSetting('ticketPreset', p);
            serverLog('INFO', `Ticket preset set to: ${p}`);
        }
    }
    if (req.body.travelTimes !== undefined) {
        const raw = req.body.travelTimes;
        if (typeof raw !== 'object' || Array.isArray(raw))
            return res.status(400).json({ error: 'travelTimes must be an object' });
        const validated = {};
        for (const [country, mins] of Object.entries(raw)) {
            if (!COUNTRIES[country]) continue;
            const m = Number(mins);
            if (!Number.isFinite(m) || m < 1 || m > 9999) continue;
            validated[country] = Math.round(m);
        }
        saveSetting('travelTimes', validated);
        const upd = db.prepare(`UPDATE watched_items SET travel_minutes=? WHERE country=?`);
        for (const [country, mins] of Object.entries(validated)) upd.run(mins, country);
        serverLog('INFO', `Travel times saved (${Object.keys(validated).length} countries): Mexico=${validated['Mexico']}min UK=${validated['United Kingdom']}min`);
        tick().catch(() => {});
    }
    res.json({ ...settings, apiKey: settings.apiKey ? '••••••••' : '' });
});

// Logs
app.get('/api/logs', (_req, res) => res.json(logBuffer));

// Item categories (derived from Torn API)
app.get('/api/torn-categories', async (_req, res) => {
    if (_tornCatCache) return res.json(_tornCatCache);
    try { await fetchTornPrices(); res.json(_tornCatCache ?? {}); }
    catch (e) { res.json({}); }
});

// ─────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
    wsClients.add(ws);
    serverLog('INFO', `WebSocket client connected (${wsClients.size} total)`);
    ws.on('close', () => { wsClients.delete(ws); serverLog('INFO', `WebSocket client disconnected (${wsClients.size} remaining)`); });
    ws.on('error', (err) => { wsClients.delete(ws); serverLog('WARN', `WebSocket error: ${err.message}`); });
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

loadSettings();
restorePrevSnaps();

server.listen(PORT, () => {
    serverLog('OK', `Torn Travel Predictor started → http://localhost:${PORT}`);
    serverLog('INFO', `Poll interval: ${POLL_INTERVAL / 1000}s | Retention: ${settings.retentionDays}d | Capacity: ${settings.travelCapacity}`);
    tick();
    setInterval(tick, POLL_INTERVAL);
});
