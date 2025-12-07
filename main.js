// ================== CONSTANTS ==================
const START_WALLET = 4000.0;
const MAX_LOOKBACK_DAYS = 30;
const STORAGE_KEY = "biasTraderSavedV1";
const PRICE_CACHE_KEY = "biasTraderPriceV1";
const NAME_MAP_KEY = "biasTraderNameMapV1";

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
// Custom tooltip positioner:
//  - base position from Chart's built-in "average" positioner
//  - y attached to Simulation value point
//  - side chosen by data index (left half / right half)
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
  const p = Math.max(0, Math.min(100, percent));
  progressBar.style.width = p + "%";
  progressText.textContent = label || `Progress: ${p}%`;
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

// 2×2 grid saved list: symbol / profit on first row, decision / last price on second row
function renderSavedList() {
  const saved = loadSaved();
  const symbols = Object.keys(saved);

  if (!symbols.length) {
    savedList.innerHTML =
      '<div class="saved-empty">No saved symbols yet. Run a simulation to save one.</div>';
    return;
  }

  const records = symbols.map((sym) => saved[sym]);

  // Mark BUY/SELL with amount vs HOLD
  records.forEach((rec) => {
    const dec = rec.last_decision || "HOLD";
    const amt = rec.last_amount || 0;
    rec._isAction = (dec === "BUY" || dec === "SELL") && amt > 0;
  });

  // BUY/SELL first, then HOLD, within each: highest profit first
  records.sort((a, b) => {
    if (a._isAction !== b._isAction) return a._isAction ? -1 : 1;
    return (b.profit || 0) - (a.profit || 0);
  });

  let html = "";
  for (const rec of records) {
    const sym = rec.symbol;
    const profit = rec.profit || 0;
    const lastPrice = rec.last_price || 0;

    const profitText =
      (profit >= 0 ? "+$" : "-$") + Math.abs(profit).toFixed(2);
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
            <span class="saved-profit ${profitClass}" style="margin-right:4px;">
              ${profitText}
            </span>
            <span class="saved-delete" data-symbol="${sym}" title="Remove ${sym}">✕</span>
          </div>
        <!-- row 2 -->
          <div class="saved-decision" style="color:${decisionColor};">
            ${decisionLabel}
          </div>
          <div class="saved-last-price-cell"
               style="display:flex; justify-content:flex-end; align-items:center;">
            <span class="saved-last-price" style="margin-right:14px;">
              $${lastPrice.toFixed(2)}
            </span>
          </div>
        </div>
      </button>
    `;
  }

  savedList.innerHTML = html;
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

// ================== TRADING SIMULATION ==================
// Core trading simulation with confidence + hysteresis
function biasedTrader(
  prices,
  startWallet,
  sellPctThresh,
  buyPctThresh,
  maxLookbackDays,
  riskMultiplier,
  minHoldDays,
  confidenceStrength,
  hysteresisPct,
  cooldownDaysAfterSell,
  trackCurve = false
) {
  let wallet = startWallet;
  // each lot: { buyPrice, amount, buyIndex }
  let shares = [];

  // Per-day output
  let lastDecision = "HOLD";
  let lastAmount = 0;
  let lastActionPrice = 0;

  // For confidence / trend and hysteresis
  const rm =
    typeof riskMultiplier === "number" && isFinite(riskMultiplier) && riskMultiplier > 0
      ? riskMultiplier
      : 1.0;
  const mh =
    typeof minHoldDays === "number" && isFinite(minHoldDays) && minHoldDays > 0
      ? Math.floor(minHoldDays)
      : 0;
  const conf =
    typeof confidenceStrength === "number" && isFinite(confidenceStrength) && confidenceStrength >= 0
      ? confidenceStrength
      : 0.0;
  const hyst =
    typeof hysteresisPct === "number" && isFinite(hysteresisPct) && hysteresisPct >= 0
      ? hysteresisPct
      : 0.0;
  const cooldown =
    typeof cooldownDaysAfterSell === "number" &&
    isFinite(cooldownDaysAfterSell) &&
    cooldownDaysAfterSell > 0
      ? Math.floor(cooldownDaysAfterSell)
      : 0;

  // For hysteresis: remember last sell
  let lastSellPrice = null;
  let lastSellIndex = Number.NEGATIVE_INFINITY;

  const equityCurve = trackCurve ? [] : null;
  const buyMarkers = trackCurve ? [] : null;
  const sellMarkers = trackCurve ? [] : null;

  if (trackCurve && prices.length > 0) {
    const p0 = prices[0];
    const totalShares0 = shares.reduce((acc, lot) => acc + lot.amount, 0);
    const totalVal0 = wallet + totalShares0 * p0;
    equityCurve.push(totalVal0);
    buyMarkers.push(0);
    sellMarkers.push(0);
  }

  for (let i = 1; i < prices.length; i++) {
    const price = prices[i];

    lastDecision = "HOLD";
    lastAmount = 0;
    lastActionPrice = 0;

    let dayBuy = 0;
    let daySell = 0;

    // --- CONFIDENCE: overbought/oversold vs recent moving average ---
    let effectiveSellThresh = sellPctThresh;
    let effectiveBuyThresh = buyPctThresh;

    if (conf > 0 && maxLookbackDays > 0 && i > 0) {
      const win = Math.min(maxLookbackDays, i + 1); // include today
      let sum = 0;
      for (let j = i - win + 1; j <= i; j++) {
        sum += prices[j];
      }
      const ma = sum / win;
      if (ma > 0) {
        const overboughtPct = ((price - ma) / ma) * 100; // >0 = above average
        const ob = Math.max(0, overboughtPct);

        // When strongly above average:
        //  - make SELL easier
        //  - make BUY harder
        const adj = ob * conf;
        effectiveSellThresh = Math.max(0, sellPctThresh - adj);
        effectiveBuyThresh = buyPctThresh + adj;
      }
    }

    // --- SELL: take profits with min-hold and confidence-adjusted threshold ---
    for (let idx = shares.length - 1; idx >= 0; idx--) {
      const lot = shares[idx];
      const buyPrice = lot.buyPrice;
      const amount = lot.amount;
      if (amount <= 0 || buyPrice <= 0) continue;

      // respect minimum hold time for this lot
      if (mh > 0) {
        const buyIndex = typeof lot.buyIndex === "number" ? lot.buyIndex : i;
        const heldDays = i - buyIndex;
        if (heldDays < mh) continue;
      }

      const profitPct = ((price - buyPrice) / buyPrice) * 100;
      if (buyPrice < price && profitPct > effectiveSellThresh) {
        // sell entire lot
        wallet += amount * price;
        shares.splice(idx, 1);
        daySell += amount;
        lastAmount += amount;
        lastActionPrice = price;
        lastDecision = "SELL";
      }
    }

    if (daySell > 0) {
      lastSellIndex = i;
      lastSellPrice = price;
    }

    // --- BUY: only if allowed by hysteresis & confidence ---
    let allowedToBuy = true;

    if ((hyst > 0 || cooldown > 0) && isFinite(lastSellIndex)) {
      const daysSinceSell = i - lastSellIndex;

      // Cooldown: wait N days after last SELL before any BUY
      if (daysSinceSell < cooldown) {
        allowedToBuy = false;
      }

      // Hysteresis: only buy back if clearly cheaper than the last sell
      if (allowedToBuy && lastSellPrice != null && lastSellPrice > 0) {
        const targetPrice = lastSellPrice * (1 - hyst / 100);
        if (price > targetPrice) {
          allowedToBuy = false;
        }
      }
    }

    if (wallet > price && allowedToBuy) {
      // largest drop within lookback window
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

      // apply confidence-adjusted BUY threshold
      if (highestPercent < -effectiveBuyThresh) {
        let amount = 0;
        const scaledDrop = Math.abs(highestPercent) * rm;
        const maxSteps = Math.max(1, Math.floor(scaledDrop));
        for (let step = 1; step <= maxSteps; step++) {
          if (wallet > price) {
            wallet -= price;
            amount += 1;
          } else {
            break;
          }
        }

        if (amount > 0) {
          shares.push({ buyPrice: price, amount, buyIndex: i });
          dayBuy += amount;
          lastAmount = amount;
          lastActionPrice = price;
          lastDecision = "BUY";
        }
      }
    }

    if (trackCurve) {
      const totalShares = shares.reduce((acc, lot) => acc + lot.amount, 0);
      const totalVal = wallet + totalShares * price;
      equityCurve.push(totalVal);
      buyMarkers.push(dayBuy);
      sellMarkers.push(daySell);
    }
  }

  const finalPrice = prices[prices.length - 1];
  const totalShares = shares.reduce((acc, lot) => acc + lot.amount, 0);
  const finalValue = wallet + totalShares * finalPrice;
  const profit = finalValue - startWallet;

  return {
    final_wallet: wallet,
    final_shares: shares,
    final_value: finalValue,
    profit,
    sell_pct_thresh: sellPctThresh,
    buy_pct_thresh: buyPctThresh,
    max_lookback_days: maxLookbackDays,
    risk_multiplier: rm,
    min_hold_days: mh,
    confidence_strength: conf,
    hysteresis_pct: hyst,
    cooldown_days: cooldown,
    last_decision: lastDecision,
    last_amount: lastAmount,
    last_action_price: lastActionPrice,
    last_price: finalPrice,
    equity_curve: trackCurve ? equityCurve : null,
    buy_markers: trackCurve ? buyMarkers : null,
    sell_markers: trackCurve ? sellMarkers : null
  };
}
// Build equity data (curve + buy/sell markers + shares held + wallet series)
function buildEquityData(
  prices,
  sellPctThresh,
  buyPctThresh,
  maxLookbackDays,
  riskMultiplier,
  minHoldDays,
  confidenceStrength,
  hysteresisPct,
  cooldownDays
) {
  const res = biasedTrader(
    prices,
    START_WALLET,
    sellPctThresh,
    buyPctThresh,
    maxLookbackDays,
    riskMultiplier,
    minHoldDays,
    confidenceStrength,
    hysteresisPct,
    cooldownDays,
    true // trackCurve
  );

  const equityCurve = res.equity_curve || [];
  const buyMarkers = res.buy_markers || [];
  const sellMarkers = res.sell_markers || [];

  // cumulative shares held = sum(buys) - sum(sells)
  const sharesHeld = [];
  let currentShares = 0;
  for (let i = 0; i < buyMarkers.length; i++) {
    const b = buyMarkers[i] || 0;
    const s = sellMarkers[i] || 0;
    currentShares += b - s;
    sharesHeld.push(currentShares);
  }

  // wallet(t) = total_value(t) - shares(t) * price(t)
  const walletSeries = [];
  for (let i = 0; i < equityCurve.length; i++) {
    const total = equityCurve[i];
    const shares = sharesHeld[i] || 0;
    const price = prices[i];
    if (
      typeof total === "number" &&
      isFinite(total) &&
      typeof price === "number" &&
      isFinite(price)
    ) {
      walletSeries.push(total - shares * price);
    } else {
      walletSeries.push(NaN);
    }
  }

  return {
    equityCurve,
    buyMarkers,
    sellMarkers,
    sharesHeld,
    walletSeries
  };
}

async function gridSearchThresholdsWithProgress(
  prices,
  startWallet,
  onProgress
) {
  // Thresholds (slightly narrowed range but still pretty fine-grained)
  const sellValues = [];
  const buyValues = [];
  for (let v = 2.0; v <= 20.0001; v += 0.5) {
    const rounded = Math.round(v * 10) / 10;
    sellValues.push(rounded);
    buyValues.push(rounded);
  }

  const riskValues = [0.75, 1.0, 1.25];
  const lookbackValues = [15, 30];
  const minHoldValues = [0, 2];

  // NEW: confidence + hysteresis grids
  const confValues = [0.0, 0.3, 0.6, 0.9];   // how strongly overbought affects decisions
  const hystValues = [0.0, 3.0, 6.0];        // % cheaper than last sell before rebuy
  const cooldownValues = [0, 2];             // days after sell before allowed to buy

  const totalIters =
    sellValues.length *
    buyValues.length *
    riskValues.length *
    lookbackValues.length *
    minHoldValues.length *
    confValues.length *
    hystValues.length *
    cooldownValues.length;

  let count = 0;
  let lastPercentShown = -1;

  let bestProfit = -Infinity;
  let bestResult = null;

  for (let si = 0; si < sellValues.length; si++) {
    const sellThresh = sellValues[si];
    for (let bi = 0; bi < buyValues.length; bi++) {
      const buyThresh = buyValues[bi];
      for (let ri = 0; ri < riskValues.length; ri++) {
        const riskMult = riskValues[ri];
        for (let li = 0; li < lookbackValues.length; li++) {
          const lookback = lookbackValues[li];
          for (let hi = 0; hi < minHoldValues.length; hi++) {
            const minHold = minHoldValues[hi];
            for (let ci = 0; ci < confValues.length; ci++) {
              const conf = confValues[ci];
              for (let yi = 0; yi < hystValues.length; yi++) {
                const hyst = hystValues[yi];
                for (let di = 0; di < cooldownValues.length; di++) {
                  const cooldown = cooldownValues[di];

                  count++;
                  const percent = Math.floor((count * 100) / totalIters);
                  if (onProgress && percent !== lastPercentShown) {
                    lastPercentShown = percent;
                    onProgress(percent);
                  }

                  const res = biasedTrader(
                    prices,
                    startWallet,
                    sellThresh,
                    buyThresh,
                    lookback,
                    riskMult,
                    minHold,
                    conf,
                    hyst,
                    cooldown,
                    false
                  );

                  if (res.profit > bestProfit) {
                    bestProfit = res.profit;
                    bestResult = res;
                  }

                  if (count % 400 === 0) {
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                  }
                }
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
  walletSeries = []
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
      if (!isFinite(totalVal) || !isFinite(price) || START_WALLET === 0) {
        return null;
      }
      return (totalVal / START_WALLET) * price;
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
    sell_pct_thresh: result.sell_pct_thresh,
    buy_pct_thresh: result.buy_pct_thresh,
    max_lookback_days: result.max_lookback_days,
    risk_multiplier: result.risk_multiplier,
    min_hold_days: result.min_hold_days,
    confidence_strength: result.confidence_strength,
    hysteresis_pct: result.hysteresis_pct,
    cooldown_days: result.cooldown_days,
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

  try {
    // resolve symbol (name → symbol, or use raw if it already looks like a ticker)
    const resolved = await resolveSymbol(raw);
    const symbol = resolved.symbol.toUpperCase();
    input.value = symbol;

    setStatus(`Using symbol ${symbol}…`);
    setProgress(5, "Checking cached prices…");

    // load prices (from cache or API)
    const { dates, prices } = await getStockData(symbol);

    const savedAll = loadSaved();
    const saved = savedAll[symbol];
    let bestResult;

    // ---------- USE SAVED PARAMS (if any) ----------
    if (saved && !forceReoptimize) {
      setProgress(20, "Using cached simulations…");

      const sell = saved.sell_pct_thresh;
      const buy = saved.buy_pct_thresh;
      const lookback = saved.max_lookback_days || MAX_LOOKBACK_DAYS;

      const riskMult =
        saved.risk_multiplier != null && isFinite(saved.risk_multiplier)
          ? saved.risk_multiplier
          : 1.0;
      const minHold =
        saved.min_hold_days != null && isFinite(saved.min_hold_days)
          ? saved.min_hold_days
          : 0;

      const confStrength =
        saved.confidence_strength != null && isFinite(saved.confidence_strength)
          ? saved.confidence_strength
          : 0.5;
      const hysteresisPct =
        saved.hysteresis_pct != null && isFinite(saved.hysteresis_pct)
          ? saved.hysteresis_pct
          : 4.0;
      const cooldownDays =
        saved.cooldown_days != null && isFinite(saved.cooldown_days)
          ? Math.max(0, Math.floor(saved.cooldown_days))
          : 2;

      bestResult = biasedTrader(
        prices,
        START_WALLET,
        sell,
        buy,
        lookback,
        riskMult,
        minHold,
        confStrength,
        hysteresisPct,
        cooldownDays,
        false
      );

      // carry params onto the result object so the rest of the UI can read them
      bestResult.sell_pct_thresh = sell;
      bestResult.buy_pct_thresh = buy;
      bestResult.max_lookback_days = lookback;
      bestResult.risk_multiplier = riskMult;
      bestResult.min_hold_days = minHold;
      bestResult.confidence_strength = confStrength;
      bestResult.hysteresis_pct = hysteresisPct;
      bestResult.cooldown_days = cooldownDays;

      setProgress(100, "Using cached thresholds");
    } else {
      // ---------- FULL GRID SEARCH ----------
      setProgress(10, "Optimizing thresholds…");
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
    const {
      equityCurve,
      buyMarkers,
      sellMarkers,
      sharesHeld,
      walletSeries
    } = buildEquityData(
      prices,
      bestResult.sell_pct_thresh,
      bestResult.buy_pct_thresh,
      bestResult.max_lookback_days || MAX_LOOKBACK_DAYS,
      bestResult.risk_multiplier != null ? bestResult.risk_multiplier : 1.0,
      bestResult.min_hold_days != null ? bestResult.min_hold_days : 0,
      bestResult.confidence_strength != null ? bestResult.confidence_strength : 0.0,
      bestResult.hysteresis_pct != null ? bestResult.hysteresis_pct : 0.0,
      bestResult.cooldown_days != null ? bestResult.cooldown_days : 0
    );

    updateChart(
      symbol,
      dates,
      prices,
      equityCurve,
      buyMarkers,
      sellMarkers,
      sharesHeld,
      walletSeries
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
      decisionExtra.textContent = `Last action at $${actionPrice.toFixed(
        2
      )} | Last price $${bestResult.last_price.toFixed(2)}`;
    } else {
      decisionExtra.textContent = `$${bestResult.last_price.toFixed(2)}`;
    }

    // ---------- THRESHOLDS TEXT ----------
    thresholdsText.textContent = `Sell > ${bestResult.sell_pct_thresh.toFixed(
      1
    )}%, Buy drop > ${bestResult.buy_pct_thresh.toFixed(1)}%`;

    const confDisplay =
      bestResult.confidence_strength != null
        ? bestResult.confidence_strength.toFixed(2)
        : "0.00";
    const hystDisplay =
      bestResult.hysteresis_pct != null
        ? bestResult.hysteresis_pct.toFixed(1)
        : "0.0";
    const cooldownDisplay =
      bestResult.cooldown_days != null ? bestResult.cooldown_days : 0;

    thresholdsExtra.textContent =
      `Lookback: ${bestResult.max_lookback_days || MAX_LOOKBACK_DAYS}d · ` +
      `Risk x${
        (bestResult.risk_multiplier != null
          ? bestResult.risk_multiplier
          : 1
        ).toFixed(2)
      } · ` +
      `Min hold: ${bestResult.min_hold_days != null ? bestResult.min_hold_days : 0}d · ` +
      `Conf: ${confDisplay} · Hyst: ${hystDisplay}% · Cooldown: ${cooldownDisplay}d | ` +
      `Start wallet $${START_WALLET.toFixed(2)}`;

    // ---------- PROFIT TEXT ----------
    const profit = bestResult.profit;
    const finalValue = bestResult.final_value;
    const profitPct = (profit / START_WALLET) * 100;

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

    setStatus("Done");
  } catch (err) {
    console.error(err);
    setStatus(String(err), true);
    setProgress(0, "Idle");
  } finally {
    runButton.disabled = false;
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
  // If the X was clicked, delete that symbol
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

  // Otherwise, clicking the row runs the simulation
  const btn = e.target.closest(".saved-btn");
  if (!btn) return;
  const sym = btn.dataset.symbol;
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
