// ================== CONSTANTS ==================
const START_WALLET = 5000.0;

const MODE_STORAGE_KEY = "stockbot_mode";
const MODE_QUICK = "quick";
const MODE_PRECISE = "precise";

// Quick mode runs a single simulation using this fixed starting wallet:
const QUICK_START_WALLET = 4000.0;

// Bulk reload: start the next symbol every N ms (staggered concurrency)
const RELOAD_ALL_STAGGER_MS = 2000;


// Regime / mean-reversion scaling (helps avoid buying tiny dips after huge run-ups,
// and buys more aggressively after large multi-day dips)
const REGIME_SENS_DEFAULT = 1.0;     // 0 disables; 1 = normal; >1 stronger
const REGIME_WINDOW_DAYS = 10;       // rolling min/max window
const REGIME_TREND_DAYS = 7;         // multi-day trend window
const REGIME_RANGE_PCT = 20;         // range% needed to consider a move "huge"

const MAX_LOOKBACK_DAYS = 30;
const STORAGE_KEY = "biasTraderSavedV7";
const PRICE_CACHE_KEY = "biasTraderPriceV7";
const NAME_MAP_KEY = "biasTraderNameMapV7";

// Simple name→symbol hints
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

// ================== DOM HOOKS ==================
const form = document.getElementById("symbol-form");
const input = document.getElementById("symbol-input");
const runButton = document.getElementById("run-button");



/**
 * Mode toggle UI (Quick vs Precise)
 * - Quick: single run with QUICK_START_WALLET
 * - Precise: current behavior (grid search + wallet evals) when not cached
 */
function getSelectedMode() {
  const q = document.getElementById("mode-quick");
  const p = document.getElementById("mode-precise");
  if (q && p) return q.checked ? MODE_QUICK : MODE_PRECISE;

  // backward-compat: older checkbox toggle
  const el = document.getElementById("mode-toggle");
  if (el) return el.checked ? MODE_QUICK : MODE_PRECISE;

  const saved = localStorage.getItem(MODE_STORAGE_KEY);
  return saved === MODE_PRECISE ? MODE_PRECISE : MODE_QUICK;
}

function setSelectedMode(mode) {
  const m = mode === MODE_PRECISE ? MODE_PRECISE : MODE_QUICK;
  localStorage.setItem(MODE_STORAGE_KEY, m);

  // Preferred DOM: segmented radios
  const q = document.getElementById("mode-quick");
  const p = document.getElementById("mode-precise");
  if (q && p) {
    q.checked = m === MODE_QUICK;
    p.checked = m === MODE_PRECISE;
    return;
  }

  // backward-compat: older checkbox toggle
  const el = document.getElementById("mode-toggle");
  const lbl = document.getElementById("mode-toggle-label");
  if (el) el.checked = m === MODE_QUICK;
  if (lbl) lbl.textContent = m === MODE_QUICK ? "Quick" : "Precise";
}

function ensureModeToggle() {
  // If the HTML already has the segmented control, just wire it up.
  const q = document.getElementById("mode-quick");
  const p = document.getElementById("mode-precise");
  if (q && p) {
    q.addEventListener("change", () => setSelectedMode(MODE_QUICK));
    p.addEventListener("change", () => setSelectedMode(MODE_PRECISE));
    // Default to Quick unless user previously chose Precise
    setSelectedMode(getSelectedMode());
    return;
  }

  // backward-compat: older checkbox toggle already exists
  if (document.getElementById("mode-toggle")) {
    setSelectedMode(getSelectedMode());
    return;
  }

  // Fallback: inject a segmented control next to the Run button
  if (!runButton || !runButton.parentNode) return;

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

// Track which symbol is currently shown on the main chart
let currentSymbol = null;
// Progress & ETA state
let currentProgressPercent = 0;    // internal 0–100
let etaStartTime = null;           // when the bar first moved
let etaStartDisplayPercent = 0;    // bar percent at that time (usually 0)
let etaAvgMsPerPercent = null;     // smoothed *average* ms per 1% of the BAR
let etaTimerId = null;
let etaRemainingSec = null;

// Grid-search status message state
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

let gridSearchMessageCount = 0;     // quirky messages since last numeric %
let gridSearchNextPercentIn = 3;    // after 3–5 messages, show a percent line
let lastGridStatusUpdateTime = 0;   // last time (ms) we changed the status line

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
    const offset = 22; // horizontal distance from the point

    if (!items || !items.length) return eventPosition;

    // 1) Start from the built-in "average" tooltip position
    const avgPos = Chart.Tooltip.positioners.average.call(this, items, eventPosition);
    let baseX = avgPos.x;
    let baseY = avgPos.y;

    // 2) Find the Simulation value item (fallback: first item)
    let simItem = items[0];
    for (const it of items) {
      const ds = datasets[it.datasetIndex];
      if (ds && ds.label === "Simulation value") {
        simItem = it;
        break;
      }
    }

    // Attach Y to the Simulation point if possible
    if (simItem.element) {
      const el = simItem.element;
      const pos =
        typeof el.tooltipPosition === "function"
          ? el.tooltipPosition(true)
          : el;

      if (pos && typeof pos.y === "number") {
        baseY = pos.y;
      }
    }

    // 3) Decide which side using the data index (no jitter, no pixels)
    const maxIndex = labels.length > 0 ? labels.length - 1 : 0;
    const midIndex = maxIndex / 2;
    const idx =
      simItem.dataIndex != null
        ? simItem.dataIndex
        : simItem.index != null
        ? simItem.index
        : 0;
    
    const side = idx <= midIndex ? "right" : "left";

    // 4) Apply offset horizontally from that x position
    const x = baseX;// + (side === "right" ? offset : -offset);
    const y = baseY;
    return { x, y };
  };
}

// ================== STATE / HELPERS ==================
function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (isError ? " error" : "");
}

