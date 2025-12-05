const START_WALLET = 4000.0;
const MAX_LOOKBACK_DAYS = 30;
const STORAGE_KEY = "biasTraderSavedV1";
const PRICE_CACHE_KEY = "biasTraderPriceV1";
const NAME_MAP_KEY = "biasTraderNameMapV1";

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
  nvidia: "NVDA",
  tesla: "TSLA",
  netflix: "NFLX",
  adobe: "ADBE",
  "adobe inc": "ADBE"
};

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

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (isError ? " error" : "");
}

function setProgress(percent, label) {
  const p = Math.max(0, Math.min(100, percent));
  progressBar.style.width = p + "%";
  progressText.textContent = label || `Progress: ${p}%`;
}

function clampMinMax(value, minVal, maxVal) {
  return Math.max(minVal, Math.min(value, maxVal));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeName(str) {
  return str.trim().toLowerCase().replace(/[.,]/g, "");
}

function isAfterDailyRefreshCutoff() {
  // 1:35pm local time (PST for you)
  const now = new Date();
  return now.getHours() >= 13.55;
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadPriceCache() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadNameMap() {
  try {
    const raw = localStorage.getItem(NAME_MAP_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveNameMapEntry(name, symbol) {
  const norm = normalizeName(name);
  const map = loadNameMap();
  map[norm] = symbol.toUpperCase();
  localStorage.setItem(NAME_MAP_KEY, JSON.stringify(map));
}

function getCachedPricesIfFresh(symbol) {
  const cache = loadPriceCache();
  const sym = symbol.toUpperCase();
  const entry = cache[sym];
  if (!entry) return null;

  const today = todayISO();
  if (entry.fetch_date !== today) {
    return null;
  }

  // Before 2pm: use today's cache.
  // After 2pm: only use cache if it was fetched after 2pm.
  if (!isAfterDailyRefreshCutoff()) {
    return { dates: entry.dates, prices: entry.prices };
  }

  if (entry.after_cutoff_fetch) {
    return { dates: entry.dates, prices: entry.prices };
  }

  // We want a fresh call after 2pm.
  return null;
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
  localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
}

function saveBestResult(symbol, result) {
  const sym = symbol.toUpperCase();
  const saved = loadSaved();
  const prev = saved[sym] || {};
  saved[sym] = {
    symbol: sym,
    sell_pct_thresh: result.sell_pct_thresh,
    buy_pct_thresh: result.buy_pct_thresh,
    profit: result.profit,
    final_value: result.final_value,
    last_price: result.last_price,
    last_updated: new Date().toISOString(),
    last_decision: result.last_decision,
    last_amount: result.last_amount,
    last_action_price: result.last_action_price,
    lookback_days: result.lookback_days || MAX_LOOKBACK_DAYS, // 🔹 NEW
    favorite: prev.favorite === true
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  renderSavedList();
}


function classifyItemForSort(item) {
  const decision = item.last_decision || "HOLD";
  const amount = item.last_amount || 0;
  const isAction = (decision === "BUY" || decision === "SELL") && amount > 0;
  const isStar = !!item.favorite;

  // 0: starred BUY/SELL
  // 1: BUY/SELL
  // 2: starred HOLD
  // 3: HOLD
  if (isStar && isAction) return 0;
  if (isAction && !isStar) return 1;
  if (isStar && !isAction) return 2;
  return 3;
}

function renderSavedList() {
  const saved = loadSaved();
  let symbols = Object.keys(saved);

  if (!symbols.length) {
    savedList.innerHTML =
      '<div class="saved-empty">No saved symbols yet. Run one to add it.</div>';
    return;
  }

  symbols.sort((a, b) => {
    const itemA = saved[a];
    const itemB = saved[b];

    const catA = classifyItemForSort(itemA);
    const catB = classifyItemForSort(itemB);
    if (catA !== catB) return catA - catB;

    // BUY/SELL groups (0 and 1): sort by last_amount desc
    if (catA === 0 || catA === 1) {
      const amtA = itemA.last_amount || 0;
      const amtB = itemB.last_amount || 0;
      if (amtA !== amtB) {
        return amtB - amtA; // bigger trades first
      }
      return a.localeCompare(b);
    }

    // HOLD groups (2 and 3): sort by profit desc
    if (catA === 2 || catA === 3) {
      const pA = itemA.profit || 0;
      const pB = itemB.profit || 0;
      if (pA !== pB) {
        return pB - pA; // more profit first
      }
      return a.localeCompare(b);
    }

    return a.localeCompare(b);
  });

  let html = "";
  for (const sym of symbols) {
    const item = saved[sym];
    const profitClass =
      item.profit >= 0 ? "saved-profit-positive" : "saved-profit-negative";
    const profitText =
      (item.profit >= 0 ? "+" : "") + item.profit.toFixed(2);

    const decision = item.last_decision || "HOLD";
    const amount = item.last_amount || 0;
    const actionPrice = item.last_action_price || 0.0;

    let decisionLabel = "HOLD";
    if ((decision === "BUY" || decision === "SELL") && amount > 0) {
      const priceStr =
        actionPrice > 0 ? ` @ $${actionPrice.toFixed(2)}` : "";
      decisionLabel = `${decision} ${amount}${priceStr}`;
    }

    const starOn = item.favorite === true;

    html += `
      <button type="button" class="saved-btn" data-symbol="${sym}">
        <div class="saved-btn-main">
          <div class="saved-left">
            <span class="saved-symbol">${sym}</span>
            <span class="saved-star ${starOn ? "saved-star-on" : ""}" data-symbol="${sym}" title="Toggle favorite">
              ${starOn ? "★" : "☆"}
            </span>
          </div>
          <div class="saved-right">
            <span class="${profitClass}">${profitText}</span>
            <span class="saved-delete" data-symbol="${sym}" title="Delete saved symbol">✕</span>
          </div>
        </div>
        <div class="saved-sub">
          ${decisionLabel}
        </div>
      </button>
    `;
  }
  savedList.innerHTML = html;
}

function getIdent() {
  const encoded = "QlQ4VVVBSklKMDlCMUlRRg==";
  return atob(encoded);
}

// Resolve freeform input (symbol or company name) to a stock symbol
async function resolveSymbol(inputStr) {
  const raw = inputStr.trim();
  if (!raw) throw new Error("Please enter a symbol or company name.");

  const upper = raw.toUpperCase();
  if (/^[A-Z.]{1,5}$/.test(upper) && !raw.includes(" ")) {
    return { symbol: upper, source: "direct" };
  }

  const norm = normalizeName(raw);
  const nameMap = loadNameMap();

  if (nameMap[norm]) {
    return { symbol: nameMap[norm], source: "cached-name" };
  }

  if (BUILTIN_NAME_MAP[norm]) {
    const sym = BUILTIN_NAME_MAP[norm];
    saveNameMapEntry(norm, sym);
    return { symbol: sym, source: "builtin-name" };
  }

  const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(
    raw
  )}&apikey=${encodeURIComponent(getIdent())}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!data || !data.bestMatches || !data.bestMatches.length) {
    console.log("SYMBOL_SEARCH response:", data);
    throw new Error("Could not find a matching stock symbol for that name.");
  }

  const best = data.bestMatches[0];
  const sym = (best["1. symbol"] || "").toUpperCase();
  if (!sym) {
    throw new Error("Could not parse symbol from search result.");
  }

  saveNameMapEntry(norm, sym);
  return { symbol: sym, source: "api-search" };
}

// Fetch stock data
async function fetchStockDataFromApi(symbol) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(
    symbol
  )}&outputsize=compact&apikey=${encodeURIComponent(getIdent())}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!data || !data["Time Series (Daily)"]) {
    console.log("AlphaVantage response:", data);
    if (data && (data["Note"] || data["Information"])) {
      throw new Error(data["Note"] || data["Information"]);
    }
    if (data && data["Error Message"]) {
      throw new Error("API error: " + data["Error Message"]);
    }
    throw new Error("Unexpected API response.");
  }

  const series = data["Time Series (Daily)"];
  const entries = Object.entries(series).map(([dateStr, daily]) => {
    const price = parseFloat(daily["4. close"]);
    return { dateStr, price };
  });

  entries.sort((a, b) => (a.dateStr < b.dateStr ? -1 : 1));

  const lastEntries = entries.slice(Math.max(0, entries.length - 260));
  const dates = lastEntries.map((e) => e.dateStr);
  const prices = lastEntries.map((e) => e.price);

  if (!prices.length) {
    throw new Error("No prices returned for symbol " + symbol);
  }

  return { dates, prices };
}

// High-level: get stock data, using per-day cache
async function getStockData(symbol) {
  const sym = symbol.toUpperCase();

  const cached = getCachedPricesIfFresh(sym);
  if (cached) {
    setStatus(`Using cached prices for ${sym} (fetched earlier).`);
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
  trackCurve = false
) {
  let wallet = startWallet;
  let shares = []; // [buyPrice, amount]
  let lastDecision = "HOLD";
  let lastAmount = 0;
  let lastActionPrice = 0.0;

  const equityCurve = trackCurve ? [] : null;

  // Initial point: total value at day 0
  if (trackCurve) {
    const price0 = prices[0];
    const totalShares0 = shares.reduce((acc, [, amt]) => acc + amt, 0);
    const totalVal0 = wallet + totalShares0 * price0;
    equityCurve.push(totalVal0);
  }

  for (let i = 1; i < prices.length; i++) {
    const price = prices[i];

    lastDecision = "HOLD";
    lastAmount = 0;
    lastActionPrice = 0.0;

    // SELL logic
    for (let idx = shares.length - 1; idx >= 0; idx--) {
      const [buyPrice, amount] = shares[idx];
      const profitPct =
        buyPrice !== 0 ? ((price - buyPrice) / buyPrice) * 100 : 0;

      if (buyPrice < price && profitPct > sellPctThresh) {
        wallet += amount * price;
        shares.splice(idx, 1);
        lastAmount += amount;
        lastActionPrice = price;
        lastDecision = "SELL";
      }
    }

    // BUY logic
    if (wallet > price) {
      let highestPercent = 0.0;
      const maxBack = clampMinMax(maxLookbackDays + 1, 1, i);

      for (let x = 1; x < maxBack; x++) {
        const prevPrice = prices[i - x];
        if (price < prevPrice) {
          const dropPct = ((price - prevPrice) / prevPrice) * 100;
          if (dropPct < highestPercent) {
            highestPercent = dropPct;
          }
        }
      }

      if (highestPercent < -buyPctThresh) {
        let amount = 0;
        for (let step = 1; step <= Math.floor(Math.abs(highestPercent)); step++) {
          if (wallet > price) {
            wallet -= price;
            amount += 1;
          }
        }

        if (amount > 0) {
          shares.push([price, amount]);
          lastAmount = amount;
          lastActionPrice = price;
          lastDecision = "BUY";
        }
      }
    }

    // Track total value (wallet + shares*price)
    if (trackCurve) {
      const totalShares = shares.reduce((acc, [, amt]) => acc + amt, 0);
      const totalVal = wallet + totalShares * price;
      equityCurve.push(totalVal);
    }
  }

  const finalPrice = prices[prices.length - 1];
  const totalShares = shares.reduce((acc, [, amt]) => acc + amt, 0);
  const finalValue = wallet + totalShares * finalPrice;
  const profit = finalValue - startWallet;

  return {
    final_wallet: wallet,
    final_shares: shares,
    final_value: finalValue,
    profit,
    sell_pct_thresh: sellPctThresh,
    buy_pct_thresh: buyPctThresh,
    last_decision: lastDecision,
    last_amount: lastAmount,
    last_action_price: lastActionPrice,
    last_price: finalPrice,
    equity_curve: equityCurve,
    // 🔹 NEW: remember which lookback was used
    lookback_days: maxLookbackDays
  };
}


async function gridSearchThresholdsWithProgress(prices, startWallet, onProgress) {
  const sellValues = [];
  const buyValues = [];
  for (let i = 1; i <= 200; i++) {
    const v = i / 10.0;
    sellValues.push(v);
    buyValues.push(v);
  }

  // 🔹 NEW: different lookback windows to try
  const lookbackValues = [5, 10, 20, 30, 60];

  const totalIters = sellValues.length * buyValues.length * lookbackValues.length;
  let count = 0;
  let lastPercentShown = -1;

  let bestProfit = -Infinity;
  let bestResult = null;

  for (let li = 0; li < lookbackValues.length; li++) {
    const lookback = lookbackValues[li];

    for (let si = 0; si < sellValues.length; si++) {
      const sellThresh = sellValues[si];

      for (let bi = 0; bi < buyValues.length; bi++) {
        const buyThresh = buyValues[bi];

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
          false
        );

        if (res.profit > bestProfit) {
          bestProfit = res.profit;
          bestResult = res; // res already carries lookback_days
        }

        if (count % 400 === 0) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
    }
  }

  if (onProgress) onProgress(100);
  return bestResult;
}


function updateChart(symbol, dates, prices, equityCurve) {
  if (priceChart) {
    priceChart.destroy();
  }

  const datasets = [
    {
      label: `${symbol.toUpperCase()} Close Price`,
      data: prices,
      borderWidth: 1.8,
      pointRadius: 0,
      borderColor: "rgba(59,130,246,1)",        // blue line for stock price
      backgroundColor: "rgba(59,130,246,0.12)", // soft blue fill
    }
  ];

  if (equityCurve && equityCurve.length === prices.length) {
    const p0 = prices[0];
    const e0 = equityCurve[0];

    let normEquity = equityCurve;
    if (e0 != null && !Number.isNaN(e0)) {
      // shift so that equityCurve[0] == prices[0]
      const offset = e0 - p0;
      normEquity = equityCurve.map(v => v - offset);
    }

    datasets.push({
      label: "Total value (wallet + shares, normalized)",
      data: normEquity,
      borderWidth: 1.8,
      pointRadius: 0,
      borderColor: "rgba(34,197,94,1)",         // green line
      backgroundColor: "rgba(34,197,94,0.12)",  // soft green fill
    });
  }

  priceChart = new Chart(chartCanvas.getContext("2d"), {
    type: "line",
    data: {
      labels: dates,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8
          }
        },
        y: {
          beginAtZero: false
        }
      },
      plugins: {
        legend: {
          labels: { color: "#e5e7eb" }
        }
      }
    }
  });
}



