// ================== CONSTANTS ==================
const START_WALLET = 5000.0;
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

const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const etaText = document.getElementById("eta-text");

const savedList = document.getElementById("saved-list");
const clearSavedBtn = document.getElementById("clear-saved");

const decisionText = document.getElementById("decision-text");
const decisionExtra = document.getElementById("decision-extra");
const thresholdsText = document.getElementById("thresholds-text");
const thresholdsExtra = document.getElementById("thresholds-extra");
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
    if (parsed && typeof parsed === "object") return parsed;
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

function renderSavedList() {
  const saved = loadSaved();
  const symbols = Object.keys(saved);

  if (!symbols.length) {
    savedList.innerHTML =
      '<div class="saved-empty">No saved symbols yet. Run a simulation to save one.</div>';
    return;
  }

  // Build records with computed profit % upfront
  const records = symbols.map((sym) => {
    const rec = saved[sym];
    const profit = rec.profit || 0;

    const startWallet =
      typeof rec.start_wallet === "number" && isFinite(rec.start_wallet)
        ? rec.start_wallet
        : START_WALLET;

    const profitPct =
      startWallet > 0 && isFinite(startWallet)
        ? (profit / startWallet) * 100
        : 0;

    return {
      ...rec,
      symbol: sym,
      _profitPct: profitPct
    };
  });

  // Mark which ones are BUY/SELL (with amount) vs HOLD
  records.forEach((rec) => {
    const dec = rec.last_decision || "HOLD";
    const amt = rec.last_amount || 0;
    rec._isAction = (dec === "BUY" || dec === "SELL") && amt > 0;
  });

  // Sort:
  //  1) BUY/SELL group first, then HOLD group
  //  2) Within each group, DESC by profit %
  records.sort((a, b) => {
    if (a._isAction !== b._isAction) return a._isAction ? -1 : 1;
    return (b._profitPct || 0) - (a._profitPct || 0);
  });

  let html = "";
  for (const rec of records) {
    const sym = rec.symbol;
    const profit = rec.profit || 0;
    const lastPrice = rec.last_price || 0;

    const profitPct = rec._profitPct || 0;
    const profitPctText =
      (profitPct >= 0 ? "+" : "-") + Math.abs(profitPct).toFixed(2) + "%";

    const profitClass =
      profit >= 0 ? "saved-profit-positive" : "saved-profit-negative";

    const dec = rec.last_decision || "HOLD";
    const amt = rec.last_amount || 0;

    let decisionLabel = "HOLD";
    let decisionColor = "#9ca3af";
    if (dec === "BUY" && amt > 0) {
      decisionLabel = `BUY ${amt}`;
      decisionColor = "#4ade80";
    } else if (dec === "SELL" && amt > 0) {
      decisionLabel = `SELL ${amt}`;
      decisionColor = "#f97373";
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
              $${lastPrice.toFixed(2)}
            </span>
            <span class="saved-reload"
                  data-symbol="${sym}"
                  title="Re-run simulation for ${sym}">⟳</span>
          </div>

          <!-- row 2 -->
          <div class="saved-decision" style="color:${decisionColor};">
            ${decisionLabel}
          </div>
          <div class="saved-last-price-cell"
               style="display:flex; justify-content:flex-end; align-items:center;">
            <!-- BOTTOM RIGHT: % change + delete -->
            <span class="saved-profit ${profitClass}">
              ${profitPctText}
            </span>
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

  // Try full history first
  let url = baseUrl + "&outputsize=full";
  let data = await fetchJson(url);

  let info = (data && (data.Information || data.Note)) || "";
  if (
    !data["Time Series (Daily)"] &&
    typeof info === "string" &&
    info.toLowerCase().includes("outputsize=full")
  ) {
    // fall back to compact
    console.warn("outputsize=full is premium; retrying with compact");
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
      long_term_min_hold_days: 0
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
        if (buyPrice < price && profitPct > sellPctThresh) {
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

      if (highestPercent < -buyPctThresh) {
        let amount = 0;
        const maxSteps = Math.floor(Math.abs(highestPercent) * positionScale);

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
    long_term_min_hold_days: longTermMinHoldDays
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
      longTermMinHoldDays: ltHold
    });

    const profit = res.profit;
    const profitPct =
      w > 0 && isFinite(w) ? (profit / w) * 100 : -Infinity;

    if (profitPct > bestProfitPct) {
      console.log(Math.round(profitPct), w);
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
function saveBestResult(symbol, result) {
  const sym = symbol.toUpperCase();
  const saved = loadSaved();
  const prev = saved[sym] || {};

  saved[sym] = {
    symbol: sym,
    start_wallet:
      typeof result.start_wallet === "number" && isFinite(result.start_wallet)
        ? result.start_wallet
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
    profit: result.profit,
    last_decision: result.last_decision,
    last_amount: result.last_amount,
    last_action_price: result.last_action_price,
    last_price: result.last_price,
    starred: prev.starred || false
  };

  saveSaved(saved);
}

// ================== MAIN RUN LOGIC ==================
async function runForInput(inputValue, { forceReoptimize = false } = {}) {
  const raw = (inputValue || "").trim();
  if (!raw) return;

  let symbolUsed = null; // track which symbol we actually resolved

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
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  try {
    // resolve symbol (name → symbol, or use raw if it already looks like a ticker)
    const resolved = await resolveSymbol(raw);
    const symbol = resolved.symbol.toUpperCase();
    symbolUsed = symbol;
    input.value = symbol;

    setStatus(`Using symbol ${symbol}…`);
    setProgress(5, "Checking cached prices…");

    // load prices (from cache or API)
    const { dates, prices } = await getStockData(symbol);

    const savedAll = loadSaved();
    const saved = savedAll[symbol.toUpperCase()];
    let bestResult;

    if (saved && !forceReoptimize) {
      setProgress(20, "Using cached thresholds");

      const usedStartWalletFromSaved =
        typeof saved.start_wallet === "number" && isFinite(saved.start_wallet)
          ? saved.start_wallet
          : START_WALLET;

      const options = {
        positionScale:
          typeof saved.position_scale === "number" ? saved.position_scale : 1.0,
        minHoldDays:
          typeof saved.min_hold_days === "number" ? saved.min_hold_days : 0,
        longTermRatio:
          typeof saved.long_term_ratio === "number"
            ? saved.long_term_ratio
            : 0.0,
        longTermMinHoldDays:
          typeof saved.long_term_min_hold_days === "number"
            ? saved.long_term_min_hold_days
            : 0
      };

      bestResult = biasedTrader(
        prices,
        usedStartWalletFromSaved,
        saved.sell_pct_thresh,
        saved.buy_pct_thresh,
        MAX_LOOKBACK_DAYS,
        options
      );

      // make sure the result object carries over the tuned parameters
      bestResult.start_wallet = usedStartWalletFromSaved;
      bestResult.sell_pct_thresh = saved.sell_pct_thresh;
      bestResult.buy_pct_thresh = saved.buy_pct_thresh;
      bestResult.position_scale = options.positionScale;
      bestResult.min_hold_days = options.minHoldDays;
      bestResult.long_term_ratio = options.longTermRatio;
      bestResult.long_term_min_hold_days = options.longTermMinHoldDays;

      setProgress(100, "Using cached thresholds");
    } else {
      setProgress(10, "Optimizing thresholds.");
      bestResult = await gridSearchThresholdsWithProgress(
        prices,
        START_WALLET,
        (p) => setProgress(p, `Grid search: ${p}%`)
      );
    }
    if (!bestResult) {
      throw new Error("No result from grid search.");
    }

    // ---------- BUILD EQUITY CURVE & TRADE MARKERS FOR CHART ----------
    const usedStartWallet =
      typeof bestResult.start_wallet === "number" && isFinite(bestResult.start_wallet)
        ? bestResult.start_wallet
        : START_WALLET;

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

    // ---------- DECISION TEXT ----------
    const decision = bestResult.last_decision;
    const amount = bestResult.last_amount;
    const actionPrice = bestResult.last_action_price;

    let decisionMain;
    if (decision === "BUY" && amount > 0) {
      decisionMain = `BUY ${amount} shares`;
    } else if (decision === "SELL" && amount > 0) {
      decisionMain = `SELL ${amount} shares`;
    } else {
      decisionMain = "HOLD";
    }

    decisionText.textContent = `${symbol}: ${decisionMain}`;
    if (amount > 0 && actionPrice > 0) {
      decisionExtra.textContent = `$${actionPrice.toFixed(
        2
      )}`;
    } else {
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
    thresholdsExtra.textContent =
      `Lookback up to ${MAX_LOOKBACK_DAYS} days` +
      ` | Pos scale ×${posScale.toFixed(2)}` +
      ` | Short min hold ${minHold}d` +
      ` | LT ratio ${(ltRatio * 100).toFixed(0)}%` +
      ` | LT min hold ${ltHold}d` +
      ` | Start wallet $${usedStartWallet.toFixed(2)}`;

    // ---------- PROFIT TEXT ----------
    const profit = bestResult.profit;
    const finalValue = bestResult.final_value;
    const profitPct = (profit / usedStartWallet) * 100;

    const profitStr =
      (profit >= 0 ? "+$" : "-$") + Math.abs(profit).toFixed(2);
    const pctStr =
      (profitPct >= 0 ? "+" : "-") +
      Math.abs(profitPct).toFixed(2) +
      "%";

    profitText.textContent = `${profitStr} (${pctStr})`;
    profitText.style.color = profit >= 0 ? "#4ade80" : "#f97373";

    profitExtra.textContent = `Final value: $${finalValue.toFixed(
      2
    )} (wallet + holdings)`;

        // ---------- SAVE & REFRESH SAVED LIST ----------
    saveBestResult(symbol, bestResult);
    renderSavedList();

    // how long did the whole run take?
    const runEndTime =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    const elapsedSec = Math.round((runEndTime - runStartTime) / 1000);
    const elapsedText =
      elapsedSec >= 10 ? elapsedSec.toFixed(1) : elapsedSec.toFixed(2);

    setStatus(`Done in ${elapsedText}s`);
    input.value = "";
  } catch (err) {
    console.error(err);
    setStatus(String(err), true);
    setProgress(0, "Idle");
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

savedList.addEventListener("click", (e) => {
  // Reload button: re-run simulation from scratch (ignore cached thresholds)
  const reload = e.target.closest(".saved-reload");
  if (reload) {
    const sym = reload.dataset.symbol;
    if (sym) {
      input.value = sym;
      runForInput(sym, { forceReoptimize: true });
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

  if (currentSymbol && sym.toUpperCase() === currentSymbol.toUpperCase()) {
    return; // already selected
  }

  input.value = sym;
  runForInput(sym);
});

clearSavedBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  renderSavedList();
});

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

  input.value = sym;
  runForInput(sym);
})();

input.focus();