function setProgress(percent, label) {
  // Internal progress (0–100) from the pipeline / grid search
  const p = Math.max(0, Math.min(100, percent));
  currentProgressPercent = p;

  // Map internal progress to displayed bar percent:
  // 0–60 internal → 0–99 visual, 60–100 internal → hold at 99 until done.
  let displayPercent;
  if (p <= 0) {
    displayPercent = 0;
  } else if (p < 60) {
    displayPercent = Math.round((p / 60) * 99);
  } else if (p < 100) {
    displayPercent = 99;
  } else {
    displayPercent = 100;
  }
  displayPercent = Math.max(0, Math.min(100, displayPercent));

  // Update bar
  if (progressBar) {
    progressBar.style.width = displayPercent + "%";
  }

  const now =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  // ===== ETA based on *average* speed of the BAR =====
  if (displayPercent > 0 && displayPercent < 100) {
    // New run or bar went backwards → reset baseline
    if (etaStartTime === null || displayPercent < etaStartDisplayPercent) {
      etaStartTime = now;
      etaStartDisplayPercent = displayPercent;
      etaAvgMsPerPercent = null;
      etaRemainingSec = null;
    } else if (displayPercent > etaStartDisplayPercent) {
      const elapsedMs = now - etaStartTime;
      const progressed = displayPercent - etaStartDisplayPercent;

      if (progressed > 0 && elapsedMs > 0) {
        // Raw average speed from start of the run
        const rawMsPerPercent = elapsedMs / progressed;

        // Smooth it heavily so it doesn't jump around
        if (etaAvgMsPerPercent == null) {
          etaAvgMsPerPercent = rawMsPerPercent;
        } else {
          const alphaSpeed = 0.15; // 15% new, 85% old
          etaAvgMsPerPercent =
            etaAvgMsPerPercent * (1 - alphaSpeed) +
            rawMsPerPercent * alphaSpeed;
        }

        const remainingPercent = Math.max(100 - displayPercent, 0);
        const rawRemainingSec = (etaAvgMsPerPercent * remainingPercent) / 1000;

        // Also smooth the displayed remaining time itself so drops/bumps are gentle
        if (etaRemainingSec == null) {
          etaRemainingSec = Math.round(rawRemainingSec);
        } else {
          const alphaEta = 0.2; // 20% new value each update
          const smoothed =
            etaRemainingSec * (1 - alphaEta) + rawRemainingSec * alphaEta;
          etaRemainingSec = Math.max(0, Math.round(smoothed));
        }
      }
    }

    // Show ETA text
    if (etaText) {
      if (etaRemainingSec != null && isFinite(etaRemainingSec) && etaRemainingSec > 0) {
        etaText.textContent = `Estimated remaining time: ${etaRemainingSec}s`;
      } else {
        etaText.textContent = "";
      }
    }

    // Countdown timer that decrements etaRemainingSec once per second
    if (!etaTimerId && etaText) {
      etaTimerId = setInterval(() => {
        if (currentProgressPercent >= 100 || etaRemainingSec == null) {
          clearInterval(etaTimerId);
          etaTimerId = null;
          if (etaText) etaText.textContent = "";
          return;
        }

        if (etaRemainingSec > 0) {
          etaRemainingSec -= 1;
        }

        if (etaText) {
          if (etaRemainingSec > 0) {
            etaText.textContent = `Estimated remaining time: ${etaRemainingSec}s`;
          } else {
            etaText.textContent = "Estimated remaining time: 0s";
          }
        }
      }, 1000);
    }
  } else {
    // Finished or reset (bar at 0 or 100)
    etaStartTime = null;
    etaStartDisplayPercent = 0;
    etaAvgMsPerPercent = null;
    etaRemainingSec = null;

    if (etaText) {
      etaText.textContent = "";
    }
    if (etaTimerId) {
      clearInterval(etaTimerId);
      etaTimerId = null;
    }

    // Reset quirky-message cadence when run ends
    gridSearchMessageCount = 0;
    lastGridStatusUpdateTime = 0;
    gridSearchNextPercentIn = 3 + Math.floor(Math.random() * 3); // 3–5
  }

  // ===== Status / progress text =====
  const isGridSearch =
    typeof label === "string" && label.toLowerCase().includes("grid search");

  // Non-grid operations: label + BAR percent
  if (!isGridSearch) {
    const baseLabel = label || "Progress";
    if (progressText) {
      progressText.textContent = `${baseLabel} (${displayPercent}%)`;
    }
    return;
  }

  // Grid-search status: only change message every ≥ 3s
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
      // Every 3–5 updates (or at the end), show numeric progress
      text = `Grid search: ${displayPercent}%`;
      gridSearchMessageCount = 0;
      gridSearchNextPercentIn = 3 + Math.floor(Math.random() * 3); // 3–5
    } else {
      // Otherwise show a quirky message
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

// after 2pm local time?
function isAfterDailyRefreshCutoff() {
  const now = new Date();
  return now.getHours() >= 14;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

async function fetchJson(url) {
  // Log every network call (helps diagnose API quota usage)
  try {
    console.log(`[API CALL] ${new Date().toISOString()} -> ${url}`);
  } catch (_) {}
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

function formatMoney(value, withSign = false) {
  if (!isFinite(value)) return withSign ? "+$0.00" : "$0.00";
  const sign = withSign ? (value >= 0 ? "+$" : "-$") : "$";
  const abs = Math.abs(value).toFixed(2);
  return sign + abs;
}

// Estimate average win/loss % from trade markers (buy/sell shares) on the chart simulation.
// We treat remaining (unsold) lots as unrealized P/L at the latest price so losses can appear.
function computeAvgWinLossFromMarkers(prices, buyMarkers = [], sellMarkers = []) {
  if (!Array.isArray(prices) || prices.length < 2) return null;

  const lots = []; // FIFO lots: { shares, price }
  const wins = []; // { shares, pct }
  const losses = []; // { shares, pct }

  const toNum = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

  for (let i = 0; i < prices.length; i++) {
    const price = toNum(prices[i]);
    if (!price) continue;

    const bought = toNum(buyMarkers && buyMarkers[i]);
    if (bought > 0) {
      lots.push({ shares: bought, price });
    }

    let sold = toNum(sellMarkers && sellMarkers[i]);
    while (sold > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(sold, lot.shares);
      const pct = lot.price > 0 ? ((price - lot.price) / lot.price) * 100 : 0;

      if (pct >= 0) wins.push({ shares: take, pct });
      else losses.push({ shares: take, pct });

      lot.shares -= take;
      sold -= take;

      if (lot.shares <= 1e-9) lots.shift();
    }
  }

  // Include remaining lots as unrealized P/L at the latest price (so "loss" isn't always 0)
  const lastPrice = toNum(prices[prices.length - 1]);
  if (lastPrice > 0 && lots.length) {
    for (const lot of lots) {
      const pct = lot.price > 0 ? ((lastPrice - lot.price) / lot.price) * 100 : 0;
      if (pct >= 0) wins.push({ shares: lot.shares, pct });
      else losses.push({ shares: lot.shares, pct });
    }
  }

  const sumShares = (arr) => arr.reduce((acc, x) => acc + toNum(x.shares), 0);
  const wAvgPct = (arr) => {
    const total = sumShares(arr);
    if (total <= 0) return NaN;
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


// ================== API KEY HANDLING ==================
// BT8UUAJIJ09B1IQF encoded in base64
function getIdent() {
  const encoded = "QlQ4VVVBSklKMDlCMUlrRg==";
  return atob(encoded);
}

// ================== LOCAL STORAGE: NAME MAP ==================
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
  } catch (e) {
    console.warn("Failed to load name map:", e);
  }
  return result;
}

function saveNameMap(extraMap) {
  try {
    localStorage.setItem(NAME_MAP_KEY, JSON.stringify(extraMap));
  } catch (e) {
    console.warn("Failed to save name map:", e);
  }
}

// ================== LOCAL STORAGE: PRICE CACHE ==================
function loadPriceCache() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    console.warn("Failed to load price cache:", e);
  }
  return {};
}

function getCachedPricesIfFresh(symbol) {
  const cache = loadPriceCache();
  const sym = symbol.toUpperCase();
  const entry = cache[sym];
  if (!entry) return null;

  if (entry.fetch_date !== todayISO()) return null;

  const now = new Date();
  const afterCutoffNow = isAfterDailyRefreshCutoff();

  // If it's after 1:35pm now, only use cache that was fetched after cutoff
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
  } catch (e) {
    console.warn("Failed to save price cache:", e);
  }
}

// ================== LOCAL STORAGE: SAVED RESULTS ==================

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // ---- migrate legacy single-mode saves to modes.precise ----
      let changed = false;
      for (const sym of Object.keys(parsed)) {
        const rec = parsed[sym];
        if (!rec || typeof rec !== "object") continue;

        if (!rec.modes) rec.modes = {};

        // Legacy format: thresholds at top-level -> treat as Precise cache
        const hasLegacyThresholds =
          typeof rec.sell_pct_thresh === "number" &&
          isFinite(rec.sell_pct_thresh) &&
          typeof rec.buy_pct_thresh === "number" &&
          isFinite(rec.buy_pct_thresh);

        if (hasLegacyThresholds && !rec.modes[MODE_PRECISE]) {
          rec.modes[MODE_PRECISE] = {
            symbol: (rec.symbol || sym).toUpperCase(),
            start_wallet:
              typeof rec.start_wallet === "number" && isFinite(rec.start_wallet)
                ? rec.start_wallet
                : START_WALLET,
            sell_pct_thresh: rec.sell_pct_thresh,
            buy_pct_thresh: rec.buy_pct_thresh,
            position_scale:
              typeof rec.position_scale === "number" ? rec.position_scale : 1.0,
            min_hold_days:
              typeof rec.min_hold_days === "number" ? rec.min_hold_days : 0,
            long_term_ratio:
              typeof rec.long_term_ratio === "number"
                ? rec.long_term_ratio
                : 0.0,
            long_term_min_hold_days:
              typeof rec.long_term_min_hold_days === "number"
                ? rec.long_term_min_hold_days
                : 0,
            regime_sensitivity:
              typeof rec.regime_sensitivity === "number" ? rec.regime_sensitivity : REGIME_SENS_DEFAULT,
            regime_window_days:
              typeof rec.regime_window_days === "number" ? rec.regime_window_days : REGIME_WINDOW_DAYS,
            regime_trend_days:
              typeof rec.regime_trend_days === "number" ? rec.regime_trend_days : REGIME_TREND_DAYS,
            regime_range_pct:
              typeof rec.regime_range_pct === "number" ? rec.regime_range_pct : REGIME_RANGE_PCT,
            profit: rec.profit,
            last_decision: rec.last_decision,
            last_amount: rec.last_amount,
            last_action_price: rec.last_action_price,
            last_price: rec.last_price,
            calc_used: rec.calc_used || "Precise (legacy cached thresholds)",
            updated_at: rec.updated_at || null
          };
          // Keep a hint about what the last visible numbers represent
          rec.last_run_mode = rec.last_run_mode || MODE_PRECISE;
          changed = true;
        }
      }

      if (changed) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        } catch (e) {
          // ignore save failures
        }
      }
      return parsed;
    }
  } catch (e) {
    console.warn("Failed to load saved:", e);
  }
  return {};
}

function saveSaved(obj) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn("Failed to save:", e);
  }
}


// ================== RELOAD ALL SAVED (APPLY EXISTING CALCS TO LATEST PRICES) ==================
// This does NOT re-optimize. It re-runs each stock using its cached thresholds/settings
// (Precise preferred; otherwise Quick) and updates only the outputs (profit/decision/last price).
// getStockData() already checks per-stock cache before making an API call.

function pickPreferredSavedMode(rec) {
  const modes = rec && rec.modes ? rec.modes : {};
  if (modes[MODE_PRECISE]) return MODE_PRECISE;
  if (modes[MODE_QUICK]) return MODE_QUICK;
  return null;
}

function buildOptionsFromModeRec(modeRec) {
  return {
    positionScale: typeof modeRec.position_scale === "number" ? modeRec.position_scale : 1.0,
    minHoldDays: typeof modeRec.min_hold_days === "number" ? modeRec.min_hold_days : 0,
    longTermRatio: typeof modeRec.long_term_ratio === "number" ? modeRec.long_term_ratio : 0.0,
    longTermMinHoldDays:
      typeof modeRec.long_term_min_hold_days === "number" ? modeRec.long_term_min_hold_days : 0,

    regimeSensitivity:
      typeof modeRec.regime_sensitivity === "number" ? modeRec.regime_sensitivity : REGIME_SENS_DEFAULT,
    regimeWindowDays:
      typeof modeRec.regime_window_days === "number" ? modeRec.regime_window_days : REGIME_WINDOW_DAYS,
    regimeTrendDays:
      typeof modeRec.regime_trend_days === "number" ? modeRec.regime_trend_days : REGIME_TREND_DAYS,
    regimeRangePct:
      typeof modeRec.regime_range_pct === "number" ? modeRec.regime_range_pct : REGIME_RANGE_PCT
  };
}

function runUsingExistingCalcs(prices, modeKey, modeRec) {
  const startWallet =
    typeof modeRec.start_wallet === "number" && isFinite(modeRec.start_wallet)
      ? modeRec.start_wallet
      : (modeKey === MODE_QUICK ? QUICK_START_WALLET : START_WALLET);

  const options = buildOptionsFromModeRec(modeRec);

  const res = biasedTrader(
    prices,
    startWallet,
    modeRec.sell_pct_thresh,
    modeRec.buy_pct_thresh,
    MAX_LOOKBACK_DAYS,
    options
  );

  // carry forward tuned params for saving consistency
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

  // Convert executed-trade output into the wallet-independent, sized signal for UI/saving.
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

  res.last_decision = signal.decision;
  res.last_amount = signal.size || "";
  res.last_action_price = res.last_price;

  return res;
}