async function runForInput(inputValue, { forceReoptimize = false } = {}) {
  const raw = inputValue.trim();
  if (!raw) return;

  runButton.disabled = true;
  setStatus("Resolving symbol...");
  setProgress(0, "Resolving symbol...");
  decisionText.textContent = "–";
  decisionExtra.textContent = "";
  thresholdsText.textContent = "–";
  thresholdsExtra.textContent = "";
  profitText.textContent = "–";
  profitExtra.textContent = "";

  try {
    const { symbol, source } = await resolveSymbol(raw);
    input.value = symbol;
    let sourceLabel = "";
    if (source === "direct") sourceLabel = " (direct symbol)";
    else if (source === "builtin-name") sourceLabel = " (from built-in name)";
    else if (source === "cached-name") sourceLabel = " (cached name ↦ symbol)";
    else if (source === "api-search") sourceLabel = " (via name search)";

    setStatus(`Using symbol ${symbol}${sourceLabel}.`);
    setProgress(5, "Checking cached prices...");

    const { dates, prices } = await getStockData(symbol);

    const saved = loadSaved()[symbol.toUpperCase()];
    let bestResult;

    if (saved && !forceReoptimize) {
      setProgress(20, "Using cached thresholds...");
      const lookback = saved.lookback_days || MAX_LOOKBACK_DAYS;
      bestResult = biasedTrader(
        prices,
        START_WALLET,
        saved.sell_pct_thresh,
        saved.buy_pct_thresh,
        lookback,
        true
      );
      bestResult.sell_pct_thresh = saved.sell_pct_thresh;
      bestResult.buy_pct_thresh = saved.buy_pct_thresh;
      bestResult.lookback_days = lookback;
      setProgress(100, "Using cached thresholds");
    } else {
      setProgress(10, "Optimizing thresholds...");
      const gridBest = await gridSearchThresholdsWithProgress(
        prices,
        START_WALLET,
        (p) => setProgress(p, `Grid search: ${p}%`)
      );
      if (!gridBest) throw new Error("No result from grid search.");

      // Re-run once with curve tracking enabled for the best combo
      // Re-run once with curve tracking enabled for the best combo
      const bestLookback = gridBest.lookback_days || MAX_LOOKBACK_DAYS;
      bestResult = biasedTrader(
        prices,
        START_WALLET,
        gridBest.sell_pct_thresh,
        gridBest.buy_pct_thresh,
        bestLookback,
        true
      );
      bestResult.lookback_days = bestLookback;

    }

    if (!bestResult) throw new Error("No result from simulation.");

    // Update chart with both price and equity curve
    updateChart(symbol, dates, prices, bestResult.equity_curve);

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
      decisionExtra.textContent = `Last price $${bestResult.last_price.toFixed(2)}`;
    }

    thresholdsText.textContent = `Sell > ${bestResult.sell_pct_thresh.toFixed(
      1
    )}%, Buy drop > ${bestResult.buy_pct_thresh.toFixed(1)}%`;
    const usedLookback = bestResult.lookback_days || MAX_LOOKBACK_DAYS;
    thresholdsExtra.textContent = `Lookback up to ${usedLookback} days | Start wallet $${START_WALLET.toFixed(
      2
    )}`;


    const profit = bestResult.profit;
    const finalValue = bestResult.final_value;
    profitText.textContent =
      (profit >= 0 ? "+" : "") + profit.toFixed(2) + " USD";
    profitExtra.textContent = `Final value: $${finalValue.toFixed(
      2
    )} (wallet + holdings)`;

    saveBestResult(symbol, bestResult);

    setStatus(
      saved && !forceReoptimize
        ? "Done (cached thresholds, refreshed prices if needed)."
        : "Done."
    );
  } catch (err) {
    console.error(err);
    setStatus(String(err), true);
    setProgress(0, "Idle");
  } finally {
    runButton.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runForInput(input.value);
});

// Saved list clicks: run / star / delete
savedList.addEventListener("click", (e) => {
  const deleteEl = e.target.closest(".saved-delete");
  if (deleteEl) {
    e.stopPropagation();
    const sym = deleteEl.dataset.symbol;
    const saved = loadSaved();
    delete saved[sym];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    renderSavedList();
    return;
  }

  const starEl = e.target.closest(".saved-star");
  if (starEl) {
    e.stopPropagation();
    const sym = starEl.dataset.symbol;
    const saved = loadSaved();
    if (saved[sym]) {
      saved[sym].favorite = !saved[sym].favorite;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      renderSavedList();
    }
    return;
  }

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

renderSavedList();
input.focus();
