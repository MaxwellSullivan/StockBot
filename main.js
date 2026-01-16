const START_WALLET = 5000.0;
const MODE_STORAGE_KEY = "stockbot_mode";
const MODE_QUICK = "quick";
const MODE_PRECISE = "precise";
const QUICK_START_WALLET = 4000.0;
const RELOAD_ALL_STAGGER_MS = 500;
const REGIME_SENS_DEFAULT = 1.0;
const REGIME_WINDOW_DAYS = 10;
const REGIME_TREND_DAYS = 7;
const REGIME_RANGE_PCT = 20;
const SMOOTH_METHOD_DEFAULT = "ema";
const SMOOTH_ALPHA_BASE_DEFAULT = 0.35;
const SMOOTH_MIN_ALPHA_DEFAULT = 0.15;
const SMOOTH_MAX_ALPHA_DEFAULT = 0.75;
const SMOOTH_NOISE_LOOKBACK_DAYS_DEFAULT = 7;
const SMOOTH_RIGIDITY_PCT_DEFAULT = 1.25;
const SMOOTH_ADAPT_STRENGTH_DEFAULT = 1.2;
const NOISE_PENALTY_STRENGTH_DEFAULT = 0.8;
const CURVE_LOOKBACK_DAYS_DEFAULT = 6;
const CURVE_WEIGHT_DEFAULT = 0.5;
const MAX_LOOKBACK_DAYS = 30;
const STORAGE_KEY = "biasTraderSavedV7";
const PRICE_CACHE_KEY = "biasTraderPriceV7";
const NAME_MAP_KEY = "biasTraderNameMapV7";
const BUILTIN_NAME_MAP = {
    apple: "AAPL",
    "apple inc": "AAPL",
    microsoft: "MSFT",
    "microsoft corp": "MSFT",
    meta: "META",
    facebook: "META",
    google: "GOOGL",
    alphabet: "GOOGL",
    amazon: "AMZN",
    "amazon.com": "AMZN",
    nvidia: "NVDA",
    "nvidia corp": "NVDA",
    tesla: "TSLA",
    "tesla inc": "TSLA",
    adobe: "ADBE",
    netflix: "NFLX"
};
const form = document.getElementById("symbol-form");
const input = document.getElementById("symbol-input");
const runButton = document.getElementById("run-button");
function getSelectedMode() {
    const q = document.getElementById("mode-quick");
    const p = document.getElementById("mode-precise");
    if (q && p)
        return q.checked ? MODE_QUICK : MODE_PRECISE;
    const el = document.getElementById("mode-toggle");
    if (el)
        return el.checked ? MODE_QUICK : MODE_PRECISE;
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    return saved === MODE_PRECISE ? MODE_PRECISE : MODE_QUICK;
}
function setSelectedMode(mode) {
    const m = mode === MODE_PRECISE ? MODE_PRECISE : MODE_QUICK;
    localStorage.setItem(MODE_STORAGE_KEY, m);
    const q = document.getElementById("mode-quick");
    const p = document.getElementById("mode-precise");
    if (q && p) {
        q.checked = m === MODE_QUICK;
        p.checked = m === MODE_PRECISE;
        return;
    }
    const el = document.getElementById("mode-toggle");
    const lbl = document.getElementById("mode-toggle-label");
    if (el)
        el.checked = m === MODE_QUICK;
    if (lbl)
        lbl.textContent = m === MODE_QUICK ? "Quick" : "Precise";
}
function ensureModeToggle() {
    const q = document.getElementById("mode-quick");
    const p = document.getElementById("mode-precise");
    if (q && p) {
        q.addEventListener("change", () => setSelectedMode(MODE_QUICK));
        p.addEventListener("change", () => setSelectedMode(MODE_PRECISE));
        setSelectedMode(getSelectedMode());
        return;
    }
    if (document.getElementById("mode-toggle")) {
        setSelectedMode(getSelectedMode());
        return;
    }
    if (!runButton || !runButton.parentNode)
        return;
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "10px";
    const parent = runButton.parentNode;
    parent.insertBefore(wrap, runButton);
    wrap.appendChild(runButton);
    const seg = document.createElement("div");
    seg.className = "segmented-toggle";
    seg.id = "mode-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Run mode");
    const inputQ = document.createElement("input");
    inputQ.type = "radio";
    inputQ.id = "mode-quick";
    inputQ.name = "run-mode";
    inputQ.value = "quick";
    const labelQ = document.createElement("label");
    labelQ.setAttribute("for", "mode-quick");
    labelQ.textContent = "Quick";
    const inputP = document.createElement("input");
    inputP.type = "radio";
    inputP.id = "mode-precise";
    inputP.name = "run-mode";
    inputP.value = "precise";
    const labelP = document.createElement("label");
    labelP.setAttribute("for", "mode-precise");
    labelP.textContent = "Precise";
    seg.appendChild(inputQ);
    seg.appendChild(labelQ);
    seg.appendChild(inputP);
    seg.appendChild(labelP);
    wrap.appendChild(seg);
    inputQ.addEventListener("change", () => setSelectedMode(MODE_QUICK));
    inputP.addEventListener("change", () => setSelectedMode(MODE_PRECISE));
    setSelectedMode(getSelectedMode());
}
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const etaText = document.getElementById("eta-text");
const savedList = document.getElementById("saved-list");
const clearSavedBtn = document.getElementById("clear-saved");
const reloadSavedBtn = document.getElementById("reload-saved");
const decisionText = document.getElementById("decision-text");
const decisionExtra = document.getElementById("decision-extra");
const thresholdsText = document.getElementById("thresholds-text");
const thresholdsExtra = document.getElementById("thresholds-extra");
ensureModeToggle();
const profitText = document.getElementById("profit-text");
const profitExtra = document.getElementById("profit-extra");
const chartCanvas = document.getElementById("chart");
let priceChart = null;
let currentSymbol = null;
let currentProgressPercent = 0;
let reloadAllInProgress = false;
let progressTargetDisplayPercent = 0;
let progressDisplayPercent = 0;
let progressAnimRunning = false;
let progressAnimLastMs = 0;
let etaSamples = [];
let etaUpdateTimerId = null;
const GRID_STATUS_MESSAGES = [
    "Simulating wallets...",
    "Optimizing your tendies...",
    "Hacking your crypto (ethically)...",
    "Asking the stonks gods for guidance...",
    "Counting imaginary yachts...",
    "Teaching your portfolio to moonwalk...",
    "Backtesting bad decisions...",
    "Wrangling volatile candles...",
    "Bribing random number generators...",
    "Optimizing diamond hands..."
];
let gridSearchMessageCount = 0;
let gridSearchNextPercentIn = 3;
let lastGridStatusUpdateTime = 0;
function resetGridSearchMessageInterval() {
    gridSearchMessageCount = 0;
    gridSearchNextPercentIn = 3 + Math.floor(Math.random() * 3);
}
resetGridSearchMessageInterval();
if (typeof Chart !== "undefined" && Chart.Tooltip && Chart.Tooltip.positioners) {
    Chart.Tooltip.positioners.dynamicSide = function (items, eventPosition) {
        const chart = this.chart;
        const data = chart.data || {};
        const datasets = data.datasets || [];
        const labels = data.labels || [];
        const offset = 22;
        if (!items || !items.length)
            return eventPosition;
        const avgPos = Chart.Tooltip.positioners.average.call(this, items, eventPosition);
        let baseX = avgPos.x;
        let baseY = avgPos.y;
        let simItem = items[0];
        for (const it of items) {
            const ds = datasets[it.datasetIndex];
            if (ds && ds.label === "Simulation value") {
                simItem = it;
                break;
            }
        }
        if (simItem.element) {
            const el = simItem.element;
            const pos = typeof el.tooltipPosition === "function"
                ? el.tooltipPosition(true)
                : el;
            if (pos && typeof pos.y === "number") {
                baseY = pos.y;
            }
        }
        const maxIndex = labels.length > 0 ? labels.length - 1 : 0;
        const midIndex = maxIndex / 2;
        const idx = simItem.dataIndex != null
            ? simItem.dataIndex
            : simItem.index != null
                ? simItem.index
                : 0;
        const side = idx <= midIndex ? "right" : "left";
        const x = baseX;
        const y = baseY;
        return { x, y };
    };
}
function setStatus(msg, isError = false) {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (isError ? " error" : "");
}
function scheduleProgressVisualTick(cb) {
    if (typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        typeof requestAnimationFrame === "function") {
        requestAnimationFrame(cb);
        return;
    }
    setTimeout(() => cb(_nowMs()), 50);
}
function ensureProgressAnimator() {
    if (!progressBar)
        return;
    if (progressAnimRunning)
        return;
    progressAnimRunning = true;
    progressAnimLastMs = 0;
    const tick = (t) => {
        if (!progressAnimRunning)
            return;
        const now = typeof t === "number" ? t : _nowMs();
        if (!progressAnimLastMs)
            progressAnimLastMs = now;
        const dt = Math.max(0, now - progressAnimLastMs);
        progressAnimLastMs = now;
        const tau = 220;
        const alpha = 1 - Math.exp(-dt / tau);
        progressDisplayPercent += (progressTargetDisplayPercent - progressDisplayPercent) * alpha;
        if (Math.abs(progressTargetDisplayPercent - progressDisplayPercent) < 0.05) {
            progressDisplayPercent = progressTargetDisplayPercent;
        }
        if (progressBar) {
            progressBar.style.width = progressDisplayPercent.toFixed(2) + "%";
        }
        if (progressDisplayPercent === progressTargetDisplayPercent) {
            progressAnimRunning = false;
            return;
        }
        scheduleProgressVisualTick(tick);
    };
    scheduleProgressVisualTick(tick);
}
function setProgressTarget(displayPercent) {
    const clamped = Math.max(0, Math.min(100, displayPercent));
    progressTargetDisplayPercent = clamped;
    if (!isFinite(progressDisplayPercent)) {
        progressDisplayPercent = clamped;
    }
    if (clamped < progressDisplayPercent - 1) {
        progressDisplayPercent = clamped;
        if (progressBar)
            progressBar.style.width = clamped + "%";
        progressAnimRunning = false;
    }
    if (progressBar && !progressAnimRunning) {
        if (Math.abs(progressTargetDisplayPercent - progressDisplayPercent) < 0.05) {
            progressDisplayPercent = progressTargetDisplayPercent;
            progressBar.style.width = progressDisplayPercent + "%";
            return;
        }
        ensureProgressAnimator();
    }
}
function resetEta() {
    etaSamples = [];
    if (etaText)
        etaText.textContent = "";
    if (etaUpdateTimerId) {
        clearInterval(etaUpdateTimerId);
        etaUpdateTimerId = null;
    }
}
function pushEtaSample(now, pct) {
    const last = etaSamples.length ? etaSamples[etaSamples.length - 1] : null;
    if (last && pct < last.pct - 0.05) {
        etaSamples = [];
    }
    const prev = etaSamples.length ? etaSamples[etaSamples.length - 1] : null;
    if (!prev || Math.abs(pct - prev.pct) >= 0.05) {
        etaSamples.push({ t: now, pct });
        if (etaSamples.length > 6)
            etaSamples.shift();
    }
}
function rollingMsPerPercent(now) {
    if (etaSamples.length < 2)
        return null;
    let sumDt = 0;
    let sumDp = 0;
    let used = 0;
    for (let i = etaSamples.length - 1; i >= 1 && used < 5; i--) {
        const a = etaSamples[i - 1];
        const b = etaSamples[i];
        const dp = b.pct - a.pct;
        const dt = i === etaSamples.length - 1 && typeof now === "number" ? Math.max(0, now - a.t) : b.t - a.t;
        if (dp > 0.01 && dt > 0) {
            sumDt += dt;
            sumDp += dp;
            used++;
        }
    }
    if (sumDp <= 0)
        return null;
    return sumDt / sumDp;
}
function refreshEtaText() {
    if (!etaText)
        return;
    if (!(currentProgressPercent > 0 && currentProgressPercent < 100) || etaSamples.length < 2) {
        if (etaUpdateTimerId) {
            clearInterval(etaUpdateTimerId);
            etaUpdateTimerId = null;
        }
        etaText.textContent = "";
        return;
    }
    const now = _nowMs();
    const msPerPct = rollingMsPerPercent(now);
    if (msPerPct == null || !isFinite(msPerPct) || msPerPct <= 0) {
        etaText.textContent = "";
        return;
    }
    const remainingPercent = Math.max(100 - currentProgressPercent, 0);
    const remainingMs = msPerPct * remainingPercent;
    if (!isFinite(remainingMs) || remainingMs < 0) {
        etaText.textContent = "";
        return;
    }
    const remSec = Math.max(0, Math.round(remainingMs / 1000));
    etaText.textContent = `Estimated remaining time: ${remSec}s`;
}
function updateEtaRolling(now, rawProgressPercent) {
    if (!etaText)
        return;
    if (!(rawProgressPercent > 0 && rawProgressPercent < 100)) {
        resetEta();
        return;
    }
    pushEtaSample(now, rawProgressPercent);
    refreshEtaText();
    if (!etaUpdateTimerId) {
        etaUpdateTimerId = setInterval(refreshEtaText, 250);
    }
}
function setProgress(percent, label, opts) {
    opts = opts || {};
    const scope = opts.scope || "default";
    const raw = !!opts.raw;
    if (reloadAllInProgress && scope !== "reloadAll")
        return;
    const p = Math.max(0, Math.min(100, percent));
    currentProgressPercent = p;
    let displayPercent;
    if (raw) {
        displayPercent = p;
    }
    else if (p <= 0) {
        displayPercent = 0;
    }
    else if (p < 60) {
        displayPercent = Math.round((p / 60) * 99);
    }
    else if (p < 100) {
        displayPercent = 99;
    }
    else {
        displayPercent = 100;
    }
    displayPercent = Math.max(0, Math.min(100, displayPercent));
    setProgressTarget(displayPercent);
    const now = typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    if (p > 0 && p < 100) {
        updateEtaRolling(now, p);
    }
    else {
        resetEta();
        gridSearchMessageCount = 0;
        lastGridStatusUpdateTime = 0;
        gridSearchNextPercentIn = 3 + Math.floor(Math.random() * 3);
    }
    const isGridSearch = typeof label === "string" && label.toLowerCase().includes("grid search");
    if (!isGridSearch) {
        const baseLabel = label || "Progress";
        if (progressText) {
            progressText.textContent = `Progress: ${displayPercent}%`;
        }
        return;
    }
    if (!GRID_STATUS_MESSAGES.length) {
        if (progressText) {
            progressText.textContent = `Grid search: ${displayPercent}%`;
        }
        return;
    }
    const timeSinceLast = now - (lastGridStatusUpdateTime || 0);
    const isFinal = displayPercent >= 100;
    if (isFinal || timeSinceLast >= 3000) {
        lastGridStatusUpdateTime = now;
        let text;
        if (gridSearchMessageCount >= gridSearchNextPercentIn || isFinal) {
            text = `Grid search: ${displayPercent}%`;
            gridSearchMessageCount = 0;
            gridSearchNextPercentIn = 3 + Math.floor(Math.random() * 3);
        }
        else {
            const idx = Math.floor(Math.random() * GRID_STATUS_MESSAGES.length);
            text = GRID_STATUS_MESSAGES[idx] || "Simulating...";
            gridSearchMessageCount++;
        }
        if (progressText) {
            progressText.textContent = text;
        }
    }
}
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}
function isAfterDailyRefreshCutoff() {
    const now = new Date();
    return now.getHours() >= 14;
}
function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}
function _nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function yieldToLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
function yieldCooperative() {
    if (typeof scheduler !== "undefined" && typeof scheduler.yield === "function") {
        return scheduler.yield();
    }
    if (typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        typeof requestAnimationFrame === "function") {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    return yieldToLoop();
}
function avgAbsReturnPct(prices, i, lookbackDays) {
    const lb = Math.max(1, Math.floor(lookbackDays || 1));
    const start = Math.max(1, i - lb + 1);
    let sum = 0, n = 0;
    for (let j = start; j <= i; j++) {
        const prev = prices[j - 1];
        const cur = prices[j];
        if (prev > 0 && isFinite(prev) && isFinite(cur)) {
            sum += Math.abs((cur - prev) / prev) * 100;
            n++;
        }
    }
    return n ? (sum / n) : 0;
}
function slopePct(series, i, lookbackDays) {
    const k = Math.max(2, Math.floor(lookbackDays || 2));
    if (i < k)
        return 0;
    const ref = series[i - k];
    if (!(ref > 0))
        return 0;
    return ((series[i] - ref) / ref) * 100;
}
async function fetchJson(url) {
    try {
        console.log(`[API CALL] ${new Date().toISOString()} -> ${url}`);
    }
    catch (_) { }
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
}
function formatMoney(value, withSign = false) {
    if (!isFinite(value))
        return withSign ? "+$0.00" : "$0.00";
    const sign = withSign ? (value >= 0 ? "+$" : "-$") : "$";
    const abs = Math.abs(value).toFixed(2);
    return sign + abs;
}
function computeAvgWinLossFromMarkers(prices, buyMarkers = [], sellMarkers = []) {
    if (!Array.isArray(prices) || prices.length < 2)
        return null;
    const lots = [];
    const wins = [];
    const losses = [];
    const toNum = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    for (let i = 0; i < prices.length; i++) {
        const price = toNum(prices[i]);
        if (!price)
            continue;
        const bought = toNum(buyMarkers && buyMarkers[i]);
        if (bought > 0) {
            lots.push({ shares: bought, price });
        }
        let sold = toNum(sellMarkers && sellMarkers[i]);
        while (sold > 0 && lots.length) {
            const lot = lots[0];
            const take = Math.min(sold, lot.shares);
            const pct = lot.price > 0 ? ((price - lot.price) / lot.price) * 100 : 0;
            if (pct >= 0)
                wins.push({ shares: take, pct });
            else
                losses.push({ shares: take, pct });
            lot.shares -= take;
            sold -= take;
            if (lot.shares <= 1e-9)
                lots.shift();
        }
    }
    const lastPrice = toNum(prices[prices.length - 1]);
    if (lastPrice > 0 && lots.length) {
        for (const lot of lots) {
            const pct = lot.price > 0 ? ((lastPrice - lot.price) / lot.price) * 100 : 0;
            if (pct >= 0)
                wins.push({ shares: lot.shares, pct });
            else
                losses.push({ shares: lot.shares, pct });
        }
    }
    const sumShares = (arr) => arr.reduce((acc, x) => acc + toNum(x.shares), 0);
    const wAvgPct = (arr) => {
        const total = sumShares(arr);
        if (total <= 0)
            return NaN;
        const num = arr.reduce((acc, x) => acc + toNum(x.shares) * toNum(x.pct), 0);
        return num / total;
    };
    const winShares = sumShares(wins);
    const lossShares = sumShares(losses);
    return {
        avgWinPct: wAvgPct(wins),
        avgLossPct: wAvgPct(losses),
        winShares,
        lossShares,
        winSamples: wins.length,
        lossSamples: losses.length
    };
}
function getIdent() {
    const encoded = "QlQ4VVVBSklKMDlCMUlrRg==";
    return atob(encoded);
}
function loadNameMap() {
    let result = { ...BUILTIN_NAME_MAP };
    try {
        const raw = localStorage.getItem(NAME_MAP_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                for (const [k, v] of Object.entries(parsed)) {
                    result[k] = v;
                }
            }
        }
    }
    catch (e) {
        console.warn("Failed to load name map:", e);
    }
    return result;
}
function saveNameMap(extraMap) {
    try {
        localStorage.setItem(NAME_MAP_KEY, JSON.stringify(extraMap));
    }
    catch (e) {
        console.warn("Failed to save name map:", e);
    }
}
function loadPriceCache() {
    try {
        const raw = localStorage.getItem(PRICE_CACHE_KEY);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object")
            return parsed;
    }
    catch (e) {
        console.warn("Failed to load price cache:", e);
    }
    return {};
}
function getCachedPricesIfFresh(symbol) {
    const cache = loadPriceCache();
    const sym = symbol.toUpperCase();
    const entry = cache[sym];
    if (!entry)
        return null;
    if (entry.fetch_date !== todayISO())
        return null;
    const now = new Date();
    const afterCutoffNow = isAfterDailyRefreshCutoff();
    if (afterCutoffNow && !entry.after_cutoff_fetch) {
        return null;
    }
    return { dates: entry.dates, prices: entry.prices };
}
function savePriceCache(symbol, dates, prices) {
    const cache = loadPriceCache();
    const sym = symbol.toUpperCase();
    cache[sym] = {
        fetch_date: todayISO(),
        dates,
        prices,
        after_cutoff_fetch: isAfterDailyRefreshCutoff()
    };
    try {
        localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
    }
    catch (e) {
        console.warn("Failed to save price cache:", e);
    }
}
function loadSaved() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            let changed = false;
            for (const sym of Object.keys(parsed)) {
                const rec = parsed[sym];
                if (!rec || typeof rec !== "object")
                    continue;
                if (!rec.modes)
                    rec.modes = {};
                const hasLegacyThresholds = typeof rec.sell_pct_thresh === "number" &&
                    isFinite(rec.sell_pct_thresh) &&
                    typeof rec.buy_pct_thresh === "number" &&
                    isFinite(rec.buy_pct_thresh);
                if (hasLegacyThresholds && !rec.modes[MODE_PRECISE]) {
                    rec.modes[MODE_PRECISE] = {
                        symbol: (rec.symbol || sym).toUpperCase(),
                        start_wallet: typeof rec.start_wallet === "number" && isFinite(rec.start_wallet)
                            ? rec.start_wallet
                            : START_WALLET,
                        sell_pct_thresh: rec.sell_pct_thresh,
                        buy_pct_thresh: rec.buy_pct_thresh,
                        position_scale: typeof rec.position_scale === "number" ? rec.position_scale : 1.0,
                        min_hold_days: typeof rec.min_hold_days === "number" ? rec.min_hold_days : 0,
                        long_term_ratio: typeof rec.long_term_ratio === "number"
                            ? rec.long_term_ratio
                            : 0.0,
                        long_term_min_hold_days: typeof rec.long_term_min_hold_days === "number"
                            ? rec.long_term_min_hold_days
                            : 0,
                        regime_sensitivity: typeof rec.regime_sensitivity === "number" ? rec.regime_sensitivity : REGIME_SENS_DEFAULT,
                        regime_window_days: typeof rec.regime_window_days === "number" ? rec.regime_window_days : REGIME_WINDOW_DAYS,
                        regime_trend_days: typeof rec.regime_trend_days === "number" ? rec.regime_trend_days : REGIME_TREND_DAYS,
                        regime_range_pct: typeof rec.regime_range_pct === "number" ? rec.regime_range_pct : REGIME_RANGE_PCT,
                        profit: rec.profit,
                        last_decision: rec.last_decision,
                        last_amount: rec.last_amount,
                        last_action_price: rec.last_action_price,
                        last_price: rec.last_price,
                        calc_used: rec.calc_used || "Precise (legacy cached thresholds)",
                        updated_at: rec.updated_at || null
                    };
                    rec.last_run_mode = rec.last_run_mode || MODE_PRECISE;
                    changed = true;
                }
            }
            if (changed) {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
                }
                catch (e) {
                }
            }
            return parsed;
        }
    }
    catch (e) {
        console.warn("Failed to load saved:", e);
    }
    return {};
}
function saveSaved(obj) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    }
    catch (e) {
        console.warn("Failed to save:", e);
    }
}
function pickPreferredSavedMode(rec) {
    const modes = rec && rec.modes ? rec.modes : {};
    if (modes[MODE_PRECISE])
        return MODE_PRECISE;
    if (modes[MODE_QUICK])
        return MODE_QUICK;
    return null;
}
function buildOptionsFromModeRec(modeRec) {
    return {
        positionScale: typeof modeRec.position_scale === "number" ? modeRec.position_scale : 1.0,
        minHoldDays: typeof modeRec.min_hold_days === "number" ? modeRec.min_hold_days : 0,
        longTermRatio: typeof modeRec.long_term_ratio === "number" ? modeRec.long_term_ratio : 0.0,
        longTermMinHoldDays: typeof modeRec.long_term_min_hold_days === "number" ? modeRec.long_term_min_hold_days : 0,
        regimeSensitivity: typeof modeRec.regime_sensitivity === "number" ? modeRec.regime_sensitivity : REGIME_SENS_DEFAULT,
        regimeWindowDays: typeof modeRec.regime_window_days === "number" ? modeRec.regime_window_days : REGIME_WINDOW_DAYS,
        regimeTrendDays: typeof modeRec.regime_trend_days === "number" ? modeRec.regime_trend_days : REGIME_TREND_DAYS,
        regimeRangePct: typeof modeRec.regime_range_pct === "number" ? modeRec.regime_range_pct : REGIME_RANGE_PCT
    };
}
function runUsingExistingCalcs(prices, modeKey, modeRec) {
    const startWallet = typeof modeRec.start_wallet === "number" && isFinite(modeRec.start_wallet)
        ? modeRec.start_wallet
        : (modeKey === MODE_QUICK ? QUICK_START_WALLET : START_WALLET);
    const options = buildOptionsFromModeRec(modeRec);
    const res = biasedTrader(prices, startWallet, modeRec.sell_pct_thresh, modeRec.buy_pct_thresh, MAX_LOOKBACK_DAYS, options);
    res.start_wallet = startWallet;
    res.sell_pct_thresh = modeRec.sell_pct_thresh;
    res.buy_pct_thresh = modeRec.buy_pct_thresh;
    res.position_scale = options.positionScale;
    res.min_hold_days = options.minHoldDays;
    res.long_term_ratio = options.longTermRatio;
    res.long_term_min_hold_days = options.longTermMinHoldDays;
    res.regime_sensitivity = options.regimeSensitivity;
    res.regime_window_days = options.regimeWindowDays;
    res.regime_trend_days = options.regimeTrendDays;
    res.regime_range_pct = options.regimeRangePct;
    const execDecision = res.last_decision;
    const execAmount = res.last_amount;
    const snap = {
        wallet: res.final_wallet,
        shares: Array.isArray(res.final_shares)
            ? res.final_shares.reduce((acc, lot) => acc + (lot.amount || 0), 0)
            : 0
    };
    const signal = computeSignalSizedDecision(prices, res, snap);
    res.exec_last_decision = execDecision;
    res.exec_last_amount = execAmount;
    res.signal_score = signal.score;
    res.signal_reason = signal.reason;
    res.signal_suggested_shares = signal.suggestedShares;
    const isHighStrength = (signal.size === SIZE_HIGH) || (String(signal.size || "").toUpperCase() === "HIGH");
    const finalDecision = ((signal.decision === "BUY" || signal.decision === "SELL") && isHighStrength)
        ? signal.decision
        : "HOLD";
    res.signal_size = signal.size || null;
    res.last_decision = finalDecision;
    res.last_amount = "";
    res.last_action_price = res.last_price;
    return res;
}
function updateSavedRunOutputs(savedObj, sym, modeKey, newRes) {
    const rec = savedObj[sym];
    if (!rec || !rec.modes || !rec.modes[modeKey])
        return;
    const modeRec = rec.modes[modeKey];
    modeRec.profit = newRes.profit;
    modeRec.last_decision = newRes.last_decision;
    modeRec.last_amount = newRes.last_amount;
    modeRec.last_action_price = newRes.last_action_price;
    modeRec.last_price = newRes.last_price;
    modeRec.exec_last_decision = newRes.exec_last_decision || null;
    modeRec.exec_last_amount = (typeof newRes.exec_last_amount === "number") ? newRes.exec_last_amount : null;
    modeRec.signal_score = (typeof newRes.signal_score === "number") ? newRes.signal_score : null;
    modeRec.signal_reason = newRes.signal_reason || null;
    modeRec.signal_suggested_shares = (typeof newRes.signal_suggested_shares === "number") ? newRes.signal_suggested_shares : null;
    rec.modes[modeKey] = modeRec;
    const displayMode = rec.modes[MODE_PRECISE] ? MODE_PRECISE : (rec.modes[MODE_QUICK] ? MODE_QUICK : modeKey);
    const displayRec = rec.modes[displayMode] || modeRec;
    rec.last_run_mode = displayMode;
    rec.calc_used = displayRec.calc_used;
    rec.updated_at = displayRec.updated_at || null;
    rec.updated_date = displayRec.updated_date || null;
    rec.start_wallet = displayRec.start_wallet;
    rec.sell_pct_thresh = displayRec.sell_pct_thresh;
    rec.buy_pct_thresh = displayRec.buy_pct_thresh;
    rec.position_scale = displayRec.position_scale;
    rec.min_hold_days = displayRec.min_hold_days;
    rec.long_term_ratio = displayRec.long_term_ratio;
    rec.long_term_min_hold_days = displayRec.long_term_min_hold_days;
    rec.regime_sensitivity = displayRec.regime_sensitivity;
    rec.regime_window_days = displayRec.regime_window_days;
    rec.regime_trend_days = displayRec.regime_trend_days;
    rec.regime_range_pct = displayRec.regime_range_pct;
    rec.profit = displayRec.profit;
    rec.last_decision = displayRec.last_decision;
    rec.last_amount = displayRec.last_amount;
    rec.last_action_price = displayRec.last_action_price;
    rec.last_price = displayRec.last_price;
    savedObj[sym] = rec;
}
async function reloadAllSavedSymbolsApplyOnly() {
    const saved = loadSaved();
    const symbols = Object.keys(saved || {}).filter((s) => s && typeof s === "string");
    if (!symbols.length) {
        setStatus("No saved symbols to reload.");
        return;
    }
    reloadSavedBtn.disabled = true;
    runButton.disabled = true;
    reloadAllInProgress = true;
    let completed = 0;
    const total = symbols.length;
    try {
        setStatus(`Reloading ${total} saved symbol(s)...`);
        setProgress(0, `Reloading ${total} symbol(s)...`, { raw: true, scope: "reloadAll" });
        const tasks = symbols.map((sym, idx) => {
            return new Promise((resolve) => {
                setTimeout(async () => {
                    const upper = String(sym).toUpperCase();
                    try {
                        const rec = saved[upper];
                        const modes = rec && rec.modes ? rec.modes : null;
                        if (!modes)
                            throw new Error("Missing modes for saved symbol.");
                        const modeKey = modes[MODE_PRECISE] ? MODE_PRECISE : (modes[MODE_QUICK] ? MODE_QUICK : null);
                        if (!modeKey)
                            throw new Error("No cached mode found.");
                        const modeRec = modes[modeKey];
                        if (!modeRec || typeof modeRec.sell_pct_thresh !== "number" || typeof modeRec.buy_pct_thresh !== "number") {
                            throw new Error("Missing cached thresholds.");
                        }
                        const data = await getStockData(upper);
                        const prices = data && Array.isArray(data.prices) ? data.prices : [];
                        if (!prices.length)
                            throw new Error("No price data.");
                        const newRes = runUsingExistingCalcs(prices, modeKey, modeRec);
                        newRes.calc_used = modeRec.calc_used || `Using cached ${modeKey} settings`;
                        newRes.updated_at = new Date().toISOString();
                        newRes.updated_date = new Date().toLocaleDateString();
                        updateSavedRunOutputs(saved, upper, modeKey, newRes);
                        renderSavedList();
                    }
                    catch (e) {
                        console.warn(`[Reload all] ${upper} failed:`, e);
                    }
                    finally {
                        completed++;
                        const pct = total > 0 ? Math.round((completed * 100) / total) : 100;
                        setProgress(pct, `Reloaded ${completed}/${total}`, { raw: true, scope: "reloadAll" });
                        resolve();
                    }
                }, idx * RELOAD_ALL_STAGGER_MS);
            });
        });
        await Promise.all(tasks);
        saveSaved(saved);
        renderSavedList();
        setStatus("Reload complete.");
        setProgress(100, "Reload complete.", { raw: true, scope: "reloadAll" });
    }
    finally {
        reloadAllInProgress = false;
        reloadSavedBtn.disabled = false;
        runButton.disabled = false;
    }
}
function renderSavedList() {
    const saved = loadSaved();
    const symbols = Object.keys(saved);
    if (!symbols.length) {
        savedList.innerHTML =
            '<div class="saved-empty">No saved symbols yet. Run a simulation to save one.</div>';
        return;
    }
    const records = symbols.map((sym) => {
        const rec = saved[sym] || {};
        const modes = (rec && typeof rec === "object" && rec.modes) ? rec.modes : {};
        const displayMode = modes[MODE_PRECISE] ? MODE_PRECISE : (modes[MODE_QUICK] ? MODE_QUICK : (rec.last_run_mode || MODE_QUICK));
        const displayRec = (modes && modes[displayMode]) ? modes[displayMode] : rec;
        const profit = (displayRec && typeof displayRec.profit === "number") ? displayRec.profit : 0;
        const startWallet = displayRec && typeof displayRec.start_wallet === "number" && isFinite(displayRec.start_wallet)
            ? displayRec.start_wallet
            : START_WALLET;
        const profitPct = startWallet > 0 && isFinite(startWallet)
            ? (profit / startWallet) * 100
            : 0;
        const dec = (displayRec && displayRec.last_decision) ? displayRec.last_decision : "HOLD";
        const amtRaw = (displayRec && displayRec.last_amount != null) ? displayRec.last_amount : "";
        const amtLabel = (typeof amtRaw === "string") ? amtRaw : ((typeof amtRaw === "number" && amtRaw > 0) ? String(amtRaw) : "");
        const isAction = (dec === "BUY" || dec === "SELL");
        return {
            ...rec,
            symbol: sym,
            _displayMode: displayMode,
            _displayRec: displayRec,
            _profitPct: profitPct,
            _isAction: isAction
        };
    });
    records.sort((a, b) => {
        if (a._isAction !== b._isAction)
            return a._isAction ? -1 : 1;
        return (b._profitPct || 0) - (a._profitPct || 0);
    });
    let html = "";
    for (const rec of records) {
        const sym = rec.symbol;
        const displayRec = rec._displayRec || rec;
        const profit = (displayRec && typeof displayRec.profit === "number") ? displayRec.profit : 0;
        let lastPrice = (displayRec && typeof displayRec.last_price === "number") ? displayRec.last_price : 0;
        try {
            const cached = getCachedPricesIfFresh(sym);
            if (cached && Array.isArray(cached.prices) && cached.prices.length) {
                const p = cached.prices[cached.prices.length - 1];
                if (typeof p === "number" && isFinite(p))
                    lastPrice = p;
            }
        }
        catch (e) {
        }
        const profitPct = rec._profitPct || 0;
        const profitPctText = (profitPct >= 0 ? "+" : "-") + Math.abs(profitPct).toFixed(2) + "%";
        const profitClass = profit >= 0 ? "saved-profit-positive" : "saved-profit-negative";
        const dec = (displayRec && displayRec.last_decision) ? displayRec.last_decision : "HOLD";
        const amtRaw = (displayRec && displayRec.last_amount != null) ? displayRec.last_amount : "";
        const amtLabel = (typeof amtRaw === "string") ? amtRaw : ((typeof amtRaw === "number" && amtRaw > 0) ? String(amtRaw) : "");
        let decisionLabel = "HOLD";
        let decisionColor = "#9ca3af";
        if (dec === "BUY" || dec === "SELL") {
            decisionLabel = dec;
            decisionColor = dec === "BUY" ? "#4ade80" : "#f97373";
        }
        html += `
      <button type="button" class="saved-btn" data-symbol="${sym}">
        <div class="saved-grid"
             style="display:grid;
                    grid-template-columns: 1fr auto;
                    grid-auto-rows:auto;
                    row-gap:2px;">
          <!-- row 1 -->
          <div class="saved-symbol">${sym}</div>
          <div class="saved-profit-cell"
               style="display:flex; justify-content:flex-end; align-items:center;">
            <!-- TOP RIGHT: price + reload -->
            <span class="saved-last-price">
              $${Number(lastPrice || 0).toFixed(2)}
            </span>
            <span class="saved-reload"
                  data-symbol="${sym}"
                  title="Reload: single click = reuse cached calcs; double click = clear caches + rerun">⟳</span>
          </div>

          <!-- row 2 -->
          <div class="saved-decision"
               style="color:${decisionColor}; font-weight:600;">
            ${decisionLabel}
          </div>

          <div class="saved-profit ${profitClass}"
               style="text-align:right;">
            ${profitPctText}
            <span class="saved-delete"
                  data-symbol="${sym}"
                  title="Remove ${sym}">✕</span>
          </div>
        </div>
      </button>
    `;
    }
    savedList.innerHTML = html;
    if (currentSymbol) {
        markCurrentSymbol(currentSymbol);
    }
}
function markCurrentSymbol(symbol) {
    if (!symbol)
        return;
    currentSymbol = symbol.toUpperCase();
    if (!savedList)
        return;
    const btns = savedList.querySelectorAll(".saved-btn");
    btns.forEach((btn) => {
        const isActive = btn.dataset.symbol === currentSymbol;
        if (isActive) {
            btn.classList.add("saved-btn-active");
        }
        else {
            btn.classList.remove("saved-btn-active");
        }
    });
}
async function searchSymbolAlpha(query) {
    const apiKey = getIdent();
    const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.bestMatches)) {
        return null;
    }
    const best = data.bestMatches[0];
    if (!best)
        return null;
    const symbol = best["1. symbol"];
    const name = best["2. name"];
    if (!symbol)
        return null;
    return { symbol, name };
}
function normalizeNameKey(str) {
    return str.trim().toLowerCase().replace(/[.,']/g, "");
}
async function resolveSymbol(inputStr) {
    const raw = inputStr.trim();
    if (!raw)
        throw new Error("Please enter a symbol or company name.");
    const upper = raw.toUpperCase();
    if (/^[A-Z.]{1,5}$/.test(upper) && !raw.includes(" ")) {
        return { symbol: upper, name: upper };
    }
    const key = normalizeNameKey(raw);
    const map = loadNameMap();
    if (map[key]) {
        return { symbol: map[key], name: raw };
    }
    const builtin = BUILTIN_NAME_MAP[key];
    if (builtin) {
        const extra = loadNameMap();
        extra[key] = builtin;
        saveNameMap(extra);
        return { symbol: builtin, name: raw };
    }
    const res = await searchSymbolAlpha(raw);
    if (!res)
        throw new Error("Could not resolve symbol for: " + raw);
    const extra = loadNameMap();
    extra[key] = res.symbol;
    saveNameMap(extra);
    return res;
}
async function fetchStockDataFromApi(symbol) {
    const apiKey = getIdent();
    const baseUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
    let url = baseUrl + "&outputsize=compact";
    let data = await fetchJson(url);
    let info = (data && (data.Information || data.Note)) || "";
    if (!data["Time Series (Daily)"] &&
        typeof info === "string" &&
        info.toLowerCase().includes("outputsize=compact")) {
        console.warn("outputsize=compact is premium; retrying with compact");
        url = baseUrl + "&outputsize=compact";
        data = await fetchJson(url);
    }
    if (!data || !data["Time Series (Daily)"]) {
        console.log("AlphaVantage response:", data);
        if (data && (data.Note || data.Information)) {
            throw new Error(data.Note || data.Information);
        }
        if (data && data["Error Message"]) {
            throw new Error("API error: " + data["Error Message"]);
        }
        throw new Error("Unexpected API response.");
    }
    const series = data["Time Series (Daily)"];
    const entries = Object.entries(series).map(([dateStr, daily]) => ({
        dateStr,
        price: parseFloat(daily["4. close"])
    }));
    entries.sort((a, b) => (a.dateStr < b.dateStr ? -1 : 1));
    const dates = entries.map((e) => e.dateStr);
    const prices = entries.map((e) => e.price);
    if (!prices.length)
        throw new Error("No prices for " + symbol);
    return { dates, prices };
}
async function getStockData(symbol) {
    const sym = symbol.toUpperCase();
    const cached = getCachedPricesIfFresh(sym);
    if (cached) {
        setStatus(`Using cached prices for ${sym} (fetched earlier today).`);
        return cached;
    }
    setStatus(`Fetching stock data for ${sym}...`);
    const { dates, prices } = await fetchStockDataFromApi(sym);
    savePriceCache(sym, dates, prices);
    return { dates, prices };
}
function biasedTrader(prices, startWallet, sellPctThresh, buyPctThresh, maxLookbackDays, trackOrOptions = false) {
    if (!prices || prices.length === 0) {
        return {
            start_wallet: startWallet,
            final_wallet: startWallet,
            final_shares: [],
            final_value: startWallet,
            profit: 0,
            sell_pct_thresh: sellPctThresh,
            buy_pct_thresh: buyPctThresh,
            last_decision: "HOLD",
            last_amount: 0,
            last_action_price: 0,
            last_price: 0,
            equity_curve: null,
            buy_markers: null,
            sell_markers: null,
            shares_held: null,
            wallet_series: null,
            position_scale: 1.0,
            min_hold_days: 0,
            long_term_ratio: 0.0,
            long_term_min_hold_days: 0,
            regime_sensitivity: REGIME_SENS_DEFAULT,
            regime_window_days: REGIME_WINDOW_DAYS,
            regime_trend_days: REGIME_TREND_DAYS,
            regime_range_pct: REGIME_RANGE_PCT
        };
    }
    let options = {};
    let trackCurve = false;
    if (typeof trackOrOptions === "boolean" || trackOrOptions == null) {
        trackCurve = !!trackOrOptions;
        options = {};
    }
    else {
        options = trackOrOptions || {};
        trackCurve = !!options.trackCurve;
    }
    const positionScale = clamp(typeof options.positionScale === "number" ? options.positionScale : 1.0, 0.25, 4.0);
    const minHoldDays = Math.max(0, Math.floor(typeof options.minHoldDays === "number" ? options.minHoldDays : 0));
    const longTermRatio = clamp(typeof options.longTermRatio === "number" ? options.longTermRatio : 0.0, 0.0, 0.9);
    const longTermMinHoldDays = Math.max(0, Math.floor(typeof options.longTermMinHoldDays === "number"
        ? options.longTermMinHoldDays
        : 0));
    const regimeSensitivity = clamp(typeof options.regimeSensitivity === "number"
        ? options.regimeSensitivity
        : REGIME_SENS_DEFAULT, 0.0, 2.0);
    const regimeWindowDays = Math.max(3, Math.floor(typeof options.regimeWindowDays === "number"
        ? options.regimeWindowDays
        : REGIME_WINDOW_DAYS));
    const regimeTrendDays = Math.max(2, Math.floor(typeof options.regimeTrendDays === "number"
        ? options.regimeTrendDays
        : REGIME_TREND_DAYS));
    const regimeRangePct = Math.max(5, typeof options.regimeRangePct === "number"
        ? options.regimeRangePct
        : REGIME_RANGE_PCT);
    const smoothAlpha = clamp(typeof options.smoothAlpha === "number" ? options.smoothAlpha : 0.35, 0.05, 0.9);
    const smoothMix = clamp(typeof options.smoothMix === "number" ? options.smoothMix : 0.65, 0.0, 1.0);
    const noiseWindowDays = Math.max(2, Math.floor(typeof options.noiseWindowDays === "number" ? options.noiseWindowDays : 7));
    const noiseTargetPct = Math.max(0.1, typeof options.noiseTargetPct === "number" ? options.noiseTargetPct : 1.2);
    const noiseSensitivity = clamp(typeof options.noiseSensitivity === "number" ? options.noiseSensitivity : 0.75, 0.0, 2.0);
    const curveSensitivity = clamp(typeof options.curveSensitivity === "number" ? options.curveSensitivity : 0.9, 0.0, 2.0);
    const curveTrendDays = Math.max(2, Math.floor(typeof options.curveTrendDays === "number" ? options.curveTrendDays : 6));
    const curveSlopePct = Math.max(0.5, typeof options.curveSlopePct === "number" ? options.curveSlopePct : 6.0);
    const curveCurvPct = Math.max(0.1, typeof options.curveCurvPct === "number" ? options.curveCurvPct : 1.5);
    const weeklyDays = 5;
    const weeklyReturnThreshPct = Math.max(0.5, typeof options.weeklyReturnThreshPct === "number" ? options.weeklyReturnThreshPct : 4.0);
    const weeklyRangeTargetPct = Math.max(1.0, typeof options.weeklyRangeTargetPct === "number" ? options.weeklyRangeTargetPct : 6.0);
    const weeklyTrendWeight = clamp(typeof options.weeklyTrendWeight === "number" ? options.weeklyTrendWeight : 0.7, 0.0, 2.0);
    const weeklyReversionWeight = clamp(typeof options.weeklyReversionWeight === "number" ? options.weeklyReversionWeight : 0.55, 0.0, 2.0);
    const weeklyVolPenaltyWeight = clamp(typeof options.weeklyVolPenaltyWeight === "number" ? options.weeklyVolPenaltyWeight : 0.35, 0.0, 2.0);
    const weeklyBreakoutPct = Math.max(0.0, typeof options.weeklyBreakoutPct === "number" ? options.weeklyBreakoutPct : 1.0);
    const smoothPrices = new Array(prices.length);
    const decisionPrices = new Array(prices.length);
    const safePrice = (v, fallback) => {
        if (typeof v === "number" && isFinite(v) && v > 0)
            return v;
        return typeof fallback === "number" && isFinite(fallback) && fallback > 0
            ? fallback
            : 0;
    };
    smoothPrices[0] = safePrice(prices[0], 0);
    decisionPrices[0] = smoothPrices[0];
    for (let i = 1; i < prices.length; i++) {
        const raw = safePrice(prices[i], prices[i - 1]);
        const prevS = safePrice(smoothPrices[i - 1], raw);
        const s = prevS * (1 - smoothAlpha) + raw * smoothAlpha;
        smoothPrices[i] = s;
        decisionPrices[i] = raw * (1 - smoothMix) + s * smoothMix;
    }
    let wallet = startWallet;
    let lots = [];
    let lastDecision = "HOLD";
    let lastAmount = 0;
    let lastActionPrice = 0;
    let equityCurve = null;
    let buyMarkers = null;
    let sellMarkers = null;
    let sharesHeld = null;
    let walletSeries = null;
    if (trackCurve) {
        equityCurve = [];
        buyMarkers = new Array(prices.length).fill(0);
        sellMarkers = new Array(prices.length).fill(0);
        sharesHeld = new Array(prices.length).fill(0);
        walletSeries = new Array(prices.length).fill(0);
        const p0 = safePrice(prices[0], 0);
        const totalShares0 = lots.reduce((acc, lot) => acc + lot.amount, 0);
        const totalVal0 = wallet + totalShares0 * p0;
        equityCurve.push(totalVal0);
        sharesHeld[0] = totalShares0;
        walletSeries[0] = wallet;
    }
    for (let i = 1; i < prices.length; i++) {
        const rawPrice = safePrice(prices[i], prices[i - 1]);
        const dPrice = safePrice(decisionPrices[i], rawPrice);
        lastDecision = "HOLD";
        lastAmount = 0;
        lastActionPrice = 0;
        const wStart = Math.max(0, i - regimeWindowDays);
        let wMin = Infinity;
        let wMax = -Infinity;
        for (let j = wStart; j <= i; j++) {
            const v = decisionPrices[j];
            if (v > 0) {
                if (v < wMin)
                    wMin = v;
                if (v > wMax)
                    wMax = v;
            }
        }
        if (!isFinite(wMin) || !isFinite(wMax) || wMin <= 0) {
            wMin = dPrice;
            wMax = dPrice;
        }
        const wRange = wMax - wMin;
        const rangePct = wMin > 0 ? (wRange / wMin) * 100 : 0;
        const posInRange = wRange > 0 ? (dPrice - wMin) / wRange : 0.5;
        const tIdx = Math.max(0, i - regimeTrendDays);
        const tRef = decisionPrices[tIdx];
        const trendPct = tRef > 0 ? ((dPrice - tRef) / tRef) * 100 : 0;
        const rangeStrength = clamp((rangePct - regimeRangePct) / regimeRangePct, 0, 2) / 2;
        const posHighStrength = clamp((posInRange - 0.75) / 0.25, 0, 1);
        const posLowStrength = clamp((0.25 - posInRange) / 0.25, 0, 1);
        const trendUpStrength = clamp((trendPct - regimeRangePct) / regimeRangePct, 0, 2) / 2;
        const trendDownStrength = clamp(((-trendPct) - regimeRangePct) / regimeRangePct, 0, 2) / 2;
        const overextendedStrength = rangeStrength * Math.max(posHighStrength, trendUpStrength);
        const oversoldStrength = rangeStrength * Math.max(posLowStrength, trendDownStrength);
        let effSellPctThresh = sellPctThresh;
        let effBuyPctThresh = buyPctThresh;
        let effPositionScale = positionScale;
        if (overextendedStrength > 0) {
            effBuyPctThresh =
                buyPctThresh * (1 + regimeSensitivity * 1.25 * overextendedStrength);
            effSellPctThresh = Math.max(0.5, sellPctThresh * (1 - regimeSensitivity * 0.25 * overextendedStrength));
            effPositionScale = clamp(effPositionScale * (1 - regimeSensitivity * 0.7 * overextendedStrength), 0.25, 4.0);
        }
        else if (oversoldStrength > 0) {
            effBuyPctThresh = Math.max(0.5, buyPctThresh * (1 - regimeSensitivity * 0.45 * oversoldStrength));
            effPositionScale = clamp(effPositionScale * (1 + regimeSensitivity * 0.9 * oversoldStrength), 0.25, 4.0);
        }
        const nStart = Math.max(1, i - noiseWindowDays + 1);
        let absSum = 0;
        let absN = 0;
        for (let j = nStart; j <= i; j++) {
            const a = decisionPrices[j - 1];
            const b = decisionPrices[j];
            if (a > 0 && b > 0) {
                absSum += Math.abs(((b - a) / a) * 100);
                absN++;
            }
        }
        const noisePct = absN > 0 ? absSum / absN : 0;
        const noiseStrength = clamp((noisePct - noiseTargetPct) / noiseTargetPct, 0, 2) / 2;
        if (noiseStrength > 0) {
            effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 + noiseSensitivity * 0.8 * noiseStrength));
            effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 - noiseSensitivity * 0.15 * noiseStrength));
            effPositionScale = clamp(effPositionScale * (1 - noiseSensitivity * 0.6 * noiseStrength), 0.25, 4.0);
        }
        const cIdx = Math.max(0, i - curveTrendDays);
        const cRef = decisionPrices[cIdx];
        const slopePct = cRef > 0 ? ((dPrice - cRef) / cRef) * 100 : 0;
        const iPrev = Math.max(1, i - 1);
        const cPrevIdx = Math.max(0, iPrev - curveTrendDays);
        const cPrevRef = decisionPrices[cPrevIdx];
        const slopePrevPct = cPrevRef > 0 ? ((decisionPrices[iPrev] - cPrevRef) / cPrevRef) * 100 : 0;
        const curvPct = slopePct - slopePrevPct;
        const upStrength = slopePct > 0
            ? (clamp((slopePct - curveSlopePct) / curveSlopePct, 0, 2) / 2)
            : 0;
        const downStrength = slopePct < 0
            ? (clamp(((-slopePct) - curveSlopePct) / curveSlopePct, 0, 2) / 2)
            : 0;
        const accelUpStrength = curvPct > 0
            ? (clamp((curvPct - curveCurvPct) / curveCurvPct, 0, 2) / 2)
            : 0;
        const accelDownStrength = curvPct < 0
            ? (clamp(((-curvPct) - curveCurvPct) / curveCurvPct, 0, 2) / 2)
            : 0;
        const curveUp = clamp(upStrength * (0.6 + 0.4 * accelUpStrength), 0, 1);
        const curveDown = clamp(downStrength * (0.6 + 0.4 * accelDownStrength), 0, 1);
        if (curveUp > 0) {
            effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 + curveSensitivity * 0.6 * curveUp));
            effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 - curveSensitivity * 0.15 * curveUp));
            effPositionScale = clamp(effPositionScale * (1 + curveSensitivity * 0.2 * curveUp), 0.25, 4.0);
        }
        else if (curveDown > 0) {
            effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 - curveSensitivity * 0.35 * curveDown));
            effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 + curveSensitivity * 0.75 * curveDown));
            effPositionScale = clamp(effPositionScale * (1 - curveSensitivity * 0.5 * curveDown), 0.25, 4.0);
        }
        if (i >= weeklyDays) {
            const w0 = Math.max(0, i - (weeklyDays - 1));
            let weekHigh = -Infinity, weekLow = Infinity;
            for (let j = w0; j <= i; j++) {
                const v = decisionPrices[j];
                if (v > 0) {
                    if (v > weekHigh)
                        weekHigh = v;
                    if (v < weekLow)
                        weekLow = v;
                }
            }
            if (!isFinite(weekHigh) || !isFinite(weekLow) || weekLow <= 0) {
                weekHigh = dPrice;
                weekLow = dPrice;
            }
            const weekRange = weekHigh - weekLow;
            const weekRangePct = weekLow > 0 ? (weekRange / weekLow) * 100 : 0;
            const weekPos = weekRange > 0 ? (dPrice - weekLow) / weekRange : 0.5;
            const ref = decisionPrices[i - weeklyDays];
            const weekRetPct = (ref > 0) ? ((dPrice - ref) / ref) * 100 : 0;
            const trendStrength = clamp(Math.abs(weekRetPct) / weeklyReturnThreshPct, 0, 2) / 2;
            const rangeStrength = clamp(weekRangePct / weeklyRangeTargetPct, 0, 2) / 2;
            if (trendStrength > 0) {
                if (weekRetPct > 0) {
                    const amt = weeklyTrendWeight * 0.18 * trendStrength;
                    effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 + amt));
                    effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 - 0.35 * amt));
                    effPositionScale = clamp(effPositionScale * (1 + 0.25 * amt), 0.25, 4.0);
                }
                else {
                    const amt = weeklyTrendWeight * 0.22 * trendStrength;
                    effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 - 0.55 * amt));
                    effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 + amt));
                    effPositionScale = clamp(effPositionScale * (1 - 0.7 * amt), 0.25, 4.0);
                }
            }
            if (rangeStrength > 0) {
                const centerBias = (weekPos - 0.5) * 2;
                const amt = weeklyReversionWeight * 0.20 * rangeStrength;
                if (centerBias > 0) {
                    effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 - amt * centerBias));
                    effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 + 0.6 * amt * centerBias));
                }
                else if (centerBias < 0) {
                    effBuyPctThresh = Math.max(0.5, effBuyPctThresh * (1 - amt * (-centerBias)));
                    effSellPctThresh = Math.max(0.5, effSellPctThresh * (1 + 0.45 * amt * (-centerBias)));
                }
            }
            if (weeklyVolPenaltyWeight > 0 && weekRangePct > weeklyRangeTargetPct) {
                const volStr = clamp((weekRangePct - weeklyRangeTargetPct) / weeklyRangeTargetPct, 0, 2) / 2;
                const mult = 1 + weeklyVolPenaltyWeight * 1.2 * volStr;
                effPositionScale = clamp(effPositionScale / mult, 0.25, 4.0);
            }
            if (weeklyBreakoutPct > 0 && i >= weeklyDays + 1) {
                let prevHigh = -Infinity;
                for (let j = i - weeklyDays; j <= i - 1; j++) {
                    const v = decisionPrices[j];
                    if (v > 0 && v > prevHigh)
                        prevHigh = v;
                }
                if (isFinite(prevHigh) && prevHigh > 0) {
                    const brokeOut = dPrice > prevHigh * (1 + weeklyBreakoutPct / 100);
                    if (brokeOut) {
                        effSellPctThresh = Math.max(0.5, effSellPctThresh * 1.18);
                    }
                }
            }
        }
        if (lots.length) {
            const hasShortLots = lots.some((lot) => !lot.isLong);
            for (let idx = lots.length - 1; idx >= 0; idx--) {
                const lot = lots[idx];
                const buyPrice = lot.buyPrice;
                const buyDPrice = lot.buyDecisionPrice;
                const amount = lot.amount;
                if (amount <= 0 || buyPrice <= 0) {
                    lots.splice(idx, 1);
                    continue;
                }
                const requiredHold = lot.isLong ? longTermMinHoldDays : minHoldDays;
                const heldDays = i - lot.buyIndex;
                if (requiredHold > 0 && heldDays < requiredHold)
                    continue;
                if (lot.isLong && hasShortLots)
                    continue;
                const signalProfitPct = buyDPrice > 0 ? ((dPrice - buyDPrice) / buyDPrice) * 100 : 0;
                const realProfitPct = buyPrice > 0 ? ((rawPrice - buyPrice) / buyPrice) * 100 : 0;
                if (rawPrice > buyPrice && signalProfitPct > effSellPctThresh && realProfitPct > 0) {
                    wallet += amount * rawPrice;
                    lots.splice(idx, 1);
                    lastAmount += amount;
                    lastActionPrice = rawPrice;
                    lastDecision = "SELL";
                }
            }
        }
        if (wallet > rawPrice) {
            let highestPercent = 0.0;
            const maxBack = clamp(maxLookbackDays + 1, 1, i);
            for (let x = 1; x < maxBack; x++) {
                const prevD = decisionPrices[i - x];
                if (dPrice < prevD && prevD > 0) {
                    const dropPct = ((dPrice - prevD) / prevD) * 100;
                    if (dropPct < highestPercent) {
                        highestPercent = dropPct;
                    }
                }
            }
            if (highestPercent < -effBuyPctThresh) {
                let amount = 0;
                const maxSteps = Math.floor(Math.abs(highestPercent) * effPositionScale);
                for (let step = 1; step <= maxSteps; step++) {
                    if (wallet > rawPrice) {
                        wallet -= rawPrice;
                        amount += 1;
                    }
                    else {
                        break;
                    }
                }
                if (amount > 0) {
                    const longAmount = longTermRatio > 0 ? Math.floor(amount * longTermRatio) : 0;
                    const shortAmount = amount - longAmount;
                    if (shortAmount > 0) {
                        lots.push({
                            buyPrice: rawPrice,
                            buyDecisionPrice: dPrice,
                            amount: shortAmount,
                            buyIndex: i,
                            isLong: false
                        });
                    }
                    if (longAmount > 0) {
                        lots.push({
                            buyPrice: rawPrice,
                            buyDecisionPrice: dPrice,
                            amount: longAmount,
                            buyIndex: i,
                            isLong: true
                        });
                    }
                    lastAmount = amount;
                    lastActionPrice = rawPrice;
                    lastDecision = "BUY";
                }
            }
        }
        if (trackCurve) {
            const totalShares = lots.reduce((acc, lot) => acc + lot.amount, 0);
            const totalVal = wallet + totalShares * rawPrice;
            equityCurve.push(totalVal);
            sharesHeld[i] = totalShares;
            walletSeries[i] = wallet;
            if (lastDecision === "BUY" && lastAmount > 0) {
                buyMarkers[i] = lastAmount;
            }
            else if (lastDecision === "SELL" && lastAmount > 0) {
                sellMarkers[i] = lastAmount;
            }
        }
    }
    const lastPrice = safePrice(prices[prices.length - 1], prices[prices.length - 2]);
    const totalSharesFinal = lots.reduce((acc, lot) => acc + lot.amount, 0);
    const finalValue = wallet + totalSharesFinal * lastPrice;
    const profit = finalValue - startWallet;
    return {
        start_wallet: startWallet,
        final_wallet: wallet,
        final_shares: lots,
        final_value: finalValue,
        profit,
        sell_pct_thresh: sellPctThresh,
        buy_pct_thresh: buyPctThresh,
        last_decision: lastDecision,
        last_amount: lastAmount,
        last_action_price: lastActionPrice,
        last_price: lastPrice,
        equity_curve: equityCurve,
        buy_markers: buyMarkers,
        sell_markers: sellMarkers,
        shares_held: sharesHeld,
        wallet_series: walletSeries,
        position_scale: positionScale,
        min_hold_days: minHoldDays,
        long_term_ratio: longTermRatio,
        long_term_min_hold_days: longTermMinHoldDays,
        regime_sensitivity: regimeSensitivity,
        regime_window_days: regimeWindowDays,
        regime_trend_days: regimeTrendDays,
        regime_range_pct: regimeRangePct,
        smooth_alpha: smoothAlpha,
        smooth_mix: smoothMix,
        noise_window_days: noiseWindowDays,
        noise_target_pct: noiseTargetPct,
        noise_sensitivity: noiseSensitivity,
        curve_sensitivity: curveSensitivity,
        curve_trend_days: curveTrendDays,
        curve_slope_pct: curveSlopePct,
        curve_curv_pct: curveCurvPct
    };
}
const SIZE_LOW = "LOW";
const SIZE_MED = "MEDIUM";
const SIZE_HIGH = "HIGH";
function _sizeFromScore(score) {
    if (!isFinite(score) || score <= 0)
        return null;
    if (score < 0.60)
        return SIZE_LOW;
    if (score < 3)
        return SIZE_MED;
    return SIZE_HIGH;
}
function _sizeFraction(size) {
    if (size === SIZE_LOW)
        return 0.15;
    if (size === SIZE_MED)
        return 0.35;
    if (size === SIZE_HIGH)
        return 0.65;
    return 0.0;
}
function computeRegimeAtIndex(prices, i, baseParams) {
    const price = prices[i];
    const regimeSensitivity = clamp(typeof baseParams.regime_sensitivity === "number" ? baseParams.regime_sensitivity : REGIME_SENS_DEFAULT, 0.0, 2.0);
    const regimeWindowDays = Math.max(3, Math.floor(typeof baseParams.regime_window_days === "number" ? baseParams.regime_window_days : REGIME_WINDOW_DAYS));
    const regimeTrendDays = Math.max(2, Math.floor(typeof baseParams.regime_trend_days === "number" ? baseParams.regime_trend_days : REGIME_TREND_DAYS));
    const regimeRangePct = Math.max(5, typeof baseParams.regime_range_pct === "number" ? baseParams.regime_range_pct : REGIME_RANGE_PCT);
    const sellPctThresh = typeof baseParams.sell_pct_thresh === "number" ? baseParams.sell_pct_thresh : 0;
    const buyPctThresh = typeof baseParams.buy_pct_thresh === "number" ? baseParams.buy_pct_thresh : 0;
    const wStart = Math.max(0, i - regimeWindowDays);
    let wMin = Infinity;
    let wMax = -Infinity;
    for (let j = wStart; j <= i; j++) {
        const v = prices[j];
        if (v < wMin)
            wMin = v;
        if (v > wMax)
            wMax = v;
    }
    const wRange = wMax - wMin;
    const rangePct = wMin > 0 ? (wRange / wMin) * 100 : 0;
    const posInRange = wRange > 0 ? (price - wMin) / wRange : 0.5;
    const tIdx = Math.max(0, i - regimeTrendDays);
    const tRef = prices[tIdx];
    const trendPct = tRef > 0 ? ((price - tRef) / tRef) * 100 : 0;
    const rangeStrength = clamp((rangePct - regimeRangePct) / regimeRangePct, 0, 2) / 2;
    const posHighStrength = clamp((posInRange - 0.75) / 0.25, 0, 1);
    const posLowStrength = clamp((0.25 - posInRange) / 0.25, 0, 1);
    const trendUpStrength = clamp((trendPct - regimeRangePct) / regimeRangePct, 0, 2) / 2;
    const trendDownStrength = clamp(((-trendPct) - regimeRangePct) / regimeRangePct, 0, 2) / 2;
    const overextendedStrength = rangeStrength * Math.max(posHighStrength, trendUpStrength);
    const oversoldStrength = rangeStrength * Math.max(posLowStrength, trendDownStrength);
    let effSellPctThresh = sellPctThresh;
    let effBuyPctThresh = buyPctThresh;
    if (overextendedStrength > 0) {
        effBuyPctThresh = buyPctThresh * (1 + regimeSensitivity * 1.25 * overextendedStrength);
        effSellPctThresh = Math.max(0.5, sellPctThresh * (1 - regimeSensitivity * 0.25 * overextendedStrength));
    }
    else if (oversoldStrength > 0) {
        effBuyPctThresh = Math.max(0.5, buyPctThresh * (1 - regimeSensitivity * 0.45 * oversoldStrength));
    }
    return {
        effSellPctThresh,
        effBuyPctThresh,
        overextendedStrength,
        oversoldStrength,
        trendPct,
        rangePct,
        posInRange,
        regimeRangePct
    };
}
function buildSignalSeries(prices, params) {
    const method = String(params.smoothing_method || params.smoothingMethod || SMOOTH_METHOD_DEFAULT).toLowerCase();
    const alphaBase = clamp((typeof (params.smoothing_alpha_base ?? params.smoothingAlphaBase) === "number"
        ? (params.smoothing_alpha_base ?? params.smoothingAlphaBase)
        : SMOOTH_ALPHA_BASE_DEFAULT), 0.05, 0.95);
    const minA = clamp((typeof (params.smoothing_min_alpha ?? params.smoothingMinAlpha) === "number"
        ? (params.smoothing_min_alpha ?? params.smoothingMinAlpha)
        : SMOOTH_MIN_ALPHA_DEFAULT), 0.05, alphaBase);
    const maxA = clamp((typeof (params.smoothing_max_alpha ?? params.smoothingMaxAlpha) === "number"
        ? (params.smoothing_max_alpha ?? params.smoothingMaxAlpha)
        : SMOOTH_MAX_ALPHA_DEFAULT), alphaBase, 0.95);
    const noiseLB = (typeof (params.smoothing_noise_lookback_days ?? params.smoothingNoiseLookbackDays) === "number"
        ? Math.floor(params.smoothing_noise_lookback_days ?? params.smoothingNoiseLookbackDays)
        : SMOOTH_NOISE_LOOKBACK_DAYS_DEFAULT);
    const rigidity = (typeof (params.smoothing_rigidity_pct ?? params.smoothingRigidityPct) === "number"
        ? (params.smoothing_rigidity_pct ?? params.smoothingRigidityPct)
        : SMOOTH_RIGIDITY_PCT_DEFAULT);
    const adapt = (typeof (params.smoothing_adapt_strength ?? params.smoothingAdaptStrength) === "number"
        ? (params.smoothing_adapt_strength ?? params.smoothingAdaptStrength)
        : SMOOTH_ADAPT_STRENGTH_DEFAULT);
    const sig = new Array(prices.length);
    const noise = new Array(prices.length);
    sig[0] = prices[0];
    noise[0] = 0;
    for (let i = 1; i < prices.length; i++) {
        const p = prices[i];
        const nPct = avgAbsReturnPct(prices, i, noiseLB);
        noise[i] = nPct;
        if (method === "ema") {
            const ratio = rigidity > 0 ? (nPct / rigidity) : 0;
            const shrink = ratio > 1 ? (1 / (1 + adapt * (ratio - 1))) : 1;
            const a = clamp(alphaBase * shrink, minA, maxA);
            sig[i] = a * p + (1 - a) * sig[i - 1];
        }
        else {
            sig[i] = p;
        }
    }
    return { sig, noiseLB, rigidity, adapt };
}
function computeSignalSizedDecision(prices, bestParams, portfolioSnap = null) {
    if (!Array.isArray(prices) || prices.length < 3) {
        return { decision: "HOLD", size: null, score: 0, reason: "Not enough data", suggestedShares: 0 };
    }
    const i = prices.length - 1;
    const price = prices[i];
    const regime = computeRegimeAtIndex(prices, i, bestParams);
    const signalWindow = Math.max(10, Math.min(45, Math.floor((bestParams.regime_window_days ?? REGIME_WINDOW_DAYS) * 1.5)));
    const start = Math.max(0, i - signalWindow);
    let recentHigh = -Infinity;
    let recentLow = Infinity;
    for (let j = start; j <= i; j++) {
        const v = prices[j];
        if (v > recentHigh)
            recentHigh = v;
        if (v < recentLow)
            recentLow = v;
    }
    const dropFromHighPct = recentHigh > 0 ? ((recentHigh - price) / recentHigh) * 100 : 0;
    const riseFromLowPct = recentLow > 0 ? ((price - recentLow) / recentLow) * 100 : 0;
    let buyScore = 0;
    let sellScore = 0;
    if (dropFromHighPct > regime.effBuyPctThresh) {
        buyScore = (dropFromHighPct - regime.effBuyPctThresh) / Math.max(0.5, regime.effBuyPctThresh);
    }
    if (riseFromLowPct > regime.effSellPctThresh) {
        sellScore = (riseFromLowPct - regime.effSellPctThresh) / Math.max(0.5, regime.effSellPctThresh);
    }
    buyScore *= (1 + 0.80 * regime.oversoldStrength);
    sellScore *= (1 + 0.80 * regime.overextendedStrength);
    if (regime.trendPct < 0) {
        buyScore *= (1 + clamp((-regime.trendPct) / Math.max(5, regime.regimeRangePct), 0, 1));
    }
    else if (regime.trendPct > 0) {
        sellScore *= (1 + clamp((regime.trendPct) / Math.max(5, regime.regimeRangePct), 0, 1));
    }
    const minScore = 0.12;
    if (buyScore < minScore && sellScore < minScore) {
        return {
            decision: "HOLD",
            size: null,
            score: Math.max(buyScore, sellScore),
            reason: "Within thresholds",
            suggestedShares: 0,
            effBuyPctThresh: regime.effBuyPctThresh,
            effSellPctThresh: regime.effSellPctThresh
        };
    }
    const decision = buyScore >= sellScore ? "BUY" : "SELL";
    const score = Math.max(buyScore, sellScore);
    const size = _sizeFromScore(score);
    let suggestedShares = 0;
    if (portfolioSnap && price > 0 && isFinite(price) && size) {
        const frac = _sizeFraction(size);
        if (decision === "BUY") {
            const cash = typeof portfolioSnap.wallet === "number" ? portfolioSnap.wallet : 0;
            suggestedShares = Math.floor((cash * frac) / price);
        }
        else if (decision === "SELL") {
            const sh = typeof portfolioSnap.shares === "number" ? portfolioSnap.shares : 0;
            suggestedShares = Math.floor(sh * frac);
        }
    }
    return {
        decision,
        size,
        score,
        reason: decision === "BUY"
            ? `Drop from recent high ${dropFromHighPct.toFixed(1)}% vs buy ${regime.effBuyPctThresh.toFixed(1)}%`
            : `Rise from recent low ${riseFromLowPct.toFixed(1)}% vs sell ${regime.effSellPctThresh.toFixed(1)}%`,
        suggestedShares,
        effBuyPctThresh: regime.effBuyPctThresh,
        effSellPctThresh: regime.effSellPctThresh
    };
}
function buildEquityCurve(prices, sellPctThresh, buyPctThresh, positionScale, minHoldDays, longTermRatio, longTermMinHoldDays) {
    const curve = [];
    const options = {
        positionScale: positionScale ?? 1.0,
        minHoldDays: minHoldDays ?? 0,
        longTermRatio: longTermRatio ?? 0.0,
        longTermMinHoldDays: longTermMinHoldDays ?? 0,
        trackCurve: false
    };
    for (let i = 0; i < prices.length; i++) {
        const subPrices = prices.slice(0, i + 1);
        const res = biasedTrader(subPrices, START_WALLET, sellPctThresh, buyPctThresh, MAX_LOOKBACK_DAYS, options);
        curve.push(res.final_value);
    }
    return curve;
}
async function gridSearchThresholdsWithProgress(prices, startWallet, onProgress) {
    const sellValues = [];
    const buyValues = [];
    for (let i = 10; i <= 250; i += 5) {
        const v = i / 10.0;
        sellValues.push(v);
        buyValues.push(v);
    }
    const positionScales = [0.5, 0.75, 1.0, 1.25];
    const shortMinHolds = [0, 2, 5];
    const longTermRatios = [0.0, 0.25, 0.5];
    const longTermHoldDays = [0, 10, 20];
    const MIN_WALLET = 100;
    const MAX_WALLET = 10000;
    const WALLET_STEP = 100;
    const MAX_WALLET_EVALS = 30;
    const totalParamCombos = sellValues.length *
        buyValues.length *
        positionScales.length *
        shortMinHolds.length *
        longTermRatios.length *
        longTermHoldDays.length;
    const totalIters = totalParamCombos * MAX_WALLET_EVALS;
    let count = 0;
    let lastPercentShown = 0;
    let bestProfitPct = -Infinity;
    let bestResult = null;
    function snapWallet(w) {
        let snapped = Math.round(w / WALLET_STEP) * WALLET_STEP;
        if (snapped < MIN_WALLET)
            snapped = MIN_WALLET;
        if (snapped > MAX_WALLET)
            snapped = MAX_WALLET;
        return snapped;
    }
        let lastYieldTime = _nowMs();
        async function registerEvalProgress() {
            count++;
            const percent = Math.min(99, Math.floor((count * 100) / totalIters));
            if (onProgress && percent !== lastPercentShown) {
                lastPercentShown = percent;
                onProgress(percent);
            }
            const now = _nowMs();
            if (now - lastYieldTime >= 30) {
                lastYieldTime = now;
                await yieldCooperative();
            }
        }
    async function evalWallet(wallet, sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold) {
        const w = snapWallet(wallet);
        await registerEvalProgress();
        const res = biasedTrader(prices, w, sellThresh, buyThresh, MAX_LOOKBACK_DAYS, {
            positionScale: posScale,
            minHoldDays: minHold,
            longTermRatio: ltRatio,
            longTermMinHoldDays: ltHold,
            regimeSensitivity: REGIME_SENS_DEFAULT,
            regimeWindowDays: REGIME_WINDOW_DAYS,
            regimeTrendDays: REGIME_TREND_DAYS,
            regimeRangePct: REGIME_RANGE_PCT
        });
        const profit = res.profit;
        const profitPct = w > 0 && isFinite(w) ? (profit / w) * 100 : -Infinity;
        if (profitPct > bestProfitPct) {
            bestProfitPct = profitPct;
            bestResult = {
                ...res,
                sell_pct_thresh: sellThresh,
                buy_pct_thresh: buyThresh,
                position_scale: posScale,
                min_hold_days: minHold,
                long_term_ratio: ltRatio,
                long_term_min_hold_days: ltHold,
                start_wallet: w
            };
        }
        return profitPct;
    }
    async function searchBestWalletForParams(sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold) {
        let low = MIN_WALLET;
        let high = MAX_WALLET;
        let mid = (low + high) / 2;
        let bestWallet = snapWallet(mid);
        let bestPct = await evalWallet(bestWallet, sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold);
        const MAX_ITERS = 10;
        const MAX_NO_IMPROVEMENT = 3;
        let noImprovementCount = 0;
        for (let iter = 0; iter < MAX_ITERS && high - low > 2 * WALLET_STEP; iter++) {
            const beforeBestPct = bestPct;
            const left = (low + mid) / 2;
            const right = (mid + high) / 2;
            const leftPct = await evalWallet(left, sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold);
            const rightPct = await evalWallet(right, sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold);
            if (leftPct >= bestPct && leftPct >= rightPct) {
                high = mid;
                mid = left;
                bestPct = leftPct;
                bestWallet = snapWallet(left);
            }
            else if (rightPct >= bestPct && rightPct >= leftPct) {
                low = mid;
                mid = right;
                bestPct = rightPct;
                bestWallet = snapWallet(right);
            }
            else {
                low = left;
                high = right;
            }
            if (bestPct <= beforeBestPct + 1e-9) {
                noImprovementCount++;
                if (noImprovementCount >= MAX_NO_IMPROVEMENT) {
                    break;
                }
            }
            else {
                noImprovementCount = 0;
            }
        }
        const sweepLow = Math.max(MIN_WALLET, bestWallet - 300);
        const sweepHigh = Math.min(MAX_WALLET, bestWallet + 300);
        for (let w = sweepLow; w <= sweepHigh; w += WALLET_STEP) {
            await evalWallet(w, sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold);
        }
    }
    for (const sellThresh of sellValues) {
        for (const buyThresh of buyValues) {
            for (const posScale of positionScales) {
                for (const minHold of shortMinHolds) {
                    for (const ltRatio of longTermRatios) {
                        for (const ltHold of longTermHoldDays) {
                            await searchBestWalletForParams(sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold);
                        }
                    }
                }
            }
        }
    }
    onProgress(100);
    return bestResult;
}
async function gridSearchThresholdsFixedWalletWithProgress(prices, fixedWallet, onProgress) {
    const sellValues = [];
    const buyValues = [];
    for (let i = 10; i <= 250; i += 5) {
        const v = i / 10.0;
        sellValues.push(v);
        buyValues.push(v);
    }
    const positionScales = [0.5, 0.75, 1.0, 1.25];
    const shortMinHolds = [0, 2, 5];
    const longTermRatios = [0.0, 0.25, 0.5];
    const longTermHoldDays = [0, 10, 20];
    const totalIters = sellValues.length *
        buyValues.length *
        positionScales.length *
        shortMinHolds.length *
        longTermRatios.length *
        longTermHoldDays.length;
    let count = 0;
    let lastPercentShown = -1;
    let bestProfitPct = -Infinity;
    let bestResult = null;
        let lastYieldTime = _nowMs();
        async function registerEvalProgress() {
            count++;
            const percent = Math.min(99, Math.floor((count * 100) / totalIters));
            if (onProgress && percent !== lastPercentShown) {
                lastPercentShown = percent;
                onProgress(percent);
            }
            const now = _nowMs();
            if (now - lastYieldTime >= 30) {
                lastYieldTime = now;
                await yieldCooperative();
            }
        }
    for (const sellThresh of sellValues) {
        for (const buyThresh of buyValues) {
            for (const posScale of positionScales) {
                for (const minHold of shortMinHolds) {
                    for (const ltRatio of longTermRatios) {
                        for (const ltHold of longTermHoldDays) {
                            await registerEvalProgress();
                            const res = biasedTrader(prices, fixedWallet, sellThresh, buyThresh, MAX_LOOKBACK_DAYS, {
                                positionScale: posScale,
                                minHoldDays: minHold,
                                longTermRatio: ltRatio,
                                longTermMinHoldDays: ltHold,
                                regimeSensitivity: REGIME_SENS_DEFAULT,
                                regimeWindowDays: REGIME_WINDOW_DAYS,
                                regimeTrendDays: REGIME_TREND_DAYS,
                                regimeRangePct: REGIME_RANGE_PCT
                            });
                            const profitPct = fixedWallet > 0 && isFinite(fixedWallet)
                                ? (res.profit / fixedWallet) * 100
                                : -Infinity;
                            if (profitPct > bestProfitPct) {
                                bestProfitPct = profitPct;
                                bestResult = {
                                    ...res,
                                    sell_pct_thresh: sellThresh,
                                    buy_pct_thresh: buyThresh,
                                    position_scale: posScale,
                                    min_hold_days: minHold,
                                    long_term_ratio: ltRatio,
                                    long_term_min_hold_days: ltHold,
                                    start_wallet: fixedWallet,
                                    regime_sensitivity: REGIME_SENS_DEFAULT,
                                    regime_window_days: REGIME_WINDOW_DAYS,
                                    regime_trend_days: REGIME_TREND_DAYS,
                                    regime_range_pct: REGIME_RANGE_PCT
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    if (onProgress)
        onProgress(100);
    return bestResult;
}
function updateChart(symbol, dates, prices, equityCurve, buyMarkers = [], sellMarkers = [], sharesHeld = [], walletSeries = [], startWalletUsed = START_WALLET) {
    if (priceChart) {
        priceChart.destroy();
    }
    const datasets = [
        {
            label: `${symbol.toUpperCase()} Price`,
            data: prices,
            borderWidth: 1.5,
            pointRadius: 0,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.15)",
            tension: 0.15
        }
    ];
    let normalizedSim = null;
    if (equityCurve && equityCurve.length === prices.length) {
        normalizedSim = equityCurve.map((totalVal, idx) => {
            const price = prices[idx];
            if (!isFinite(totalVal) || !isFinite(price) || startWalletUsed === 0) {
                return null;
            }
            return (totalVal / startWalletUsed) * price;
        });
        datasets.push({
            label: "Simulation value",
            data: normalizedSim,
            borderWidth: 1.5,
            pointRadius: 0,
            borderColor: "#22c55e",
            backgroundColor: "rgba(34,197,94,0.15)",
            tension: 0.15
        });
        if (normalizedSim) {
            const buyPoints = dates.map((date, i) => {
                const shares = (buyMarkers && buyMarkers[i]) || 0;
                const y = normalizedSim[i];
                return {
                    x: date,
                    y: shares > 0 && isFinite(y) ? y : NaN,
                    shares
                };
            });
            const sellPoints = dates.map((date, i) => {
                const shares = (sellMarkers && sellMarkers[i]) || 0;
                const y = normalizedSim[i];
                return {
                    x: date,
                    y: shares > 0 && isFinite(y) ? y : NaN,
                    shares
                };
            });
            datasets.push({
                type: "scatter",
                label: "Buys",
                data: buyPoints,
                showLine: false,
                borderColor: "#22c55e",
                backgroundColor: "#22c55e",
                pointStyle: "circle",
                pointRadius: (ctx) => {
                    const s = ctx.raw && ctx.raw.shares;
                    return s > 0 ? 4 : 0;
                },
                pointHoverRadius: (ctx) => {
                    const s = ctx.raw && ctx.raw.shares;
                    return s > 0 ? 6 : 0;
                },
                hitRadius: (ctx) => {
                    const s = ctx.raw && ctx.raw.shares;
                    return s > 0 ? 6 : 0;
                }
            });
            datasets.push({
                type: "scatter",
                label: "Sells",
                data: sellPoints,
                showLine: false,
                borderColor: "#ef4444",
                backgroundColor: "#ef4444",
                pointStyle: "cross",
                borderWidth: 3,
                pointRadius: (ctx) => {
                    const s = ctx.raw && ctx.raw.shares;
                    return s > 0 ? 6 : 0;
                },
                pointHoverRadius: (ctx) => {
                    const s = ctx.raw && ctx.raw.shares;
                    return s > 0 ? 8 : 0;
                },
                hitRadius: (ctx) => {
                    const s = ctx.raw && ctx.raw.shares;
                    return s > 0 ? 8 : 0;
                }
            });
        }
    }
    datasets.push({
        label: "Wallet",
        data: walletSeries,
        type: "line",
        yAxisID: "yHidden",
        borderWidth: 0,
        pointRadius: 0,
        hitRadius: 0,
        backgroundColor: "rgba(0,0,0,0)",
        borderColor: "rgba(0,0,0,0)"
    });
    datasets.push({
        label: "Shares",
        data: sharesHeld,
        type: "line",
        yAxisID: "yHidden",
        borderWidth: 0,
        pointRadius: 0,
        hitRadius: 0,
        backgroundColor: "rgba(0,0,0,0)",
        borderColor: "rgba(0,0,0,0)"
    });
    priceChart = new Chart(chartCanvas.getContext("2d"), {
        type: "line",
        data: {
            labels: dates,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: "index",
                intersect: false
            },
            plugins: {
                legend: {
                    labels: {
                        color: "#e5e7eb",
                        filter: (item) => item.text !== "Wallet" && item.text !== "Shares"
                    }
                },
                tooltip: {
                    position: "dynamicSide",
                    mode: "index",
                    intersect: false,
                    displayColors: false,
                    padding: 6,
                    bodySpacing: 2,
                    boxPadding: 4,
                    yAlign: "center",
                    caretPadding: 10,
                    itemSort: function (a, b) {
                        const la = a.dataset.label || "";
                        const lb = b.dataset.label || "";
                        const isMarkerA = la === "Buys" || la === "Sells";
                        const isMarkerB = lb === "Buys" || lb === "Sells";
                        const isWalletA = la === "Wallet";
                        const isWalletB = lb === "Wallet";
                        const isSharesA = la === "Shares";
                        const isSharesB = lb === "Shares";
                        const groupA = isSharesA ? 3 : isWalletA ? 2 : isMarkerA ? 1 : 0;
                        const groupB = isSharesB ? 3 : isWalletB ? 2 : isMarkerB ? 1 : 0;
                        if (groupA !== groupB)
                            return groupA - groupB;
                        const ya = a.parsed && isFinite(a.parsed.y) ? a.parsed.y : -Infinity;
                        const yb = b.parsed && isFinite(b.parsed.y) ? b.parsed.y : -Infinity;
                        return yb - ya;
                    },
                    callbacks: {
                        labelTextColor: function (context) {
                            const lbl = context.dataset.label || "";
                            if (lbl === "Simulation value")
                                return "#22c55e";
                            if (lbl.endsWith(" Price"))
                                return "#3b82f6";
                            if (lbl === "Buys")
                                return "#22c55e";
                            if (lbl === "Sells")
                                return "#ef4444";
                            if (lbl === "Wallet")
                                return "#e5e7eb";
                            if (lbl === "Shares")
                                return "#e5e7eb";
                            return "#e5e7eb";
                        },
                        label: function (context) {
                            const dsLabel = context.dataset.label || "";
                            if (dsLabel === "Wallet") {
                                const v = context.parsed && context.parsed.y;
                                if (!isFinite(v))
                                    return "";
                                return `Wallet: ${formatMoney(v, false)}`;
                            }
                            if (dsLabel === "Shares") {
                                const v = context.parsed && context.parsed.y;
                                if (!isFinite(v))
                                    return "";
                                return `Shares: ${Math.round(v)}`;
                            }
                            if (dsLabel === "Buys" || dsLabel === "Sells") {
                                const raw = context.raw || {};
                                const shares = raw.shares != null ? raw.shares : 0;
                                if (shares <= 0)
                                    return "";
                                const action = dsLabel === "Buys" ? "Buy" : "Sell";
                                return `${action} ${shares} shares`;
                            }
                            const v = context.parsed.y;
                            return `${dsLabel}: ${formatMoney(v, false)}`;
                        }
                    }
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: "x"
                    },
                    zoom: {
                        wheel: { enabled: true },
                        pinch: { enabled: true },
                        mode: "x"
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        maxTicksLimit: 8,
                        color: "#9ca3af"
                    },
                    grid: {
                        color: "rgba(148,163,184,0.2)"
                    }
                },
                y: {
                    position: "left",
                    beginAtZero: false,
                    ticks: {
                        color: "#9ca3af",
                        callback: function (value) {
                            const v = typeof value === "number" ? value : Number(value);
                            if (!isFinite(v))
                                return "";
                            const rounded = Math.round(v);
                            return "$" + rounded.toString();
                        }
                    },
                    grid: {
                        color: "rgba(148,163,184,0.2)"
                    }
                },
                yHidden: {
                    display: false,
                    grid: { display: false },
                    ticks: {
                        display: false
                    }
                }
            }
        }
    });
}
function saveBestResult(symbol, result, { mode = MODE_PRECISE, calcUsed = "" } = {}) {
    const sym = (symbol || "").toUpperCase();
    if (!sym)
        return;
    const saved = loadSaved();
    const prev = saved[sym] || {};
    const prevStar = prev.starred || false;
    const modeKey = mode === MODE_QUICK ? MODE_QUICK : MODE_PRECISE;
    if (!prev.modes)
        prev.modes = {};
    const hasPreciseAlready = !!prev.modes[MODE_PRECISE];
    if (modeKey === MODE_QUICK && hasPreciseAlready) {
        saved[sym] = {
            ...(saved[sym] || {}),
            symbol: sym,
            modes: prev.modes,
            starred: prevStar,
            last_run_mode: MODE_PRECISE,
            calc_used: (prev.modes[MODE_PRECISE] && prev.modes[MODE_PRECISE].calc_used) || prev.calc_used || "Precise"
        };
        saveSaved(saved);
        return;
    }
    const modeRecord = {
        symbol: sym,
        start_wallet: typeof result.start_wallet === "number" && isFinite(result.start_wallet)
            ? result.start_wallet
            : modeKey === MODE_QUICK
                ? QUICK_START_WALLET
                : START_WALLET,
        sell_pct_thresh: result.sell_pct_thresh,
        buy_pct_thresh: result.buy_pct_thresh,
        position_scale: typeof result.position_scale === "number" ? result.position_scale : 1.0,
        min_hold_days: typeof result.min_hold_days === "number" ? result.min_hold_days : 0,
        long_term_ratio: typeof result.long_term_ratio === "number" ? result.long_term_ratio : 0.0,
        long_term_min_hold_days: typeof result.long_term_min_hold_days === "number"
            ? result.long_term_min_hold_days
            : 0,
        regime_sensitivity: typeof result.regime_sensitivity === "number" ? result.regime_sensitivity : REGIME_SENS_DEFAULT,
        regime_window_days: typeof result.regime_window_days === "number" ? result.regime_window_days : REGIME_WINDOW_DAYS,
        regime_trend_days: typeof result.regime_trend_days === "number" ? result.regime_trend_days : REGIME_TREND_DAYS,
        regime_range_pct: typeof result.regime_range_pct === "number" ? result.regime_range_pct : REGIME_RANGE_PCT,
        profit: result.profit,
        last_decision: result.last_decision,
        last_amount: result.last_amount,
        last_action_price: result.last_action_price,
        last_price: result.last_price,
        smoothing_method: result.smoothing_method || SMOOTH_METHOD_DEFAULT,
        smoothing_alpha_base: (typeof result.smoothing_alpha_base === "number" ? result.smoothing_alpha_base : SMOOTH_ALPHA_BASE_DEFAULT),
        smoothing_min_alpha: (typeof result.smoothing_min_alpha === "number" ? result.smoothing_min_alpha : SMOOTH_MIN_ALPHA_DEFAULT),
        smoothing_max_alpha: (typeof result.smoothing_max_alpha === "number" ? result.smoothing_max_alpha : SMOOTH_MAX_ALPHA_DEFAULT),
        smoothing_noise_lookback_days: (typeof result.smoothing_noise_lookback_days === "number" ? result.smoothing_noise_lookback_days : SMOOTH_NOISE_LOOKBACK_DAYS_DEFAULT),
        smoothing_rigidity_pct: (typeof result.smoothing_rigidity_pct === "number" ? result.smoothing_rigidity_pct : SMOOTH_RIGIDITY_PCT_DEFAULT),
        smoothing_adapt_strength: (typeof result.smoothing_adapt_strength === "number" ? result.smoothing_adapt_strength : SMOOTH_ADAPT_STRENGTH_DEFAULT),
        noise_penalty_strength: (typeof result.noise_penalty_strength === "number" ? result.noise_penalty_strength : NOISE_PENALTY_STRENGTH_DEFAULT),
        curve_lookback_days: (typeof result.curve_lookback_days === "number" ? result.curve_lookback_days : CURVE_LOOKBACK_DAYS_DEFAULT),
        curve_weight: (typeof result.curve_weight === "number" ? result.curve_weight : CURVE_WEIGHT_DEFAULT),
        exec_last_decision: result.exec_last_decision || null,
        exec_last_amount: (typeof result.exec_last_amount === "number" ? result.exec_last_amount : null),
        signal_score: (typeof result.signal_score === "number" && isFinite(result.signal_score)) ? result.signal_score : null,
        signal_reason: result.signal_reason || null,
        signal_suggested_shares: (typeof result.signal_suggested_shares === "number" ? result.signal_suggested_shares : null),
        calc_used: calcUsed || (modeKey === MODE_QUICK ? "Quick" : "Precise"),
        updated_at: Date.now(),
        updated_date: modeKey === MODE_PRECISE ? todayISO() : (result.updated_date || null)
    };
    prev.modes[modeKey] = modeRecord;
    const displayModeKey = prev.modes[MODE_PRECISE] ? MODE_PRECISE : modeKey;
    const displayRec = prev.modes[displayModeKey] || modeRecord;
    saved[sym] = {
        symbol: sym,
        modes: prev.modes,
        starred: prevStar,
        last_run_mode: displayModeKey,
        calc_used: displayRec.calc_used,
        updated_at: displayRec.updated_at || null,
        updated_date: displayRec.updated_date || null,
        start_wallet: displayRec.start_wallet,
        sell_pct_thresh: displayRec.sell_pct_thresh,
        buy_pct_thresh: displayRec.buy_pct_thresh,
        position_scale: displayRec.position_scale,
        min_hold_days: displayRec.min_hold_days,
        long_term_ratio: displayRec.long_term_ratio,
        long_term_min_hold_days: displayRec.long_term_min_hold_days,
        regime_sensitivity: displayRec.regime_sensitivity,
        regime_window_days: displayRec.regime_window_days,
        regime_trend_days: displayRec.regime_trend_days,
        regime_range_pct: displayRec.regime_range_pct,
        profit: displayRec.profit,
        last_decision: displayRec.last_decision,
        last_amount: displayRec.last_amount,
        last_action_price: displayRec.last_action_price,
        last_price: displayRec.last_price
    };
    saveSaved(saved);
}
async function runForInput(inputValue, { forceReoptimize = false, mode: modeOverride = null } = {}) {
    const raw = (inputValue || "").trim();
    if (!raw)
        return;
    let symbolUsed = null;
    const modeKey = modeOverride === MODE_PRECISE || modeOverride === MODE_QUICK
        ? modeOverride
        : getSelectedMode();
    runButton.disabled = true;
    setStatus("Resolving symbol...");
    setProgress(0, "Resolving symbol...");
    decisionText.textContent = "–";
    decisionExtra.textContent = "";
    thresholdsText.textContent = "–";
    thresholdsExtra.textContent = "";
    profitText.textContent = "–";
    profitExtra.textContent = "";
    const runStartTime = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    try {
        const resolved = await resolveSymbol(raw);
        const symbol = resolved.symbol.toUpperCase();
        symbolUsed = symbol;
        setStatus(`Fetching data for ${symbol}...`);
        setProgress(5, `Fetching prices for ${symbol}...`);
        const data = await getStockData(symbol);
        const dates = data.dates || [];
        const prices = data.prices || [];
        if (!prices.length)
            throw new Error("No price data returned.");
        const savedAll = loadSaved();
        const savedEntry = savedAll[symbol] || null;
        const modes = savedEntry && typeof savedEntry === "object" ? savedEntry.modes || {} : {};
        const savedPrecise = modes[MODE_PRECISE] || (savedEntry && savedEntry.sell_pct_thresh != null ? savedEntry : null);
        const savedMode = modes[modeKey] || null;
        let bestResult = null;
        let calcUsed = "";
        if (modeKey === MODE_PRECISE) {
            if (savedMode && !forceReoptimize) {
                setProgress(20, "Using cached Precise thresholds");
                const usedStartWalletFromSaved = typeof savedMode.start_wallet === "number" && isFinite(savedMode.start_wallet)
                    ? savedMode.start_wallet
                    : START_WALLET;
                const options = {
                    positionScale: typeof savedMode.position_scale === "number" ? savedMode.position_scale : 1.0,
                    minHoldDays: typeof savedMode.min_hold_days === "number" ? savedMode.min_hold_days : 0,
                    longTermRatio: typeof savedMode.long_term_ratio === "number" ? savedMode.long_term_ratio : 0.0,
                    longTermMinHoldDays: typeof savedMode.long_term_min_hold_days === "number"
                        ? savedMode.long_term_min_hold_days
                        : 0,
                    regimeSensitivity: typeof savedMode.regime_sensitivity === "number" ? savedMode.regime_sensitivity : REGIME_SENS_DEFAULT,
                    regimeWindowDays: typeof savedMode.regime_window_days === "number" ? savedMode.regime_window_days : REGIME_WINDOW_DAYS,
                    regimeTrendDays: typeof savedMode.regime_trend_days === "number" ? savedMode.regime_trend_days : REGIME_TREND_DAYS,
                    regimeRangePct: typeof savedMode.regime_range_pct === "number" ? savedMode.regime_range_pct : REGIME_RANGE_PCT
                };
                bestResult = biasedTrader(prices, usedStartWalletFromSaved, savedMode.sell_pct_thresh, savedMode.buy_pct_thresh, MAX_LOOKBACK_DAYS, options);
                bestResult.start_wallet = usedStartWalletFromSaved;
                bestResult.sell_pct_thresh = savedMode.sell_pct_thresh;
                bestResult.buy_pct_thresh = savedMode.buy_pct_thresh;
                bestResult.position_scale = options.positionScale;
                bestResult.min_hold_days = options.minHoldDays;
                bestResult.long_term_ratio = options.longTermRatio;
                bestResult.long_term_min_hold_days = options.longTermMinHoldDays;
                bestResult.regime_sensitivity = options.regimeSensitivity ?? REGIME_SENS_DEFAULT;
                bestResult.regime_window_days = options.regimeWindowDays ?? REGIME_WINDOW_DAYS;
                bestResult.regime_trend_days = options.regimeTrendDays ?? REGIME_TREND_DAYS;
                bestResult.regime_range_pct = options.regimeRangePct ?? REGIME_RANGE_PCT;
                calcUsed = savedMode.calc_used || "Precise (cached thresholds)";
                setProgress(100, "Using cached Precise thresholds");
            }
            else {
                setProgress(10, "Optimizing thresholds (Precise)...");
                bestResult = await gridSearchThresholdsWithProgress(prices, START_WALLET, (p) => setProgress(p, `Precise search: ${p}%`));
                calcUsed = "Precise (grid search + wallet evals)";
            }
        }
        else {
            const quickWallet = QUICK_START_WALLET;
            const baseSaved = savedMode || savedPrecise || null;
            if (baseSaved && !forceReoptimize) {
                const usingPreciseFallback = !savedMode && !!savedPrecise;
                setProgress(20, usingPreciseFallback ? "Using cached Precise settings (Quick wallet)" : "Using cached Quick settings");
                const options = {
                    positionScale: typeof baseSaved.position_scale === "number" ? baseSaved.position_scale : 1.0,
                    minHoldDays: typeof baseSaved.min_hold_days === "number" ? baseSaved.min_hold_days : 0,
                    longTermRatio: typeof baseSaved.long_term_ratio === "number" ? baseSaved.long_term_ratio : 0.0,
                    longTermMinHoldDays: typeof baseSaved.long_term_min_hold_days === "number"
                        ? baseSaved.long_term_min_hold_days
                        : 0,
                    regimeSensitivity: typeof baseSaved.regime_sensitivity === "number" ? baseSaved.regime_sensitivity : REGIME_SENS_DEFAULT,
                    regimeWindowDays: typeof baseSaved.regime_window_days === "number" ? baseSaved.regime_window_days : REGIME_WINDOW_DAYS,
                    regimeTrendDays: typeof baseSaved.regime_trend_days === "number" ? baseSaved.regime_trend_days : REGIME_TREND_DAYS,
                    regimeRangePct: typeof baseSaved.regime_range_pct === "number" ? baseSaved.regime_range_pct : REGIME_RANGE_PCT
                };
                bestResult = biasedTrader(prices, quickWallet, baseSaved.sell_pct_thresh, baseSaved.buy_pct_thresh, MAX_LOOKBACK_DAYS, options);
                bestResult.start_wallet = quickWallet;
                bestResult.sell_pct_thresh = baseSaved.sell_pct_thresh;
                bestResult.buy_pct_thresh = baseSaved.buy_pct_thresh;
                bestResult.position_scale = options.positionScale;
                bestResult.min_hold_days = options.minHoldDays;
                bestResult.long_term_ratio = options.longTermRatio;
                bestResult.long_term_min_hold_days = options.longTermMinHoldDays;
                bestResult.regime_sensitivity = options.regimeSensitivity ?? REGIME_SENS_DEFAULT;
                bestResult.regime_window_days = options.regimeWindowDays ?? REGIME_WINDOW_DAYS;
                bestResult.regime_trend_days = options.regimeTrendDays ?? REGIME_TREND_DAYS;
                bestResult.regime_range_pct = options.regimeRangePct ?? REGIME_RANGE_PCT;
                calcUsed = usingPreciseFallback
                    ? (baseSaved.calc_used ? `Quick (from Precise cached settings: ${baseSaved.calc_used})` : "Quick (from Precise cached settings)")
                    : (baseSaved.calc_used || "Quick (cached settings)");
                setProgress(100, usingPreciseFallback ? "Using cached Precise settings (Quick wallet)" : "Using cached Quick settings");
            }
            else {
                setProgress(10, "Optimizing thresholds (Quick, fixed wallet)...");
                bestResult = await gridSearchThresholdsFixedWalletWithProgress(prices, quickWallet, (p) => setProgress(p, `Quick search: ${p}%`));
                calcUsed = `Quick (grid search, fixed $${quickWallet.toFixed(0)} wallet)`;
            }
        }
        if (!bestResult) {
            throw new Error("No result from simulation.");
        }
        const usedStartWallet = typeof bestResult.start_wallet === "number" && isFinite(bestResult.start_wallet)
            ? bestResult.start_wallet
            : (modeKey === MODE_QUICK ? QUICK_START_WALLET : START_WALLET);
        const chartSim = biasedTrader(prices, usedStartWallet, bestResult.sell_pct_thresh, bestResult.buy_pct_thresh, MAX_LOOKBACK_DAYS, {
            positionScale: bestResult.position_scale ?? 1.0,
            minHoldDays: bestResult.min_hold_days ?? 0,
            longTermRatio: bestResult.long_term_ratio ?? 0.0,
            longTermMinHoldDays: bestResult.long_term_min_hold_days ?? 0,
            regimeSensitivity: bestResult.regime_sensitivity ?? REGIME_SENS_DEFAULT,
            regimeWindowDays: bestResult.regime_window_days ?? REGIME_WINDOW_DAYS,
            regimeTrendDays: bestResult.regime_trend_days ?? REGIME_TREND_DAYS,
            regimeRangePct: bestResult.regime_range_pct ?? REGIME_RANGE_PCT,
            trackCurve: true
        });
        const equityCurve = chartSim.equity_curve || [];
        const buyMarkers = chartSim.buy_markers || [];
        const sellMarkers = chartSim.sell_markers || [];
        const sharesHeld = chartSim.shares_held || [];
        const walletSeries = chartSim.wallet_series || [];
        updateChart(symbol, dates, prices, equityCurve, buyMarkers, sellMarkers, sharesHeld, walletSeries, usedStartWallet);
        const portfolioSnap = {
            wallet: Array.isArray(walletSeries) && walletSeries.length ? walletSeries[walletSeries.length - 1] : bestResult.final_wallet,
            shares: Array.isArray(sharesHeld) && sharesHeld.length ? sharesHeld[sharesHeld.length - 1] : 0
        };
        const execDecision = bestResult.last_decision;
        const execAmount = bestResult.last_amount;
        const signal = computeSignalSizedDecision(prices, bestResult, portfolioSnap);
        const isHighStrength = (signal.size === SIZE_HIGH) || (String(signal.size || "").toUpperCase() === "HIGH");
        const finalDecision = ((signal.decision === "BUY" || signal.decision === "SELL") && isHighStrength)
            ? signal.decision
            : "HOLD";
        bestResult.exec_last_decision = execDecision;
        bestResult.exec_last_amount = execAmount;
        bestResult.signal_score = signal.score;
        bestResult.signal_reason = signal.reason;
        bestResult.signal_suggested_shares = signal.suggestedShares;
        bestResult.last_decision = finalDecision;
        bestResult.last_amount = "";
        bestResult.last_action_price = bestResult.last_price;
        decisionText.textContent = finalDecision;
        decisionText.style.color =
            finalDecision === "BUY" ? "#4ade80" : finalDecision === "SELL" ? "#f97373" : "#9ca3af";
        const wl = computeAvgWinLossFromMarkers(prices, buyMarkers, sellMarkers);
        if (wl && (isFinite(wl.avgWinPct) || isFinite(wl.avgLossPct))) {
            const fmtPct = (v) => (typeof v === "number" && isFinite(v)) ? `${v.toFixed(2)}%` : "–";
            bestResult.avg_win_pct = wl.avgWinPct;
            bestResult.avg_loss_pct = wl.avgLossPct;
            bestResult.win_samples = wl.winSamples;
            bestResult.loss_samples = wl.lossSamples;
            decisionExtra.innerHTML =
                `<div>$${bestResult.last_price.toFixed(2)}</div>` +
                    `<div style="opacity:0.9; font-size:0.75rem;">Avg win: ${fmtPct(wl.avgWinPct)} • Avg loss: ${fmtPct(Math.abs(wl.avgLossPct))}</div>`;
        }
        else {
            decisionExtra.textContent = `$${bestResult.last_price.toFixed(2)}`;
        }
        thresholdsText.textContent = `Sell > ${bestResult.sell_pct_thresh.toFixed(1)}%, Buy drop > ${bestResult.buy_pct_thresh.toFixed(1)}%`;
        const posScale = bestResult.position_scale ?? 1.0;
        const minHold = bestResult.min_hold_days ?? 0;
        const ltRatio = bestResult.long_term_ratio ?? 0.0;
        const ltHold = bestResult.long_term_min_hold_days ?? 0;
        const modeLabel = modeKey === MODE_QUICK ? "Quick" : "Precise";
        thresholdsExtra.textContent =
            `Mode: ${modeLabel}` +
                (calcUsed ? ` | ${calcUsed}` : "") +
                ` | Lookback up to ${MAX_LOOKBACK_DAYS} days` +
                ` | Pos scale ×${posScale.toFixed(2)}` +
                ` | Short min hold ${minHold}d` +
                ` | LT ratio ${(ltRatio * 100).toFixed(0)}%` +
                ` | LT min hold ${ltHold}d` +
                ` | Regime sens ×${(bestResult.regime_sensitivity ?? REGIME_SENS_DEFAULT).toFixed(2)}` +
                ` | Regime window ${bestResult.regime_window_days ?? REGIME_WINDOW_DAYS}d` +
                ` | Trend window ${bestResult.regime_trend_days ?? REGIME_TREND_DAYS}d` +
                ` | Huge-range ≥${(bestResult.regime_range_pct ?? REGIME_RANGE_PCT).toFixed(0)}%` +
                ` | Start wallet $${usedStartWallet.toFixed(2)}`;
        const profit = bestResult.profit;
        const finalValue = bestResult.final_value;
        const profitPct = (profit / usedStartWallet) * 100;
        const profitStr = (profit >= 0 ? "+" : "-") + "$" + Math.abs(profit).toFixed(2);
        const pctStr = (profitPct >= 0 ? "+" : "-") + Math.abs(profitPct).toFixed(2) + "%";
        profitText.textContent = `${profitStr} (${pctStr})`;
        profitText.style.color = profit >= 0 ? "#4ade80" : "#f97373";
        profitExtra.textContent = `Final value: $${finalValue.toFixed(2)} (wallet + holdings)`;
        saveBestResult(symbol, bestResult, { mode: modeKey, calcUsed });
        renderSavedList();
        const runEndTime = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
        const ms = runEndTime - runStartTime;
        setStatus(`Done (${modeLabel}) — ${(ms / 1000).toFixed(2)}s`);
        setProgress(100, "Done");
        markCurrentSymbol(symbol);
    }
    catch (err) {
        console.error(err);
        const msg = err?.message || String(err);
        setStatus("Error: " + msg);
        setProgress(0, "Error");
    }
    finally {
        runButton.disabled = false;
        if (symbolUsed) {
            markCurrentSymbol(symbolUsed);
        }
    }
}
form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = input.value || "";
    runForInput(val);
});
runButton.addEventListener("click", () => {
    const val = input.value || "";
    runForInput(val);
});
const _reloadClickTimers = new Map();
function clearSavedCalculationsForSymbol(symbol) {
    const sym = (symbol || "").toUpperCase();
    if (!sym)
        return;
    const saved = loadSaved();
    const rec = saved[sym];
    if (!rec || typeof rec !== "object")
        return;
    const starred = !!rec.starred;
    rec.symbol = sym;
    rec.starred = starred;
    rec.modes = {};
    const wipeKeys = [
        "start_wallet",
        "sell_pct_thresh",
        "buy_pct_thresh",
        "position_scale",
        "min_hold_days",
        "long_term_ratio",
        "long_term_min_hold_days",
        "regime_sensitivity",
        "regime_window_days",
        "regime_trend_days",
        "regime_range_pct",
        "profit",
        "last_decision",
        "last_amount",
        "last_action_price",
        "last_price",
        "calc_used",
        "last_run_mode",
        "updated_at",
        "updated_date"
    ];
    for (const k of wipeKeys) {
        if (k in rec)
            delete rec[k];
    }
    saved[sym] = rec;
    saveSaved(saved);
}
function clearPriceCacheForSymbol(symbol) {
    const sym = (symbol || "").toUpperCase();
    if (!sym)
        return;
    try {
        const cache = loadPriceCache();
        if (cache && typeof cache === "object" && cache[sym]) {
            delete cache[sym];
            localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
        }
    }
    catch (e) {
    }
}
savedList.addEventListener("click", (e) => {
    const reload = e.target.closest(".saved-reload");
    if (reload) {
        const sym = reload.dataset.symbol;
        if (sym) {
            const key = sym.toUpperCase();
            if (_reloadClickTimers.has(key)) {
                clearTimeout(_reloadClickTimers.get(key));
                _reloadClickTimers.delete(key);
            }
            const t = setTimeout(() => {
                _reloadClickTimers.delete(key);
                input.value = sym;
                runForInput(sym, { mode: getSelectedMode(), forceReoptimize: e.shiftKey });
            }, 320);
            _reloadClickTimers.set(key, t);
        }
        e.stopPropagation();
        return;
    }
    const del = e.target.closest(".saved-delete");
    if (del) {
        const sym = del.dataset.symbol;
        if (sym) {
            const saved = loadSaved();
            delete saved[sym];
            saveSaved(saved);
            renderSavedList();
        }
        e.stopPropagation();
        return;
    }
    const btn = e.target.closest(".saved-btn");
    if (!btn)
        return;
    const sym = btn.dataset.symbol;
    if (!sym)
        return;
    input.value = sym;
    const saved = loadSaved();
    const rec = saved[(sym || "").toUpperCase()];
    let preferredMode = null;
    if (rec) {
        if (rec.modes && rec.modes[MODE_PRECISE]) {
            preferredMode = MODE_PRECISE;
        }
        else if (rec.last_run_mode === MODE_QUICK || rec.last_run_mode === MODE_PRECISE) {
            preferredMode = rec.last_run_mode;
        }
        else if (rec.modes) {
            if (rec.modes[MODE_PRECISE])
                preferredMode = MODE_PRECISE;
            else if (rec.modes[MODE_QUICK])
                preferredMode = MODE_QUICK;
        }
    }
    runForInput(sym, preferredMode ? { mode: preferredMode } : undefined);
});
savedList.addEventListener("dblclick", (e) => {
    const reload = e.target.closest(".saved-reload");
    if (!reload)
        return;
    const sym = reload.dataset.symbol;
    if (!sym)
        return;
    const key = sym.toUpperCase();
    if (_reloadClickTimers.has(key)) {
        clearTimeout(_reloadClickTimers.get(key));
        _reloadClickTimers.delete(key);
    }
    clearSavedCalculationsForSymbol(sym);
    clearPriceCacheForSymbol(sym);
    input.value = sym;
    runForInput(sym, { mode: getSelectedMode(), forceReoptimize: true });
    e.stopPropagation();
    e.preventDefault();
});
if (clearSavedBtn) {
    clearSavedBtn.addEventListener("click", () => {
        localStorage.removeItem(STORAGE_KEY);
        renderSavedList();
    });
}
if (reloadSavedBtn) {
    reloadSavedBtn.addEventListener("click", () => {
        reloadAllSavedSymbolsApplyOnly();
    });
}
const pfStartCashInput = document.getElementById("pf-start-cash");
const pfStartDateInput = document.getElementById("pf-start-date");
const pfRowsContainer = document.getElementById("pf-rows");
const pfAddRowBtn = document.getElementById("pf-add-row");
const pfRunPortfolioBtn = document.getElementById("pf-run-portfolio");
const pfProgressBar = document.getElementById("pf-progress-bar");
const pfProgressText = document.getElementById("pf-progress-text");
const pfChartCanvas = document.getElementById("pf-chart-portfolio");
let pfChart = null;
function pfSetProgress(pct, text) {
    if (!pfProgressBar || !pfProgressText)
        return;
    const clamped = Math.max(0, Math.min(100, pct));
    pfProgressBar.style.width = clamped + "%";
    pfProgressText.textContent = text || "";
}
function pfCreateRow(initialSymbol = "", initialPrice = "", initialAmount = "") {
    if (!pfRowsContainer)
        return;
    const row = document.createElement("div");
    row.className = "pf-row";
    row.innerHTML = `
    <input type="text"   class="pf-symbol" placeholder="e.g. NVDA or Apple" />
    <input type="number" class="pf-price"  placeholder="optional" />
    <input type="number" class="pf-amount" placeholder="0" value="0" />
    <button type="button" class="pf-row-remove">✕</button>
  `;
    const symInput = row.querySelector(".pf-symbol");
    const priceInput = row.querySelector(".pf-price");
    const amountInput = row.querySelector(".pf-amount");
    const removeBtn = row.querySelector(".pf-row-remove");
    if (initialSymbol)
        symInput.value = initialSymbol;
    if (initialPrice !== "")
        priceInput.value = initialPrice;
    if (initialAmount !== "")
        amountInput.value = initialAmount;
    removeBtn.addEventListener("click", () => {
        row.remove();
    });
    pfRowsContainer.appendChild(row);
}
function pfCollectRows() {
    const rows = [];
    if (!pfRowsContainer)
        return rows;
    const rowEls = pfRowsContainer.querySelectorAll(".pf-row");
    rowEls.forEach((row) => {
        const sym = row.querySelector(".pf-symbol")?.value.trim();
        if (!sym)
            return;
        const priceStr = row.querySelector(".pf-price")?.value.trim();
        const amountStr = row.querySelector(".pf-amount")?.value.trim();
        const price = priceStr === "" ? null : Number(priceStr);
        const amount = amountStr === "" ? 0 : Number(amountStr);
        if (isNaN(amount) || amount < 0)
            return;
        rows.push({
            rawSymbol: sym,
            initialPrice: price,
            amount
        });
    });
    return rows;
}
function pfBuildManualCurve(dates, priceBySymbol, inputs, startCash) {
    const curve = [];
    for (const date of dates) {
        let value = startCash;
        for (const inp of inputs) {
            const sym = inp.resolvedSymbol;
            const map = priceBySymbol[sym];
            const price = map ? map[date] : null;
            if (price != null) {
                value += inp.amount * price;
            }
        }
        curve.push(value);
    }
    return curve;
}
function pfBuildOptimizedCurve(dates, priceBySymbol, inputs, startCash) {
    const perSymbolCurves = {};
    for (const inp of inputs) {
        const sym = inp.resolvedSymbol;
        const map = priceBySymbol[sym];
        const firstPrice = map[dates[0]];
        if (!firstPrice)
            continue;
        const curve = [];
        for (const d of dates) {
            const p = map[d];
            if (!p) {
                curve.push(startCash);
            }
            else {
                curve.push((startCash * p) / firstPrice);
            }
        }
        perSymbolCurves[sym] = curve;
    }
    const optimized = [];
    for (let i = 0; i < dates.length; i++) {
        let best = startCash;
        for (const sym of Object.keys(perSymbolCurves)) {
            const c = perSymbolCurves[sym];
            if (c[i] != null && c[i] > best)
                best = c[i];
        }
        optimized.push(best);
    }
    return optimized;
}
function pfUpdateChart(dates, manualCurve, optimizedCurve) {
    if (!pfChartCanvas)
        return;
    if (pfChart)
        pfChart.destroy();
    const datasets = [];
    if (manualCurve && manualCurve.length === dates.length) {
        datasets.push({
            label: "Manual portfolio total value",
            data: manualCurve,
            borderWidth: 1.5,
            pointRadius: 0,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.2)",
            tension: 0.15
        });
    }
    if (optimizedCurve && optimizedCurve.length === dates.length) {
        datasets.push({
            label: "Optimized portfolio total value",
            data: optimizedCurve,
            borderWidth: 1.5,
            pointRadius: 0,
            borderColor: "#22c55e",
            backgroundColor: "rgba(34,197,94,0.2)",
            tension: 0.15
        });
    }
    pfChart = new Chart(pfChartCanvas.getContext("2d"), {
        type: "line",
        data: {
            labels: dates,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "nearest", intersect: false },
            plugins: {
                legend: { labels: { color: "#e5e7eb" } },
                tooltip: { mode: "nearest", intersect: false }
            },
            scales: {
                x: {
                    ticks: {
                        maxTicksLimit: 8,
                        color: "#9ca3af"
                    }
                },
                y: {
                    beginAtZero: false,
                    ticks: {
                        color: "#9ca3af",
                        callback: function (value) {
                            const v = typeof value === "number" ? value : Number(value);
                            if (!isFinite(v))
                                return "";
                            const rounded = Math.round(v);
                            return "$" + rounded.toString();
                        }
                    }
                },
                yHidden: {
                    display: false
                }
            }
        }
    });
}
async function pfRunPortfolioAll() {
    if (!pfStartCashInput || !pfRowsContainer)
        return;
    pfSetProgress(5, "Collecting inputs...");
    const startCash = Number(pfStartCashInput.value) || 0;
    const startDateVal = pfStartDateInput?.value || "";
    const rows = pfCollectRows();
    if (!rows.length) {
        pfSetProgress(0, "Please add at least one stock.");
        return;
    }
    const resolvedInputs = [];
    const priceBySymbol = {};
    const dateSets = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        pfSetProgress(10 + (i * 20) / rows.length, `Resolving ${r.rawSymbol}...`);
        let resolved;
        try {
            resolved = await resolveSymbol(r.rawSymbol);
        }
        catch (e) {
            console.error(e);
            continue;
        }
        const symbol = resolved.symbol.toUpperCase();
        let data;
        try {
            data = await getStockData(symbol);
        }
        catch (e) {
            console.error(e);
            continue;
        }
        const dates = [];
        const prices = [];
        for (let idx = 0; idx < data.dates.length; idx++) {
            const d = data.dates[idx];
            if (startDateVal && d < startDateVal)
                continue;
            dates.push(d);
            prices.push(data.prices[idx]);
        }
        if (dates.length < 2)
            continue;
        const map = {};
        for (let idx = 0; idx < dates.length; idx++) {
            map[dates[idx]] = prices[idx];
        }
        r.resolvedSymbol = symbol;
        resolvedInputs.push(r);
        priceBySymbol[symbol] = map;
        dateSets.push(new Set(dates));
    }
    if (!resolvedInputs.length) {
        pfSetProgress(0, "No valid symbols after resolution.");
        return;
    }
    let commonDates = Array.from(dateSets[0]);
    for (let i = 1; i < dateSets.length; i++) {
        commonDates = commonDates.filter((d) => dateSets[i].has(d));
    }
    commonDates.sort();
    if (commonDates.length < 2) {
        pfSetProgress(0, "Not enough overlapping dates for all symbols.");
        return;
    }
    pfSetProgress(60, "Building manual portfolio curve...");
    const manualCurve = pfBuildManualCurve(commonDates, priceBySymbol, resolvedInputs, startCash);
    pfSetProgress(80, "Building optimized curve...");
    const optimizedCurve = pfBuildOptimizedCurve(commonDates, priceBySymbol, resolvedInputs, startCash);
    pfUpdateChart(commonDates, manualCurve, optimizedCurve);
    pfSetProgress(100, "Portfolio simulations complete.");
}
if (pfAddRowBtn && pfRowsContainer) {
    pfAddRowBtn.addEventListener("click", () => {
        pfCreateRow();
    });
    if (!pfRowsContainer.children.length) {
        pfCreateRow();
    }
}
if (pfRunPortfolioBtn) {
    pfRunPortfolioBtn.addEventListener("click", () => {
        pfRunPortfolioAll();
    });
}
renderSavedList();
(function autoRunTopSaved() {
    const firstBtn = savedList.querySelector(".saved-btn");
    if (!firstBtn)
        return;
    const sym = firstBtn.dataset.symbol;
    if (!sym)
        return;
    try {
        const saved = loadSaved();
        const rec = saved[(sym || "").toUpperCase()];
        const hasPrecise = rec && rec.modes && rec.modes[MODE_PRECISE];
        if (hasPrecise) {
            setSelectedMode(MODE_PRECISE);
            input.value = sym;
            runForInput(sym, { mode: MODE_PRECISE });
            return;
        }
    }
    catch (e) {
    }
    input.value = sym;
    runForInput(sym);
})();
input.focus();