function updateSavedRunOutputs(savedObj, sym, modeKey, newRes) {
  const rec = savedObj[sym];
  if (!rec || !rec.modes || !rec.modes[modeKey]) return;

  const modeRec = rec.modes[modeKey];

  // Update outputs only
  modeRec.profit = newRes.profit;
  modeRec.last_decision = newRes.last_decision;
  modeRec.last_amount = newRes.last_amount;
  modeRec.last_action_price = newRes.last_action_price;
  modeRec.last_price = newRes.last_price;

  // Extra debug/signal fields
  modeRec.exec_last_decision = newRes.exec_last_decision || null;
  modeRec.exec_last_amount = (typeof newRes.exec_last_amount === "number") ? newRes.exec_last_amount : null;
  modeRec.signal_score = (typeof newRes.signal_score === "number") ? newRes.signal_score : null;
  modeRec.signal_reason = newRes.signal_reason || null;
  modeRec.signal_suggested_shares = (typeof newRes.signal_suggested_shares === "number") ? newRes.signal_suggested_shares : null;

  rec.modes[modeKey] = modeRec;

  // Refresh top-level compatibility fields (Precise preferred)
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

  let completed = 0;
  const total = symbols.length;

  try {
    setStatus(`Reloading ${total} saved symbol(s)...`);
    setProgress(0, `Reloading ${total} symbol(s)...`);

    // Start each symbol after RELOAD_ALL_STAGGER_MS, without waiting for the prior one to finish.
    const tasks = symbols.map((sym, idx) => {
      return new Promise((resolve) => {
        setTimeout(async () => {
          const upper = String(sym).toUpperCase();
          try {
            const rec = saved[upper];
            const modes = rec && rec.modes ? rec.modes : null;
            if (!modes) throw new Error("Missing modes for saved symbol.");

            // Prefer Precise if it exists; otherwise use Quick if it exists.
            const modeKey = modes[MODE_PRECISE] ? MODE_PRECISE : (modes[MODE_QUICK] ? MODE_QUICK : null);
            if (!modeKey) throw new Error("No cached mode found.");

            const modeRec = modes[modeKey];
            if (!modeRec || typeof modeRec.sell_pct_thresh !== "number" || typeof modeRec.buy_pct_thresh !== "number") {
              throw new Error("Missing cached thresholds.");
            }

            // Fetch fresh prices (may hit cache)
            const data = await getStockData(upper);
            const prices = data && Array.isArray(data.prices) ? data.prices : [];
            if (!prices.length) throw new Error("No price data.");

            // Rerun using existing calcs (fast)
            const newRes = runUsingExistingCalcs(prices, modeKey, modeRec);
            newRes.calc_used = modeRec.calc_used || `Using cached ${modeKey} settings`;
            newRes.updated_at = new Date().toISOString();
            newRes.updated_date = new Date().toLocaleDateString();

            updateSavedRunOutputs(saved, upper, modeKey, newRes);

            // re-render list as each stock completes
            renderSavedList();
          } catch (e) {
            console.warn(`[Reload all] ${upper} failed:`, e);
          } finally {
            completed++;
            const pct = Math.round((completed * 100) / total);
            setProgress(pct, `Reloaded ${completed}/${total}`);
            resolve();
          }
        }, idx * RELOAD_ALL_STAGGER_MS);
      });
    });

    await Promise.all(tasks);

    saveSaved(saved);
    renderSavedList();
    setStatus("Reload complete.");
    setProgress(100, "Reload complete.");
  } finally {
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

  // Build records with computed profit % upfront (prefer Precise whenever present)
  const records = symbols.map((sym) => {
    const rec = saved[sym] || {};
    const modes = (rec && typeof rec === "object" && rec.modes) ? rec.modes : {};

    const displayMode =
      modes[MODE_PRECISE] ? MODE_PRECISE : (modes[MODE_QUICK] ? MODE_QUICK : (rec.last_run_mode || MODE_QUICK));
    const displayRec = (modes && modes[displayMode]) ? modes[displayMode] : rec;

    const profit = (displayRec && typeof displayRec.profit === "number") ? displayRec.profit : 0;

    const startWallet =
      displayRec && typeof displayRec.start_wallet === "number" && isFinite(displayRec.start_wallet)
        ? displayRec.start_wallet
        : START_WALLET;

    const profitPct =
      startWallet > 0 && isFinite(startWallet)
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

  // Sort: action first, then by profit%
  records.sort((a, b) => {
    if (a._isAction !== b._isAction) return a._isAction ? -1 : 1;
    return (b._profitPct || 0) - (a._profitPct || 0);
  });

  let html = "";
  for (const rec of records) {
    const sym = rec.symbol;
    const displayRec = rec._displayRec || rec;

    const profit = (displayRec && typeof displayRec.profit === "number") ? displayRec.profit : 0;

    // Prefer freshest price from the daily price cache (so list updates even if calcs are not re-saved)
    let lastPrice = (displayRec && typeof displayRec.last_price === "number") ? displayRec.last_price : 0;
    try {
      const cached = getCachedPricesIfFresh(sym);
      if (cached && Array.isArray(cached.prices) && cached.prices.length) {
        const p = cached.prices[cached.prices.length - 1];
        if (typeof p === "number" && isFinite(p)) lastPrice = p;
      }
    } catch (e) {
      // ignore cache read issues
    }

    const profitPct = rec._profitPct || 0;
    const profitPctText =
      (profitPct >= 0 ? "+" : "-") + Math.abs(profitPct).toFixed(2) + "%";

    const profitClass =
      profit >= 0 ? "saved-profit-positive" : "saved-profit-negative";

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
  if (!symbol) return;
  currentSymbol = symbol.toUpperCase();

  if (!savedList) return;
  const btns = savedList.querySelectorAll(".saved-btn");
  btns.forEach((btn) => {
    const isActive = btn.dataset.symbol === currentSymbol;
    if (isActive) {
      btn.classList.add("saved-btn-active");
    } else {
      btn.classList.remove("saved-btn-active");
    }
  });
}

// ================== SYMBOL RESOLUTION ==================
async function searchSymbolAlpha(query) {
  const apiKey = getIdent();
  const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(
    query
  )}&apikey=${encodeURIComponent(apiKey)}`;

  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.bestMatches)) {
    return null;
  }

  const best = data.bestMatches[0];
  if (!best) return null;

  const symbol = best["1. symbol"];
  const name = best["2. name"];
  if (!symbol) return null;
  return { symbol, name };
}

function normalizeNameKey(str) {
  return str.trim().toLowerCase().replace(/[.,']/g, "");
}

async function resolveSymbol(inputStr) {
  const raw = inputStr.trim();
  if (!raw) throw new Error("Please enter a symbol or company name.");

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
  if (!res) throw new Error("Could not resolve symbol for: " + raw);

  const extra = loadNameMap();
  extra[key] = res.symbol;
  saveNameMap(extra);

  return res;
}

// ================== PRICE FETCHING ==================
async function fetchStockDataFromApi(symbol) {
  const apiKey = getIdent();
  const baseUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${encodeURIComponent(apiKey)}`;

  // Try compact history first
  let url = baseUrl + "&outputsize=compact";
  let data = await fetchJson(url);

  let info = (data && (data.Information || data.Note)) || "";
  if (
    !data["Time Series (Daily)"] &&
    typeof info === "string" &&
    info.toLowerCase().includes("outputsize=compact")
  ) {
    // fall back to compact
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

  // sort oldest → newest
  entries.sort((a, b) => (a.dateStr < b.dateStr ? -1 : 1));

  const dates = entries.map((e) => e.dateStr);
  const prices = entries.map((e) => e.price);

  if (!prices.length) throw new Error("No prices for " + symbol);

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

function biasedTrader(
  prices,
  startWallet,
  sellPctThresh,
  buyPctThresh,
  maxLookbackDays,
  trackOrOptions = false
) {
  if (!prices || prices.length === 0) {
    return {
      start_wallet: startWallet,         // ← add this
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
  } else {
    options = trackOrOptions || {};
    trackCurve = !!options.trackCurve;
  }

  const positionScale = clamp(
    typeof options.positionScale === "number" ? options.positionScale : 1.0,
    0.25,
    4.0
  );
  const minHoldDays = Math.max(
    0,
    Math.floor(
      typeof options.minHoldDays === "number" ? options.minHoldDays : 0
    )
  );
  const longTermRatio = clamp(
    typeof options.longTermRatio === "number" ? options.longTermRatio : 0.0,
    0.0,
    0.9
  );
  const longTermMinHoldDays = Math.max(
    0,
    Math.floor(
      typeof options.longTermMinHoldDays === "number"
        ? options.longTermMinHoldDays
        : 0
    )
  );

  const regimeSensitivity = clamp(
    typeof options.regimeSensitivity === "number"
      ? options.regimeSensitivity
      : REGIME_SENS_DEFAULT,
    0.0,
    2.0
  );
  const regimeWindowDays = Math.max(
    3,
    Math.floor(
      typeof options.regimeWindowDays === "number"
        ? options.regimeWindowDays
        : REGIME_WINDOW_DAYS
    )
  );
  const regimeTrendDays = Math.max(
    2,
    Math.floor(
      typeof options.regimeTrendDays === "number"
        ? options.regimeTrendDays
        : REGIME_TREND_DAYS
    )
  );
  const regimeRangePct = Math.max(
    5,
    typeof options.regimeRangePct === "number"
      ? options.regimeRangePct
      : REGIME_RANGE_PCT
  );


  let wallet = startWallet;

  // each lot: { buyPrice, amount, buyIndex, isLong }
  let lots = [];

  let lastDecision = "HOLD";
  let lastAmount = 0;
  let lastActionPrice = prices[0];

  const equityCurve = trackCurve ? [] : null;
  const buyMarkers = trackCurve ? new Array(prices.length).fill(0) : null;
  const sellMarkers = trackCurve ? new Array(prices.length).fill(0) : null;
  const sharesHeld = trackCurve ? new Array(prices.length).fill(0) : null;
  const walletSeries = trackCurve ? new Array(prices.length).fill(0) : null;

  // day 0 snapshot
  if (trackCurve) {
    const p0 = prices[0];
    const totalShares0 = lots.reduce((acc, lot) => acc + lot.amount, 0);
    const totalVal0 = wallet + totalShares0 * p0;
    equityCurve.push(totalVal0);
    sharesHeld[0] = totalShares0;
    walletSeries[0] = wallet;
  }

  for (let i = 1; i < prices.length; i++) {
    const price = prices[i];

    lastDecision = "HOLD";
    lastAmount = 0;
    lastActionPrice = 0;

    // ===== Regime scaling (multi-day range + trend) =====
    // Compute rolling min/max over a short window to detect "huge" run-ups/drawdowns.
    const wStart = Math.max(0, i - regimeWindowDays);
    let wMin = Infinity;
    let wMax = -Infinity;
    for (let j = wStart; j <= i; j++) {
      const v = prices[j];
      if (v < wMin) wMin = v;
      if (v > wMax) wMax = v;
    }

    const wRange = wMax - wMin;
    const rangePct = wMin > 0 ? (wRange / wMin) * 100 : 0;
    const posInRange = wRange > 0 ? (price - wMin) / wRange : 0.5;

    const tIdx = Math.max(0, i - regimeTrendDays);
    const tRef = prices[tIdx];
    const trendPct = tRef > 0 ? ((price - tRef) / tRef) * 100 : 0;

    const rangeStrength = clamp((rangePct - regimeRangePct) / regimeRangePct, 0, 2) / 2; // 0..1
    const posHighStrength = clamp((posInRange - 0.75) / 0.25, 0, 1);
    const posLowStrength = clamp((0.25 - posInRange) / 0.25, 0, 1);
    const trendUpStrength = clamp((trendPct - regimeRangePct) / regimeRangePct, 0, 2) / 2;
    const trendDownStrength = clamp(((-trendPct) - regimeRangePct) / regimeRangePct, 0, 2) / 2;

    const overextendedStrength = rangeStrength * Math.max(posHighStrength, trendUpStrength);
    const oversoldStrength = rangeStrength * Math.max(posLowStrength, trendDownStrength);

    // Adjust thresholds and position sizing dynamically.
    let effSellPctThresh = sellPctThresh;
    let effBuyPctThresh = buyPctThresh;
    let effPositionScale = positionScale;

    if (overextendedStrength > 0) {
      // After huge run-ups, require a larger drop to buy, and optionally sell a bit earlier.
      effBuyPctThresh = buyPctThresh * (1 + regimeSensitivity * 1.25 * overextendedStrength);
      effSellPctThresh = Math.max(
        0.5,
        sellPctThresh * (1 - regimeSensitivity * 0.25 * overextendedStrength)
      );
      effPositionScale = clamp(
        effPositionScale * (1 - regimeSensitivity * 0.7 * overextendedStrength),
        0.25,
        4.0
      );
    } else if (oversoldStrength > 0) {
      // After huge dips, allow buying earlier and a bit larger (mean-reversion bias).
      effBuyPctThresh = Math.max(
        0.5,
        buyPctThresh * (1 - regimeSensitivity * 0.45 * oversoldStrength)
      );
      effPositionScale = clamp(
        effPositionScale * (1 + regimeSensitivity * 0.9 * oversoldStrength),
        0.25,
        4.0
      );
    }


    // ========== SELL PHASE ==========
    if (lots.length) {
      const hasShortLots = lots.some((lot) => !lot.isLong);

      for (let idx = lots.length - 1; idx >= 0; idx--) {
        const lot = lots[idx];
        const buyPrice = lot.buyPrice;
        const amount = lot.amount;
        if (amount <= 0 || buyPrice <= 0) {
          lots.splice(idx, 1);
          continue;
        }

        const requiredHold = lot.isLong ? longTermMinHoldDays : minHoldDays;
        const heldDays = i - lot.buyIndex;
        if (requiredHold > 0 && heldDays < requiredHold) continue;

        // long-term lots only sell if there are NO short-term lots
        if (lot.isLong && hasShortLots) continue;

        const profitPct = ((price - buyPrice) / buyPrice) * 100;
        if (buyPrice < price && profitPct > effSellPctThresh) {
          wallet += amount * price;
          lots.splice(idx, 1);
          lastAmount += amount;
          lastActionPrice = price;
          lastDecision = "SELL";
        }
      }
    }

    // ========== BUY PHASE ==========
    if (wallet > price) {
      let highestPercent = 0.0;
      const maxBack = clamp(maxLookbackDays + 1, 1, i);

      for (let x = 1; x < maxBack; x++) {
        const prevPrice = prices[i - x];
        if (price < prevPrice && prevPrice > 0) {
          const dropPct = ((price - prevPrice) / prevPrice) * 100;
          if (dropPct < highestPercent) {
            highestPercent = dropPct;
          }
        }
      }

      if (highestPercent < -effBuyPctThresh) {
        let amount = 0;
        const maxSteps = Math.floor(Math.abs(highestPercent) * effPositionScale);

        for (let step = 1; step <= maxSteps; step++) {
          if (wallet > price) {
            wallet -= price;
            amount += 1;
          } else {
            break;
          }
        }

        if (amount > 0) {
          const longAmount =
            longTermRatio > 0 ? Math.floor(amount * longTermRatio) : 0;
          const shortAmount = amount - longAmount;

          if (shortAmount > 0) {
            lots.push({
              buyPrice: price,
              amount: shortAmount,
              buyIndex: i,
              isLong: false
            });
          }
          if (longAmount > 0) {
            lots.push({
              buyPrice: price,
              amount: longAmount,
              buyIndex: i,
              isLong: true
            });
          }

          lastAmount = amount;
          lastActionPrice = price;
          lastDecision = "BUY";
        }
      }
    }

    // ========== TRACK CURVE & SERIES ==========
    if (trackCurve) {
      const totalShares = lots.reduce((acc, lot) => acc + lot.amount, 0);
      const totalVal = wallet + totalShares * price;

      equityCurve.push(totalVal);
      sharesHeld[i] = totalShares;
      walletSeries[i] = wallet;

      if (lastDecision === "BUY" && lastAmount > 0) {
        buyMarkers[i] = lastAmount;
      } else if (lastDecision === "SELL" && lastAmount > 0) {
        sellMarkers[i] = lastAmount;
      }
    }
  }

  const finalPrice = prices[prices.length - 1];
  const totalShares = lots.reduce((acc, lot) => acc + lot.amount, 0);
  const finalValue = wallet + totalShares * finalPrice;
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
    last_price: finalPrice,
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
    regime_range_pct: regimeRangePct
  };
}

// ================== SIGNAL (WALLET-INDEPENDENT) DECISION + SIZING ==================
// This decouples the "signal" (BUY/SELL/HOLD + Low/Med/High) from whether the backtest
// actually had wallet available to execute that trade. This fixes the "wallet=0 => HOLD"
// issue while still using the optimized thresholds/settings from the simulations.

const SIZE_LOW = "LOW";
const SIZE_MED = "MEDIUM";
const SIZE_HIGH = "HIGH";

function _sizeFromScore(score) {
  if (!isFinite(score) || score <= 0) return null;
  if (score < 0.60) return SIZE_LOW;
  if (score < 1.40) return SIZE_MED;
  return SIZE_HIGH;
}

function _sizeFraction(size) {
  if (size === SIZE_LOW) return 0.15;
  if (size === SIZE_MED) return 0.35;
  if (size === SIZE_HIGH) return 0.65;
  return 0.0;
}

function computeRegimeAtIndex(prices, i, baseParams) {
  const price = prices[i];
  const regimeSensitivity = clamp(
    typeof baseParams.regime_sensitivity === "number" ? baseParams.regime_sensitivity : REGIME_SENS_DEFAULT,
    0.0, 2.0
  );
  const regimeWindowDays = Math.max(
    3,
    Math.floor(typeof baseParams.regime_window_days === "number" ? baseParams.regime_window_days : REGIME_WINDOW_DAYS)
  );
  const regimeTrendDays = Math.max(
    2,
    Math.floor(typeof baseParams.regime_trend_days === "number" ? baseParams.regime_trend_days : REGIME_TREND_DAYS)
  );
  const regimeRangePct = Math.max(
    5,
    typeof baseParams.regime_range_pct === "number" ? baseParams.regime_range_pct : REGIME_RANGE_PCT
  );

  const sellPctThresh = typeof baseParams.sell_pct_thresh === "number" ? baseParams.sell_pct_thresh : 0;
  const buyPctThresh = typeof baseParams.buy_pct_thresh === "number" ? baseParams.buy_pct_thresh : 0;

  const wStart = Math.max(0, i - regimeWindowDays);
  let wMin = Infinity;
  let wMax = -Infinity;
  for (let j = wStart; j <= i; j++) {
    const v = prices[j];
    if (v < wMin) wMin = v;
    if (v > wMax) wMax = v;
  }

  const wRange = wMax - wMin;
  const rangePct = wMin > 0 ? (wRange / wMin) * 100 : 0;
  const posInRange = wRange > 0 ? (price - wMin) / wRange : 0.5;

  const tIdx = Math.max(0, i - regimeTrendDays);
  const tRef = prices[tIdx];
  const trendPct = tRef > 0 ? ((price - tRef) / tRef) * 100 : 0;

  const rangeStrength = clamp((rangePct - regimeRangePct) / regimeRangePct, 0, 2) / 2; // 0..1
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
    effSellPctThresh = Math.max(
      0.5,
      sellPctThresh * (1 - regimeSensitivity * 0.25 * overextendedStrength)
    );
  } else if (oversoldStrength > 0) {
    effBuyPctThresh = Math.max(
      0.5,
      buyPctThresh * (1 - regimeSensitivity * 0.45 * oversoldStrength)
    );
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

function computeSignalSizedDecision(prices, bestParams, portfolioSnap = null) {
  if (!Array.isArray(prices) || prices.length < 3) {
    return { decision: "HOLD", size: null, score: 0, reason: "Not enough data", suggestedShares: 0 };
  }

  const i = prices.length - 1;
  const price = prices[i];

  const regime = computeRegimeAtIndex(prices, i, bestParams);

  // Look at a recent window for extremes (separate from regime window; this is "latest trend")
  const signalWindow = Math.max(10, Math.min(45, Math.floor((bestParams.regime_window_days ?? REGIME_WINDOW_DAYS) * 1.5)));
  const start = Math.max(0, i - signalWindow);

  let recentHigh = -Infinity;
  let recentLow = Infinity;
  for (let j = start; j <= i; j++) {
    const v = prices[j];
    if (v > recentHigh) recentHigh = v;
    if (v < recentLow) recentLow = v;
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

  // Boost score based on regime context + trend direction
  buyScore *= (1 + 0.80 * regime.oversoldStrength);
  sellScore *= (1 + 0.80 * regime.overextendedStrength);

  if (regime.trendPct < 0) {
    buyScore *= (1 + clamp((-regime.trendPct) / Math.max(5, regime.regimeRangePct), 0, 1));
  } else if (regime.trendPct > 0) {
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
    } else if (decision === "SELL") {
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

// Build equity curve for chosen thresholds by re-running strategy on prefixes
function buildEquityCurve(
  prices,
  sellPctThresh,
  buyPctThresh,
  positionScale,
  minHoldDays,
  longTermRatio,
  longTermMinHoldDays
) {
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
    const res = biasedTrader(
      subPrices,
      START_WALLET,
      sellPctThresh,
      buyPctThresh,
      MAX_LOOKBACK_DAYS,
      options
    );
    curve.push(res.final_value);
  }
  return curve;
}

async function gridSearchThresholdsWithProgress(
  prices,
  startWallet, // kept for compatibility, not used
  onProgress
) {
  const sellValues = [];
  const buyValues = [];

  // 1.0% .. 25.0% in 0.5% steps
  for (let i = 10; i <= 250; i += 5) {
    const v = i / 10.0;
    sellValues.push(v);
    buyValues.push(v);
  }

  const positionScales = [0.5, 0.75, 1.0, 1.25];
  const shortMinHolds = [0, 2, 5];
  const longTermRatios = [0.0, 0.25, 0.5];
  const longTermHoldDays = [0, 10, 20];

  // ----- binary-search-style wallet optimization -----
  const MIN_WALLET = 100;
  const MAX_WALLET = 10000;
  const WALLET_STEP = 100;      // resolution ≈ $100
  const MAX_WALLET_EVALS = 30;  // rough upper bound per param set

  const totalParamCombos =
    sellValues.length *
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
    if (snapped < MIN_WALLET) snapped = MIN_WALLET;
    if (snapped > MAX_WALLET) snapped = MAX_WALLET;
    return snapped;
  }

  async function registerEvalProgress() {
    count++;
    const percent = Math.min(99, Math.floor((count * 100) / totalIters));
    if (onProgress && percent !== lastPercentShown) {
      lastPercentShown = percent;
      onProgress(percent);
    }

    if (count % 400 === 0) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async function evalWallet(
    wallet,
    sellThresh,
    buyThresh,
    posScale,
    minHold,
    ltRatio,
    ltHold
  ) {
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
    const profitPct =
      w > 0 && isFinite(w) ? (profit / w) * 100 : -Infinity;

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

  async function searchBestWalletForParams(
    sellThresh,
    buyThresh,
    posScale,
    minHold,
    ltRatio,
    ltHold
  ) {
    let low = MIN_WALLET;
    let high = MAX_WALLET;

    // start in the middle of the range
    let mid = (low + high) / 2;
    let bestWallet = snapWallet(mid);
    let bestPct = await evalWallet(
      bestWallet,
      sellThresh,
      buyThresh,
      posScale,
      minHold,
      ltRatio,
      ltHold
    );

    const MAX_ITERS = 10;            // max binary-search steps
    const MAX_NO_IMPROVEMENT = 3;    // stop after 3 steps with no better profit
    let noImprovementCount = 0;

    for (let iter = 0; iter < MAX_ITERS && high - low > 2 * WALLET_STEP; iter++) {
      const beforeBestPct = bestPct; // remember current best for this param combo

      const left = (low + mid) / 2;   // e.g. 2.5k when mid is 5k
      const right = (mid + high) / 2; // e.g. 7.5k when mid is 5k

      const leftPct = await evalWallet(
        left,
        sellThresh,
        buyThresh,
        posScale,
        minHold,
        ltRatio,
        ltHold
      );
      const rightPct = await evalWallet(
        right,
        sellThresh,
        buyThresh,
        posScale,
        minHold,
        ltRatio,
        ltHold
      );

      // pick the best of left / mid / right and shrink around it
      if (leftPct >= bestPct && leftPct >= rightPct) {
        // best is on the left side
        high = mid;
        mid = left;
        bestPct = leftPct;
        bestWallet = snapWallet(left);
      } else if (rightPct >= bestPct && rightPct >= leftPct) {
        // best is on the right side
        low = mid;
        mid = right;
        bestPct = rightPct;
        bestWallet = snapWallet(right);
      } else {
        // middle is still best -> narrow around it
        low = left;
        high = right;
        // mid stays where it is, bestPct unchanged
      }

      // === early stop: no better wallet for 3 binary steps ===
      if (bestPct <= beforeBestPct + 1e-9) {
        noImprovementCount++;
        if (noImprovementCount >= MAX_NO_IMPROVEMENT) {
          break;
        }
      } else {
        noImprovementCount = 0; // reset streak if we found an improvement
      }
    }

    // Final sweep around the best wallet (≈ ±$300) in $100 steps
    const sweepLow = Math.max(MIN_WALLET, bestWallet - 300);
    const sweepHigh = Math.min(MAX_WALLET, bestWallet + 300);
    for (let w = sweepLow; w <= sweepHigh; w += WALLET_STEP) {
      await evalWallet(w, sellThresh, buyThresh, posScale, minHold, ltRatio, ltHold);
    }
  }

  // ----- loop over all threshold combinations, binary-searching wallet each time -----
  for (const sellThresh of sellValues) {
    for (const buyThresh of buyValues) {
      for (const posScale of positionScales) {
        for (const minHold of shortMinHolds) {
          for (const ltRatio of longTermRatios) {
            for (const ltHold of longTermHoldDays) {
              await searchBestWalletForParams(
                sellThresh,
                buyThresh,
                posScale,
                minHold,
                ltRatio,
                ltHold
              );
            }
          }
        }
      }
    }
  }

  // make sure the progress bar finishes
  onProgress(100);

  return bestResult;
}

async function gridSearchThresholdsFixedWalletWithProgress(
  prices,
  fixedWallet,
  onProgress
) {
  const sellValues = [];
  const buyValues = [];

  // 1.0% .. 25.0% in 0.5% steps
  for (let i = 10; i <= 250; i += 5) {
    const v = i / 10.0;
    sellValues.push(v);
    buyValues.push(v);
  }

  const positionScales = [0.5, 0.75, 1.0, 1.25];
  const shortMinHolds = [0, 2, 5];
  const longTermRatios = [0.0, 0.25, 0.5];
  const longTermHoldDays = [0, 10, 20];

  const totalIters =
    sellValues.length *
    buyValues.length *
    positionScales.length *
    shortMinHolds.length *
    longTermRatios.length *
    longTermHoldDays.length;

  let count = 0;
  let lastPercentShown = -1;

  let bestProfitPct = -Infinity;
  let bestResult = null;

  async function registerEvalProgress() {
    count++;
    const percent = Math.min(99, Math.floor((count * 100) / totalIters));
    if (onProgress && percent !== lastPercentShown) {
      lastPercentShown = percent;
      onProgress(percent);
    }
    if (count % 300 === 0) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  for (const sellThresh of sellValues) {
    for (const buyThresh of buyValues) {
      for (const posScale of positionScales) {
        for (const minHold of shortMinHolds) {
          for (const ltRatio of longTermRatios) {
            for (const ltHold of longTermHoldDays) {
              await registerEvalProgress();

              const res = biasedTrader(
                prices,
                fixedWallet,
                sellThresh,
                buyThresh,
                MAX_LOOKBACK_DAYS,
                {
                  positionScale: posScale,
                  minHoldDays: minHold,
                  longTermRatio: ltRatio,
                  longTermMinHoldDays: ltHold,

                  // new regime scaling (kept fixed unless you later decide to grid-search it)
                  regimeSensitivity: REGIME_SENS_DEFAULT,
                  regimeWindowDays: REGIME_WINDOW_DAYS,
                  regimeTrendDays: REGIME_TREND_DAYS,
                  regimeRangePct: REGIME_RANGE_PCT
                }
              );

              const profitPct =
                fixedWallet > 0 && isFinite(fixedWallet)
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

                  // mirror regime fields for saving/display
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

  if (onProgress) onProgress(100);
  return bestResult;
}


function updateChart(
  symbol,
  dates,
  prices,
  equityCurve,
  buyMarkers = [],
  sellMarkers = [],
  sharesHeld = [],
  walletSeries = [],
  startWalletUsed = START_WALLET
) {
  if (priceChart) {
    priceChart.destroy();
  }

  const datasets = [
    {
      label: `${symbol.toUpperCase()} Price`,
      data: prices,
      borderWidth: 1.5,
      pointRadius: 0,
      borderColor: "#3b82f6", // blue
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

      // BUY circles
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

      // SELL crosses
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

  // Wallet dataset
  datasets.push({
    label: "Wallet",
    data: walletSeries,
    type: "line",
    yAxisID: "yHidden",     // 👈 important
    borderWidth: 0,
    pointRadius: 0,
    hitRadius: 0,
    backgroundColor: "rgba(0,0,0,0)",
    borderColor: "rgba(0,0,0,0)"
  });

  // Shares dataset
  datasets.push({
    label: "Shares",
    data: sharesHeld,
    type: "line",
    yAxisID: "yHidden",     // 👈 important
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
            // hide Wallet / Shares from legend
            filter: (item) =>
              item.text !== "Wallet" && item.text !== "Shares"
          }
        },

        tooltip: {
          position: "dynamicSide",   // 👈 important
          mode: "index",
          intersect: false,
          displayColors: false,
          padding: 6,
          bodySpacing: 2,
          boxPadding: 4,
          yAlign: "center",
          caretPadding: 10,

          // order: price/sim lines -> buy/sell -> wallet -> shares
          itemSort: function (a, b) {
            const la = a.dataset.label || "";
            const lb = b.dataset.label || "";

            const isMarkerA = la === "Buys" || la === "Sells";
            const isMarkerB = lb === "Buys" || lb === "Sells";
            const isWalletA = la === "Wallet";
            const isWalletB = lb === "Wallet";
            const isSharesA = la === "Shares";
            const isSharesB = lb === "Shares";

            // group 0 = price/sim, 1 = markers, 2 = wallet, 3 = shares
            const groupA = isSharesA ? 3 : isWalletA ? 2 : isMarkerA ? 1 : 0;
            const groupB = isSharesB ? 3 : isWalletB ? 2 : isMarkerB ? 1 : 0;

            if (groupA !== groupB) return groupA - groupB;

            // for price/sim group, sort by value (higher first)
            const ya = a.parsed && isFinite(a.parsed.y) ? a.parsed.y : -Infinity;
            const yb = b.parsed && isFinite(b.parsed.y) ? b.parsed.y : -Infinity;
            return yb - ya;
          },

          callbacks: {
            labelTextColor: function (context) {
              const lbl = context.dataset.label || "";

              if (lbl === "Simulation value") return "#22c55e";   // green
              if (lbl.endsWith(" Price"))     return "#3b82f6";   // blue
              if (lbl === "Buys")             return "#22c55e";   // green
              if (lbl === "Sells")            return "#ef4444";   // red
              if (lbl === "Wallet")           return "#e5e7eb";   // white
              if (lbl === "Shares")           return "#e5e7eb";   // white
              return "#e5e7eb";
            },

            label: function (context) {
              const dsLabel = context.dataset.label || "";

              // Wallet line
              if (dsLabel === "Wallet") {
                const v = context.parsed && context.parsed.y;
                if (!isFinite(v)) return "";
                return `Wallet: ${formatMoney(v, false)}`;
              }

              // Shares line
              if (dsLabel === "Shares") {
                const v = context.parsed && context.parsed.y;
                if (!isFinite(v)) return "";
                return `Shares: ${Math.round(v)}`;
              }

              // Buy / Sell markers
              if (dsLabel === "Buys" || dsLabel === "Sells") {
                const raw = context.raw || {};
                const shares = raw.shares != null ? raw.shares : 0;
                if (shares <= 0) return "";
                const action = dsLabel === "Buys" ? "Buy" : "Sell";
                return `${action} ${shares} shares`;
              }

              // Lines (price + simulation)
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
        // visible axis for Price + Simulation only
        y: {
          position: "left",
          beginAtZero: false,
          ticks: {
            color: "#9ca3af",
            callback: function (value) {
              const v = typeof value === "number" ? value : Number(value);
              if (!isFinite(v)) return "";
              const rounded = Math.round(v);
              return "$" + rounded.toString(); // ONLY price/sim formatting
            }
          },
          grid: {
            color: "rgba(148,163,184,0.2)"
          }
        },
        // completely hidden axis for Wallet + Shares (tooltips only)
        yHidden: {
          display: false,        // no axis line / labels
          grid: { display: false },
          ticks: {
            display: false
          }
        }
      }

    }
  });
}

// Save the best simulation result for a symbol into localStorage

function saveBestResult(symbol, result, { mode = MODE_PRECISE, calcUsed = "" } = {}) {
  const sym = (symbol || "").toUpperCase();
  if (!sym) return;

  const saved = loadSaved();
  const prev = saved[sym] || {};
  const prevStar = prev.starred || false;

  const modeKey = mode === MODE_QUICK ? MODE_QUICK : MODE_PRECISE;

  if (!prev.modes) prev.modes = {};

  const hasPreciseAlready = !!prev.modes[MODE_PRECISE];

  // Per request:
  // - Always save Precise (and store the date).
  // - Only save Quick if there is NO Precise cache for this symbol.
  // - Keep any existing Quick in localStorage (do not delete it), but don't overwrite it once Precise exists.
  if (modeKey === MODE_QUICK && hasPreciseAlready) {
    // Still ensure the symbol exists in saved (don’t lose starred state), but do not overwrite cached calcs.
    saved[sym] = {
      ...(saved[sym] || {}),
      symbol: sym,
      modes: prev.modes,
      starred: prevStar,
      // Prefer Precise as the default "display" mode when it exists
      last_run_mode: MODE_PRECISE,
      calc_used: (prev.modes[MODE_PRECISE] && prev.modes[MODE_PRECISE].calc_used) || prev.calc_used || "Precise"
    };
    saveSaved(saved);
    return;
  }

  const modeRecord = {
    symbol: sym,
    start_wallet:
      typeof result.start_wallet === "number" && isFinite(result.start_wallet)
        ? result.start_wallet
        : modeKey === MODE_QUICK
          ? QUICK_START_WALLET
          : START_WALLET,
    sell_pct_thresh: result.sell_pct_thresh,
    buy_pct_thresh: result.buy_pct_thresh,
    position_scale:
      typeof result.position_scale === "number" ? result.position_scale : 1.0,
    min_hold_days:
      typeof result.min_hold_days === "number" ? result.min_hold_days : 0,
    long_term_ratio:
      typeof result.long_term_ratio === "number" ? result.long_term_ratio : 0.0,
    long_term_min_hold_days:
      typeof result.long_term_min_hold_days === "number"
        ? result.long_term_min_hold_days
        : 0,
    regime_sensitivity:
      typeof result.regime_sensitivity === "number" ? result.regime_sensitivity : REGIME_SENS_DEFAULT,
    regime_window_days:
      typeof result.regime_window_days === "number" ? result.regime_window_days : REGIME_WINDOW_DAYS,
    regime_trend_days:
      typeof result.regime_trend_days === "number" ? result.regime_trend_days : REGIME_TREND_DAYS,
    regime_range_pct:
      typeof result.regime_range_pct === "number" ? result.regime_range_pct : REGIME_RANGE_PCT,
    profit: result.profit,
    last_decision: result.last_decision,
    last_amount: result.last_amount,
    last_action_price: result.last_action_price,
    last_price: result.last_price,

    // Debug/extra: keep last EXECUTED trade from the backtest (wallet-dependent)
    exec_last_decision: result.exec_last_decision || null,
    exec_last_amount: (typeof result.exec_last_amount === "number" ? result.exec_last_amount : null),

    // Signal strength metadata (wallet-independent)
    signal_score: (typeof result.signal_score === "number" && isFinite(result.signal_score)) ? result.signal_score : null,
    signal_reason: result.signal_reason || null,
    signal_suggested_shares: (typeof result.signal_suggested_shares === "number" ? result.signal_suggested_shares : null),
    calc_used: calcUsed || (modeKey === MODE_QUICK ? "Quick" : "Precise"),
    updated_at: Date.now(),
    // Requested: store the date the calculation was made (especially for Precise)
    updated_date: modeKey === MODE_PRECISE ? todayISO() : (result.updated_date || null)
  };

  prev.modes[modeKey] = modeRecord;

  // Prefer Precise for the top-level "display" fields whenever it exists.
  const displayModeKey = prev.modes[MODE_PRECISE] ? MODE_PRECISE : modeKey;
  const displayRec = prev.modes[displayModeKey] || modeRecord;

  // Top-level compatibility fields (used by saved list sorting / display)
  saved[sym] = {
    symbol: sym,
    modes: prev.modes,
    starred: prevStar,

    // Always prefer Precise as the "default" mode once it exists
    last_run_mode: displayModeKey,
    calc_used: displayRec.calc_used,
    updated_at: displayRec.updated_at || null,
    updated_date: displayRec.updated_date || null,

    // mirror display record for backwards compatibility
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

// ================== MAIN RUN LOGIC ==================
async function runForInput(
  inputValue,
  { forceReoptimize = false, mode: modeOverride = null } = {}
) {
  const raw = (inputValue || "").trim();
  if (!raw) return;

  let symbolUsed = null; // track which symbol we actually resolved
  const modeKey =
    modeOverride === MODE_PRECISE || modeOverride === MODE_QUICK
      ? modeOverride
      : getSelectedMode();

  runButton.disabled = true;
  setStatus("Resolving symbol...");
  setProgress(0, "Resolving symbol...");

  // reset UI text
  decisionText.textContent = "–";
  decisionExtra.textContent = "";
  thresholdsText.textContent = "–";
  thresholdsExtra.textContent = "";
  profitText.textContent = "–";
  profitExtra.textContent = "";

  const runStartTime =
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

  try {
    // ---- resolve symbol (AAPL, etc.) ----
    const resolved = await resolveSymbol(raw);
    const symbol = resolved.symbol.toUpperCase();
    symbolUsed = symbol;

    setStatus(`Fetching data for ${symbol}...`);
    setProgress(5, `Fetching prices for ${symbol}...`);

    // ---- prices (cached) ----
    const data = await getStockData(symbol);
    const dates = data.dates || [];
    const prices = data.prices || [];
    if (!prices.length) throw new Error("No price data returned.");

    // ---- load saved thresholds/settings (mode-aware) ----
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

        const usedStartWalletFromSaved =
          typeof savedMode.start_wallet === "number" && isFinite(savedMode.start_wallet)
            ? savedMode.start_wallet
            : START_WALLET;

        const options = {
          positionScale:
            typeof savedMode.position_scale === "number" ? savedMode.position_scale : 1.0,
          minHoldDays:
            typeof savedMode.min_hold_days === "number" ? savedMode.min_hold_days : 0,
          longTermRatio:
            typeof savedMode.long_term_ratio === "number" ? savedMode.long_term_ratio : 0.0,
          longTermMinHoldDays:
            typeof savedMode.long_term_min_hold_days === "number"
              ? savedMode.long_term_min_hold_days
              : 0
        
          ,
          regimeSensitivity:
            typeof savedMode.regime_sensitivity === "number" ? savedMode.regime_sensitivity : REGIME_SENS_DEFAULT,
          regimeWindowDays:
            typeof savedMode.regime_window_days === "number" ? savedMode.regime_window_days : REGIME_WINDOW_DAYS,
          regimeTrendDays:
            typeof savedMode.regime_trend_days === "number" ? savedMode.regime_trend_days : REGIME_TREND_DAYS,
          regimeRangePct:
            typeof savedMode.regime_range_pct === "number" ? savedMode.regime_range_pct : REGIME_RANGE_PCT

        };

        bestResult = biasedTrader(
          prices,
          usedStartWalletFromSaved,
          savedMode.sell_pct_thresh,
          savedMode.buy_pct_thresh,
          MAX_LOOKBACK_DAYS,
          options
        );

        // carry over tuned params
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
      } else {
        setProgress(10, "Optimizing thresholds (Precise)...");
        bestResult = await gridSearchThresholdsWithProgress(
          prices,
          START_WALLET,
          (p) => setProgress(p, `Precise search: ${p}%`)
        );
        calcUsed = "Precise (grid search + wallet evals)";
      }
    } else {
      // QUICK mode: same threshold/param search as Precise, but with a single fixed wallet
      const quickWallet = QUICK_START_WALLET;

      // If Quick isn't cached, fall back to using Precise cached thresholds/settings (per request: Precise is the source of truth)
      const baseSaved = savedMode || savedPrecise || null;

      if (baseSaved && !forceReoptimize) {
        const usingPreciseFallback = !savedMode && !!savedPrecise;
        setProgress(20, usingPreciseFallback ? "Using cached Precise settings (Quick wallet)" : "Using cached Quick settings");

        const options = {
          positionScale:
            typeof baseSaved.position_scale === "number" ? baseSaved.position_scale : 1.0,
          minHoldDays:
            typeof baseSaved.min_hold_days === "number" ? baseSaved.min_hold_days : 0,
          longTermRatio:
            typeof baseSaved.long_term_ratio === "number" ? baseSaved.long_term_ratio : 0.0,
          longTermMinHoldDays:
            typeof baseSaved.long_term_min_hold_days === "number"
              ? baseSaved.long_term_min_hold_days
              : 0,
          regimeSensitivity:
            typeof baseSaved.regime_sensitivity === "number" ? baseSaved.regime_sensitivity : REGIME_SENS_DEFAULT,
          regimeWindowDays:
            typeof baseSaved.regime_window_days === "number" ? baseSaved.regime_window_days : REGIME_WINDOW_DAYS,
          regimeTrendDays:
            typeof baseSaved.regime_trend_days === "number" ? baseSaved.regime_trend_days : REGIME_TREND_DAYS,
          regimeRangePct:
            typeof baseSaved.regime_range_pct === "number" ? baseSaved.regime_range_pct : REGIME_RANGE_PCT
        };

        bestResult = biasedTrader(
          prices,
          quickWallet,
          baseSaved.sell_pct_thresh,
          baseSaved.buy_pct_thresh,
          MAX_LOOKBACK_DAYS,
          options
        );

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
      } else {
        setProgress(10, "Optimizing thresholds (Quick, fixed wallet)...");
        bestResult = await gridSearchThresholdsFixedWalletWithProgress(
          prices,
          quickWallet,
          (p) => setProgress(p, `Quick search: ${p}%`)
        );
        calcUsed = `Quick (grid search, fixed $${quickWallet.toFixed(0)} wallet)`;
      }
    }

    if (!bestResult) {
      throw new Error("No result from simulation.");
    }

    // ---------- BUILD EQUITY CURVE & TRADE MARKERS FOR CHART ----------
    const usedStartWallet =
      typeof bestResult.start_wallet === "number" && isFinite(bestResult.start_wallet)
        ? bestResult.start_wallet
        : (modeKey === MODE_QUICK ? QUICK_START_WALLET : START_WALLET);

    const chartSim = biasedTrader(
      prices,
      usedStartWallet,
      bestResult.sell_pct_thresh,
      bestResult.buy_pct_thresh,
      MAX_LOOKBACK_DAYS,
      {
        positionScale: bestResult.position_scale ?? 1.0,
        minHoldDays: bestResult.min_hold_days ?? 0,
        longTermRatio: bestResult.long_term_ratio ?? 0.0,
        longTermMinHoldDays: bestResult.long_term_min_hold_days ?? 0,
        regimeSensitivity: bestResult.regime_sensitivity ?? REGIME_SENS_DEFAULT,
        regimeWindowDays: bestResult.regime_window_days ?? REGIME_WINDOW_DAYS,
        regimeTrendDays: bestResult.regime_trend_days ?? REGIME_TREND_DAYS,
        regimeRangePct: bestResult.regime_range_pct ?? REGIME_RANGE_PCT,
        trackCurve: true
      }
    );

    const equityCurve = chartSim.equity_curve || [];
    const buyMarkers = chartSim.buy_markers || [];
    const sellMarkers = chartSim.sell_markers || [];
    const sharesHeld = chartSim.shares_held || [];
    const walletSeries = chartSim.wallet_series || [];

    updateChart(
      symbol,
      dates,
      prices,
      equityCurve,
      buyMarkers,
      sellMarkers,
      sharesHeld,
      walletSeries,
      usedStartWallet
    );

    // ---------- DECISION TEXT (Signal-based, sized Low/Med/High) ----------
    // NOTE: biasedTrader's last_decision/last_amount reflect the last EXECUTED trade,
    // which can become HOLD when the simulated wallet is depleted. We compute a separate
    // wallet-independent signal based on the optimized thresholds + latest trend.
    const portfolioSnap = {
      wallet: Array.isArray(walletSeries) && walletSeries.length ? walletSeries[walletSeries.length - 1] : bestResult.final_wallet,
      shares: Array.isArray(sharesHeld) && sharesHeld.length ? sharesHeld[sharesHeld.length - 1] : 0
    };

    const execDecision = bestResult.last_decision;
    const execAmount = bestResult.last_amount;

    const signal = computeSignalSizedDecision(prices, bestResult, portfolioSnap);

    

    // High-only action: only show BUY/SELL when the signal strength is HIGH; otherwise HOLD.
    const isHighStrength =
      (signal.size === SIZE_HIGH) || (String(signal.size || "").toUpperCase() === "HIGH");
    const finalDecision =
      ((signal.decision === "BUY" || signal.decision === "SELL") && isHighStrength)
        ? signal.decision
        : "HOLD";
// Store both (debuggable), but use the signal for UI + saving.
    bestResult.exec_last_decision = execDecision;
    bestResult.exec_last_amount = execAmount;
    bestResult.signal_score = signal.score;
    bestResult.signal_reason = signal.reason;
    bestResult.signal_suggested_shares = signal.suggestedShares;

    bestResult.last_decision = finalDecision;
    bestResult.last_amount = "";
    bestResult.last_action_price = bestResult.last_price; // latest price (we're signaling "now")

    // Display: only BUY/SELL when signal is HIGH, otherwise HOLD
    decisionText.textContent = finalDecision;
    decisionText.style.color =
      finalDecision === "BUY" ? "#4ade80" : finalDecision === "SELL" ? "#f97373" : "#9ca3af";

    // show latest price; (optional) keep this simple so UI stays clean
    // show latest price + avg win/loss from the chart simulation
    const wl = computeAvgWinLossFromMarkers(prices, buyMarkers, sellMarkers);
    if (wl && (isFinite(wl.avgWinPct) || isFinite(wl.avgLossPct))) {
      const fmtPct = (v) =>
        (typeof v === "number" && isFinite(v)) ? `${v.toFixed(2)}%` : "–";

      // store for debugging / future UI use
      bestResult.avg_win_pct = wl.avgWinPct;
      bestResult.avg_loss_pct = wl.avgLossPct;
      bestResult.win_samples = wl.winSamples;
      bestResult.loss_samples = wl.lossSamples;

      decisionExtra.innerHTML =
        `<div>$${bestResult.last_price.toFixed(2)}</div>` +
        `<div style="opacity:0.9; font-size:0.75rem;">Avg win: ${fmtPct(wl.avgWinPct)} • Avg loss: ${fmtPct(Math.abs(wl.avgLossPct))}</div>`;
    } else {
      // fallback
      decisionExtra.textContent = `$${bestResult.last_price.toFixed(2)}`;
    }

// ---------- THRESHOLDS TEXT ----------
    thresholdsText.textContent = `Sell > ${bestResult.sell_pct_thresh.toFixed(
      1
    )}%, Buy drop > ${bestResult.buy_pct_thresh.toFixed(1)}%`;

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

    // ---------- PROFIT TEXT ----------
    const profit = bestResult.profit;
    const finalValue = bestResult.final_value;
    const profitPct = (profit / usedStartWallet) * 100;

    const profitStr =
      (profit >= 0 ? "+" : "-") + "$" + Math.abs(profit).toFixed(2);
    const pctStr =
      (profitPct >= 0 ? "+" : "-") + Math.abs(profitPct).toFixed(2) + "%";

    profitText.textContent = `${profitStr} (${pctStr})`;
    profitText.style.color = profit >= 0 ? "#4ade80" : "#f97373";

    profitExtra.textContent = `Final value: $${finalValue.toFixed(
      2
    )} (wallet + holdings)`;

    // ---------- SAVE & REFRESH SAVED LIST ----------
    saveBestResult(symbol, bestResult, { mode: modeKey, calcUsed });
    renderSavedList();

    // how long did the whole run take?
    const runEndTime =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const ms = runEndTime - runStartTime;
    setStatus(`Done (${modeLabel}) — ${(ms / 1000).toFixed(2)}s`);
    setProgress(100, "Done");
    markCurrentSymbol(symbol);
  } catch (err) {
    console.error(err);
    const msg = err?.message || String(err);
    setStatus("Error: " + msg);
    setProgress(0, "Error");
  } finally {
    runButton.disabled = false;
    if (symbolUsed) {
      markCurrentSymbol(symbolUsed);
    }
  }
}


// ================== EVENT LISTENERS (MAIN) ==================
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = input.value || "";
  runForInput(val);
});

runButton.addEventListener("click", () => {
  const val = input.value || "";
  runForInput(val);
});

// --- Reload click timers (so dblclick can cancel the single-click behavior) ---
const _reloadClickTimers = new Map();

function clearSavedCalculationsForSymbol(symbol) {
  const sym = (symbol || "").toUpperCase();
  if (!sym) return;

  const saved = loadSaved();
  const rec = saved[sym];
  if (!rec || typeof rec !== "object") return;

  // Preserve symbol + starred, wipe cached calculations/settings
  const starred = !!rec.starred;
  rec.symbol = sym;
  rec.starred = starred;
  rec.modes = {};

  // Remove top-level compatibility fields so we truly "delete calculations"
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
    if (k in rec) delete rec[k];
  }

  saved[sym] = rec;
  saveSaved(saved);
}

function clearPriceCacheForSymbol(symbol) {
  const sym = (symbol || "").toUpperCase();
  if (!sym) return;

  try {
    const cache = loadPriceCache();
    if (cache && typeof cache === "object" && cache[sym]) {
      delete cache[sym];
      localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
    }
  } catch (e) {
    // ignore
  }
}

savedList.addEventListener("click", (e) => {
  // Reload button:
  // - single click: reuse cached calcs (no forceReoptimize), but still fetch latest prices if cache is stale (getStockData handles this)
  // - shift+click: force reoptimize (existing behavior)
  const reload = e.target.closest(".saved-reload");
  if (reload) {
    const sym = reload.dataset.symbol;
    if (sym) {
      // Delay the single-click action to give dblclick a chance to cancel it
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

  // Delete button: remove symbol
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

  // Click anywhere else on the row → load + run (using cached thresholds if present)
  const btn = e.target.closest(".saved-btn");
  if (!btn) return;

  const sym = btn.dataset.symbol;
  if (!sym) return;

  input.value = sym;

  // Prefer whichever mode was last calculated with (so we don't "flip" a stock's results just because the toggle was changed)
  const saved = loadSaved();
  const rec = saved[(sym || "").toUpperCase()];
  let preferredMode = null;

  if (rec) {
    // Primary: last_run_mode (but we also prefer precise if it exists)
    if (rec.modes && rec.modes[MODE_PRECISE]) {
      preferredMode = MODE_PRECISE;
    } else if (rec.last_run_mode === MODE_QUICK || rec.last_run_mode === MODE_PRECISE) {
      preferredMode = rec.last_run_mode;
    } else if (rec.modes) {
      // Fallback: pick whichever exists (prefer precise if present)
      if (rec.modes[MODE_PRECISE]) preferredMode = MODE_PRECISE;
      else if (rec.modes[MODE_QUICK]) preferredMode = MODE_QUICK;
    }
  }

  runForInput(sym, preferredMode ? { mode: preferredMode } : undefined);
});

// Double-click reload: clear cached calcs + cached prices, then re-run in the currently selected mode
savedList.addEventListener("dblclick", (e) => {
  const reload = e.target.closest(".saved-reload");
  if (!reload) return;

  const sym = reload.dataset.symbol;
  if (!sym) return;

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

// ================== SANDBOX: PORTFOLIO PLAYGROUND ==================

// DOM
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
  if (!pfProgressBar || !pfProgressText) return;
  const clamped = Math.max(0, Math.min(100, pct));
  pfProgressBar.style.width = clamped + "%";
  pfProgressText.textContent = text || "";
}

// create one row
function pfCreateRow(initialSymbol = "", initialPrice = "", initialAmount = "") {
  if (!pfRowsContainer) return;

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

  if (initialSymbol) symInput.value = initialSymbol;
  if (initialPrice !== "") priceInput.value = initialPrice;
  if (initialAmount !== "") amountInput.value = initialAmount;

  removeBtn.addEventListener("click", () => {
    row.remove();
  });

  pfRowsContainer.appendChild(row);
}

// read rows
function pfCollectRows() {
  const rows = [];
  if (!pfRowsContainer) return rows;

  const rowEls = pfRowsContainer.querySelectorAll(".pf-row");
  rowEls.forEach((row) => {
    const sym = row.querySelector(".pf-symbol")?.value.trim();
    if (!sym) return;
    const priceStr = row.querySelector(".pf-price")?.value.trim();
    const amountStr = row.querySelector(".pf-amount")?.value.trim();
    const price = priceStr === "" ? null : Number(priceStr);
    const amount = amountStr === "" ? 0 : Number(amountStr);
    if (isNaN(amount) || amount < 0) return;

    rows.push({
      rawSymbol: sym,
      initialPrice: price,
      amount
    });
  });

  return rows;
}

// manual curve: hold given amounts for each stock + start cash
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

// "Optimized" curve: pick best-performing single stock at each date (idealized)
function pfBuildOptimizedCurve(dates, priceBySymbol, inputs, startCash) {
  const perSymbolCurves = {};
  for (const inp of inputs) {
    const sym = inp.resolvedSymbol;
    const map = priceBySymbol[sym];
    const firstPrice = map[dates[0]];
    if (!firstPrice) continue;
    const curve = [];
    for (const d of dates) {
      const p = map[d];
      if (!p) {
        curve.push(startCash);
      } else {
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
      if (c[i] != null && c[i] > best) best = c[i];
    }
    optimized.push(best);
  }
  return optimized;
}

function pfUpdateChart(dates, manualCurve, optimizedCurve) {
  if (!pfChartCanvas) return;

  if (pfChart) pfChart.destroy();

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
              if (!isFinite(v)) return "";
              const rounded = Math.round(v);
              return "$" + rounded.toString();
            }
          }
        },
        // 👇 new hidden axis for Wallet + Shares
        yHidden: {
          display: false
        }
      }

    }
  });
}

async function pfRunPortfolioAll() {
  if (!pfStartCashInput || !pfRowsContainer) return;

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
    } catch (e) {
      console.error(e);
      continue;
    }
    const symbol = resolved.symbol.toUpperCase();

    let data;
    try {
      data = await getStockData(symbol);
    } catch (e) {
      console.error(e);
      continue;
    }

    const dates = [];
    const prices = [];
    for (let idx = 0; idx < data.dates.length; idx++) {
      const d = data.dates[idx];
      if (startDateVal && d < startDateVal) continue;
      dates.push(d);
      prices.push(data.prices[idx]);
    }
    if (dates.length < 2) continue;

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

  // intersection of dates
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
  const manualCurve = pfBuildManualCurve(
    commonDates,
    priceBySymbol,
    resolvedInputs,
    startCash
  );

  pfSetProgress(80, "Building optimized curve...");
  const optimizedCurve = pfBuildOptimizedCurve(
    commonDates,
    priceBySymbol,
    resolvedInputs,
    startCash
  );

  pfUpdateChart(commonDates, manualCurve, optimizedCurve);
  pfSetProgress(100, "Portfolio simulations complete.");
}

// wire sandbox buttons
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

// ================== INIT ==================
renderSavedList();

// Auto-run the top saved symbol (if any) when the page loads
(function autoRunTopSaved() {
  const firstBtn = savedList.querySelector(".saved-btn");
  if (!firstBtn) return;

  const sym = firstBtn.dataset.symbol;
  if (!sym) return;

  // Prefer Precise on startup for the top symbol if it exists
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
  } catch (e) {
    // ignore
  }

  // fallback: run with current mode
  input.value = sym;
  runForInput(sym);
})();

input.focus();
