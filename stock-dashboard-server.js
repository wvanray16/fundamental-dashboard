// stock-dashboard-server.js
// Local data server for the Fundamentals Dashboard.
// Pulls fundamentals from Yahoo Finance (via yahoo-finance2 v3) and serves them
// to the dashboard HTML over localhost with CORS enabled.
//
// This exists because a browser cannot call Yahoo Finance directly (CORS +
// crumb auth). The dashboard calls THIS server instead.
//
// Setup (PowerShell, run once in the folder that holds this file):
//   npm init -y
//   npm pkg set type=module
//   npm install express cors yahoo-finance2
// Run:
//   node stock-dashboard-server.js
// Then open stock-dashboard.html in your browser.

import express from "express";
import cors from "cors";
import path from "path";
import YahooFinance from "yahoo-finance2";

const PORT = process.env.PORT || 5233;

// Pass-through logger that mutes only the (now-irrelevant) "financial statements
// submodules ... almost no data since Nov 2024" warning. We've already migrated
// all historical data to fundamentalsTimeSeries, so the notice is just noise.
const quietLogger = {
  info: (...a) => console.info(...a),
  warn: (...a) => {
    if (typeof a[0] === "string" && a[0].includes("financial statements submodules")) return;
    console.warn(...a);
  },
  error: (...a) => console.error(...a),
  debug: () => {},
  dir: (...a) => console.dir(...a),
};
const yf = new YahooFinance({ logger: quietLogger, suppressNotices: ["yahooSurvey"] });

// SEC EDGAR requires a descriptive User-Agent. Set SEC_UA to your email for best compliance.
const SEC_UA = process.env.SEC_UA || "LakeDillon-StockDashboard/1.0 (contact: contact@lakedilloneyecare.com)";
let SEC_TICKERS = null; // cached { TICKER: cik10 }

const app = express();
app.use(cors()); // allow the local HTML file / any localhost origin to fetch
// serve the dashboard HTML + assets from this folder. index:false so "/" falls
// through to the route below (which serves stock-dashboard.html, not index.html).
app.use(express.static(".", { index: false }));

// ---- helpers ---------------------------------------------------------------

// Yahoo values sometimes arrive as plain numbers, sometimes as { raw, fmt }.
// This flattens either shape to a number (or null).
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "raw" in v) {
    const r = v.raw;
    return typeof r === "number" && Number.isFinite(r) ? r : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function yearOf(endDate) {
  if (endDate == null) return null;
  let d;
  if (endDate instanceof Date) {
    d = endDate;
  } else if (typeof endDate === "object" && "raw" in endDate) {
    // Yahoo epoch is in seconds
    d = new Date(endDate.raw * 1000);
  } else if (typeof endDate === "number") {
    // seconds vs milliseconds
    d = new Date(endDate < 1e12 ? endDate * 1000 : endDate);
  } else {
    d = new Date(endDate);
  }
  return Number.isNaN(d.getTime()) ? null : d.getFullYear();
}

function safeDiv(a, b) {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

// Normalize any date-ish value to an ISO string (or null).
function isoDate(v) {
  if (v == null) return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "object" && "raw" in v) d = new Date(v.raw * 1000);
  else if (typeof v === "number") d = new Date(v < 1e12 ? v * 1000 : v);
  else d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- news --------------------------------------------------------------

async function getNews(symbol, name) {
  try {
    const r = await yf.search(
      symbol,
      { newsCount: 12, quotesCount: 0, enableNavLinks: false, enableFuzzyQuery: false },
      { validateResult: false }
    );
    return (r.news || [])
      .map((n) => {
        const res = (n.thumbnail && n.thumbnail.resolutions) || [];
        let thumb = null;
        if (res.length) {
          const sorted = [...res].sort((a, b) => (a.width || 0) - (b.width || 0));
          thumb = (sorted.find((t) => (t.width || 0) >= 140) || sorted[sorted.length - 1]).url;
        }
        return {
          title: n.title,
          publisher: n.publisher,
          link: n.link,
          publishedAt: isoDate(n.providerPublishTime),
          thumbnail: thumb,
          relatedTickers: n.relatedTickers || [],
        };
      })
      .filter((n) => n.title && n.link);
  } catch {
    return [];
  }
}

// ---- annual series (via fundamentalsTimeSeries) --------------------------
// One call feeds both the share-count chart and the Piotroski F-Score.

// One fundamentalsTimeSeries call builds a rich per-period series (annual or
// quarterly) that feeds every historical chart, the share-count chart, and the
// F-Score. Yahoo's quoteSummary statement-history submodules stopped returning
// data in late 2024, so this is now the sole source for historical statements.

async function getTimeSeries(symbol, type) {
  try {
    const yearsBack = type === "annual" ? 6 : 3;
    const period1 = `${new Date().getFullYear() - yearsBack}-01-01`;
    const rows = await yf.fundamentalsTimeSeries(
      symbol,
      { period1, type, module: "all" },
      { validateResult: false }
    );
    // The library strips the type prefix and lowercases the first letter in
    // returned rows (annualTotalRevenue -> totalRevenue), keeping all-caps keys
    // like EBIT as-is. Mirror that transformation to read the values.
    const g = (r, name) => {
      const key = name === name.toUpperCase() ? name : name[0].toLowerCase() + name.slice(1);
      return num(r[key]);
    };

    const byEnd = new Map();
    for (const r of rows || []) {
      const iso = isoDate(r.date);
      if (!iso) continue;
      const dt = new Date(iso);
      const revenue = g(r, "TotalRevenue");
      const grossProfit = g(r, "GrossProfit");
      const operatingIncome = g(r, "OperatingIncome");
      const netIncome = g(r, "NetIncome");
      const ebit = g(r, "EBIT") ?? operatingIncome;
      const interestExpense = g(r, "InterestExpense");
      const pretaxIncome = g(r, "PretaxIncome");
      const taxProvision = g(r, "TaxProvision");
      const equity = g(r, "StockholdersEquity");
      const totalAssets = g(r, "TotalAssets");
      const totalLiab = g(r, "TotalLiabilitiesNetMinorityInterest");
      const totalDebt = g(r, "TotalDebt");
      const opCashFlow = g(r, "OperatingCashFlow");
      const capex = g(r, "CapitalExpenditure");
      const freeCashFlow =
        g(r, "FreeCashFlow") ??
        (opCashFlow != null && capex != null ? opCashFlow + capex : null);
      const currentAssets = g(r, "CurrentAssets");
      const currentLiabilities = g(r, "CurrentLiabilities");
      const longTermDebt = g(r, "LongTermDebt");
      const shares =
        g(r, "DilutedAverageShares") ?? g(r, "BasicAverageShares") ??
        g(r, "OrdinarySharesNumber") ?? g(r, "ShareIssued");

      const taxRate =
        pretaxIncome && taxProvision != null && pretaxIncome !== 0
          ? Math.min(Math.max(taxProvision / pretaxIncome, 0), 0.6)
          : 0.21;
      const nopat = ebit != null ? ebit * (1 - taxRate) : null;
      const investedCapital =
        equity != null || totalDebt != null ? (equity || 0) + (totalDebt || 0) : null;

      byEnd.set(iso, {
        year: dt.getUTCFullYear(),
        label: type === "quarterly"
          ? `Q${Math.floor(dt.getUTCMonth() / 3) + 1} '${String(dt.getUTCFullYear()).slice(2)}`
          : undefined,
        end: iso,
        revenue, grossProfit, operatingIncome, netIncome, ebit, interestExpense,
        grossMargin: safeDiv(grossProfit, revenue),
        operatingMargin: safeDiv(operatingIncome, revenue),
        netMargin: safeDiv(netIncome, revenue),
        interestCoverage:
          interestExpense && interestExpense !== 0
            ? Math.abs(safeDiv(ebit, interestExpense))
            : null,
        totalEquity: equity, totalLiabilities: totalLiab, totalAssets, totalDebt,
        debtToEquity: safeDiv(totalDebt, equity),
        returnOnEquity: safeDiv(netIncome, equity),
        operatingCashFlow: opCashFlow, capex, freeCashFlow,
        fcfMargin: safeDiv(freeCashFlow, revenue),
        roic: safeDiv(nopat, investedCapital),
        currentAssets, currentLiabilities, longTermDebt, shares, // for F-Score
      });
    }
    let series = [...byEnd.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
    if (type === "quarterly") series = series.slice(-8); // last ~2 years of quarters
    return series;
  } catch {
    return [];
  }
}

// Piotroski F-Score: 9 binary fundamental signals, comparing the two most
// recent fiscal years. Signals with missing inputs score 0 but are flagged
// as not-evaluable so the UI can note data completeness.
function computeFScore(rows) {
  if (!rows || rows.length < 2) return null;
  const t = rows[rows.length - 1];
  const p = rows[rows.length - 2];

  const roa = (r) => safeDiv(r.netIncome, r.totalAssets);
  const cur = (r) => safeDiv(r.currentAssets, r.currentLiabilities);
  const lev = (r) => safeDiv(r.longTermDebt, r.totalAssets);
  const gm = (r) => safeDiv(r.grossProfit, r.revenue);
  const turn = (r) => safeDiv(r.revenue, r.totalAssets);
  const gt = (a, b) => (a == null || b == null ? null : a > b);
  const lt = (a, b) => (a == null || b == null ? null : a < b);

  const signals = [
    { group: "Profitability", label: "Positive net income",
      pass: t.netIncome == null ? null : t.netIncome > 0 },
    { group: "Profitability", label: "Positive operating cash flow",
      pass: t.operatingCashFlow == null ? null : t.operatingCashFlow > 0 },
    { group: "Profitability", label: "Return on assets rising",
      pass: gt(roa(t), roa(p)) },
    { group: "Profitability", label: "Cash flow exceeds net income",
      pass: gt(t.operatingCashFlow, t.netIncome) },
    { group: "Leverage & Liquidity", label: "Long-term leverage falling",
      pass: lt(lev(t), lev(p)) },
    { group: "Leverage & Liquidity", label: "Current ratio improving",
      pass: gt(cur(t), cur(p)) },
    { group: "Leverage & Liquidity", label: "No new shares issued",
      pass: t.shares == null || p.shares == null ? null : t.shares <= p.shares * 1.001 },
    { group: "Efficiency", label: "Gross margin expanding",
      pass: gt(gm(t), gm(p)) },
    { group: "Efficiency", label: "Asset turnover rising",
      pass: gt(turn(t), turn(p)) },
  ];

  return {
    total: signals.filter((s) => s.pass === true).length,
    evaluable: signals.filter((s) => s.pass !== null).length,
    signals,
    years: { current: t.year, prior: p.year },
  };
}

// ---- Remaining Performance Obligations (RPO) via SEC EDGAR ---------------

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

async function loadSecTickers() {
  if (SEC_TICKERS) return SEC_TICKERS;
  const r = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA },
  });
  if (!r.ok) throw new Error(`SEC ticker list ${r.status}`);
  const j = await r.json();
  const map = {};
  for (const k of Object.keys(j)) {
    const row = j[k];
    if (row && row.ticker) map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, "0");
  }
  SEC_TICKERS = map;
  return map;
}

// RPO is a point-in-time balance (an XBRL "instant"), reported in 10-K/10-Q notes
// under us-gaap:RevenueRemainingPerformanceObligation.
async function getRpo(ticker) {
  const map = await loadSecTickers();
  const cik = map[ticker];
  if (!cik) return { supported: false, disclosed: false };

  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/RevenueRemainingPerformanceObligation.json`;
  const r = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" } });
  if (r.status === 404) return { supported: true, disclosed: false, cik };
  if (!r.ok) throw new Error(`SEC concept ${r.status}`);
  const j = await r.json();
  const usd = (j.units && j.units.USD) || [];

  // Group facts by period-end. For each end date, prefer the latest-filed value,
  // and among ties take the largest (the consolidated total vs. any dimensional part).
  const groups = new Map();
  for (const f of usd) {
    if (f.val == null || !f.end) continue;
    if (!groups.has(f.end)) groups.set(f.end, []);
    groups.get(f.end).push(f);
  }
  const pick = (arr) => {
    const latestFiled = arr.reduce((m, x) => (x.filed && (!m || x.filed > m) ? x.filed : m), null);
    const cand = arr.filter((x) => x.filed === latestFiled);
    return cand.reduce((m, x) => (m == null || x.val > m.val ? x : m), null);
  };
  const all = [...groups.entries()]
    .map(([end, arr]) => { const f = pick(arr); return { end, val: f.val, fy: f.fy, fp: f.fp, form: f.form }; })
    .sort((a, b) => (a.end < b.end ? -1 : 1));

  if (all.length === 0) return { supported: true, disclosed: false, cik };

  // Annual-preferred series for the chart (fiscal year-end points), deduped by year.
  let annual = all.filter((p) => p.form === "10-K" || p.fp === "FY");
  if (annual.length < 2) annual = all.slice(-8);
  const byYear = new Map();
  annual.forEach((p) => byYear.set(new Date(p.end).getUTCFullYear(), p));
  annual = [...byYear.values()]
    .map((p) => ({ year: new Date(p.end).getUTCFullYear(), end: p.end, val: p.val }))
    .sort((a, b) => a.year - b.year);

  const latest = all[all.length - 1];

  // YoY: latest vs. the point closest to one year earlier (fair same-period compare).
  let growthYoY = null, priorYear = null;
  const target = new Date(latest.end);
  target.setUTCFullYear(target.getUTCFullYear() - 1);
  let best = null, bestDiff = Infinity;
  for (const p of all) {
    const diff = Math.abs(new Date(p.end) - target);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  if (best && bestDiff < 50 * 86400000 && best.val) {
    priorYear = best;
    growthYoY = (latest.val - best.val) / best.val;
  }

  return {
    supported: true,
    disclosed: true,
    cik,
    label: j.label || null,
    latest: { end: latest.end, val: latest.val },
    priorYear: priorYear ? { end: priorYear.end, val: priorYear.val } : null,
    growthYoY,
    annual,
  };
}

// ---- peer tickers (related symbols + batched quote) ----------------------

async function getPeers(symbol) {
  try {
    const rec = await yf.recommendationsBySymbol(symbol);
    const peerSyms = ((rec && rec.recommendedSymbols) || [])
      .map((x) => x.symbol)
      .filter(Boolean)
      .slice(0, 6);
    const all = [symbol.toUpperCase(), ...peerSyms.map((s) => s.toUpperCase())];
    // De-dupe while preserving order (current symbol first).
    const ordered = [...new Set(all)];
    const quotes = await yf.quote(ordered, {}, { validateResult: false });
    const arr = Array.isArray(quotes) ? quotes : [quotes];
    const bySym = new Map(arr.map((q) => [String(q.symbol).toUpperCase(), q]));
    return ordered
      .map((s) => {
        const q = bySym.get(s);
        if (!q) return null;
        const price = num(q.regularMarketPrice);
        const prevClose = num(q.regularMarketPreviousClose);
        const changePct =
          price != null && prevClose ? ((price - prevClose) / prevClose) * 100
            : num(q.regularMarketChangePercent);
        return {
          symbol: (q.symbol || s).toUpperCase(),
          name: q.shortName || q.longName || null,
          price,
          changePct,
          marketCap: num(q.marketCap),
          trailingPE: num(q.trailingPE),
          forwardPE: num(q.forwardPE),
          priceToBook: num(q.priceToBook),
          divYield: num(q.trailingAnnualDividendYield),
          isCurrent: s === symbol.toUpperCase(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---- core fetch + normalize ------------------------------------------------

async function getFundamentals(symbol) {
  const modules = [
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
    "financialData",
    "assetProfile",
    "earningsHistory",
    "calendarEvents",
    "majorHoldersBreakdown",
  ];

  // Kick off news in parallel so it doesn't add to the fundamentals latency.
  const newsPromise = getNews(symbol);
  const annualPromise = getTimeSeries(symbol, "annual");
  const quarterlyPromise = getTimeSeries(symbol, "quarterly");
  const rpoPromise = withTimeout(getRpo(symbol), 6000).catch(() => null);
  const peersPromise = getPeers(symbol);

  // validateResult:false keeps fields that aren't in the strict schema
  // (important — historical balance-sheet / cash-flow line items live there).
  const q = await yf.quoteSummary(
    symbol,
    { modules },
    { validateResult: false }
  );

  const price = q.price || {};
  const sd = q.summaryDetail || {};
  const ks = q.defaultKeyStatistics || {};
  const fd = q.financialData || {};
  const ap = q.assetProfile || {};
  const mh = q.majorHoldersBreakdown || {};
  const ce = q.calendarEvents || {};
  const ceEarn = ce.earnings || {};

  // earningsDate is an array: one confirmed date, or two dates (an estimated window).
  const earningsDates = (ceEarn.earningsDate || [])
    .map(isoDate)
    .filter(Boolean)
    .sort();
  const events = {
    nextEarningsDate: earningsDates[0] || null,
    nextEarningsDateEnd:
      earningsDates.length > 1 ? earningsDates[earningsDates.length - 1] : null,
    earningsDateIsEstimate: !!ceEarn.isEarningsDateEstimate,
    epsEstimate: num(ceEarn.earningsAverage),
    exDividendDate: isoDate(ce.exDividendDate),
  };

  // Latest reported quarter (actual vs estimate) for the report's earnings card.
  const ehist = q.earningsHistory?.history || [];
  const lastEh = ehist.length ? ehist[ehist.length - 1] : null;
  const earnings = {
    period: lastEh ? lastEh.period : null,
    quarter: lastEh ? isoDate(lastEh.quarter) : null,
    epsActual: lastEh ? num(lastEh.epsActual) : null,
    epsEstimate: lastEh ? num(lastEh.epsEstimate) : null,
    surprisePercent: lastEh ? num(lastEh.surprisePercent) : null,
    nextEpsEstimate: num(ceEarn.earningsAverage),
    nextEarningsDate: events.nextEarningsDate,
  };

  // ---- profile / header ----
  const profile = {
    symbol: (price.symbol || symbol).toUpperCase(),
    name: price.longName || price.shortName || symbol,
    exchange: price.exchangeName || price.exchange || null,
    currency: price.currency || fd.financialCurrency || "USD",
    sector: ap.sector || null,
    industry: ap.industry || null,
    employees: num(ap.fullTimeEmployees),
    summary: ap.longBusinessSummary || null,
    price: num(price.regularMarketPrice),
    changePct: num(price.regularMarketChangePercent),
    marketCap: num(price.marketCap) ?? num(sd.marketCap),
    fiftyTwoWeekLow: num(sd.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: num(sd.fiftyTwoWeekHigh),
    analystRecommendation: fd.recommendationKey || null,
    targetMeanPrice: num(fd.targetMeanPrice),
    numAnalysts: num(fd.numberOfAnalystOpinions),
  };

  // ---- derived cross-statement metrics ----
  const _totalDebt = num(fd.totalDebt);
  const _totalCash = num(fd.totalCash);
  const _ebitda = num(fd.ebitda);
  const _freeCashFlow = num(fd.freeCashflow);
  const _marketCap = num(price.marketCap) ?? num(sd.marketCap);
  const _netDebt =
    _totalDebt != null && _totalCash != null ? _totalDebt - _totalCash : null;

  // ---- current point-in-time metrics, grouped by category ----
  const current = {
    profitability: {
      grossMargin: num(fd.grossMargins),
      operatingMargin: num(fd.operatingMargins),
      netMargin: num(fd.profitMargins),
      ebitdaMargin: num(fd.ebitdaMargins),
      returnOnEquity: num(fd.returnOnEquity),
      returnOnAssets: num(fd.returnOnAssets),
    },
    growth: {
      revenueGrowthYoY: num(fd.revenueGrowth),
      earningsGrowthYoY: num(fd.earningsGrowth),
      earningsQuarterlyGrowth: num(ks.earningsQuarterlyGrowth),
    },
    cashFlow: {
      operatingCashFlow: num(fd.operatingCashflow),
      freeCashFlow: num(fd.freeCashflow),
      totalRevenue: num(fd.totalRevenue),
      ebitda: num(fd.ebitda),
      totalCash: num(fd.totalCash),
      netIncomeToCommon: num(ks.netIncomeToCommon),
    },
    balanceSheet: {
      totalDebt: num(fd.totalDebt),
      debtToEquity: num(fd.debtToEquity), // Yahoo reports this as a percentage
      currentRatio: num(fd.currentRatio),
      quickRatio: num(fd.quickRatio),
      bookValuePerShare: num(ks.bookValue),
      totalCash: _totalCash,
      netDebt: _netDebt,
      netDebtToEbitda: safeDiv(_netDebt, _ebitda),
    },
    valuation: {
      trailingPE: num(sd.trailingPE),
      forwardPE: num(sd.forwardPE) ?? num(ks.forwardPE),
      pegRatio: num(ks.pegRatio),
      priceToSales: num(sd.priceToSalesTrailing12Months),
      priceToBook: num(ks.priceToBook),
      enterpriseToEbitda: num(ks.enterpriseToEbitda),
      enterpriseToRevenue: num(ks.enterpriseToRevenue),
      enterpriseValue: num(ks.enterpriseValue),
      trailingEps: num(ks.trailingEps),
      forwardEps: num(ks.forwardEps),
      fcfYield: safeDiv(_freeCashFlow, _marketCap),
    },
    capitalAllocation: {
      heldPercentInsiders: num(ks.heldPercentInsiders) ?? num(mh.insidersPercentHeld),
      heldPercentInstitutions:
        num(ks.heldPercentInstitutions) ?? num(mh.institutionsPercentHeld),
      sharesOutstanding: num(ks.sharesOutstanding),
      beta: num(ks.beta) ?? num(sd.beta),
    },
    dividend: {
      dividendYield: num(sd.dividendYield),
      dividendRate: num(sd.dividendRate),
      payoutRatio: num(sd.payoutRatio),
      fiveYearAvgDividendYield: num(sd.fiveYearAvgDividendYield),
    },
  };

  // ---- historical time series (annual + quarterly) from fundamentalsTimeSeries ----
  const news = await newsPromise;
  const timeSeries = await annualPromise;
  const timeSeriesQuarterly = await quarterlyPromise;
  const rpo = await rpoPromise;
  const peers = await peersPromise;
  const shareHistory = timeSeries
    .filter((r) => r.shares != null)
    .map((r) => ({ year: r.year, shares: r.shares }));
  const fScore = computeFScore(timeSeries);
  return {
    profile,
    current,
    events,
    earnings,
    timeSeries,
    timeSeriesQuarterly,
    shareHistory,
    fScore,
    rpo,
    peers,
    news,
    fetchedAt: new Date().toISOString(),
  };
}

// ---- routes ----------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true, port: PORT }));

app.get("/fundamentals/:ticker", async (req, res) => {
  const ticker = String(req.params.ticker || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-^=]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: "Enter a valid ticker symbol." });
  }
  try {
    const data = await getFundamentals(ticker);
    if (!data.profile.name || data.profile.price == null) {
      return res
        .status(404)
        .json({ error: `No data found for "${ticker}". Check the symbol.` });
    }
    res.json(data);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/not found|No fundamentals|Quote not found/i.test(msg)) {
      return res
        .status(404)
        .json({ error: `No data found for "${ticker}". Check the symbol.` });
    }
    console.error(`[${ticker}]`, msg);
    res.status(502).json({ error: "Could not reach Yahoo Finance. Try again." });
  }
});

app.get("/prices/:ticker", async (req, res) => {
  const ticker = String(req.params.ticker || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-^=]{1,12}$/.test(ticker)) {
    return res.status(400).json({ error: "Enter a valid ticker symbol." });
  }
  try {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 1);
    const r = await yf.chart(ticker, { period1, interval: "1wk" });
    const prices = (r.quotes || [])
      .filter((qq) => qq && qq.date && qq.close != null)
      .map((qq) => ({ date: isoDate(qq.date), close: num(qq.close) }));
    res.json({ prices, currency: (r.meta && r.meta.currency) || "USD" });
  } catch (err) {
    console.error(`[prices ${ticker}]`, err && err.message ? err.message : err);
    res.status(502).json({ error: "Could not load price history." });
  }
});

// Serve the dashboard itself at the root so one deployment = one URL.
app.get("/", (_req, res) => res.sendFile(path.resolve("stock-dashboard.html")));

app.listen(PORT, () => {
  console.log(`\n  Fundamentals data server running`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  Now open stock-dashboard.html in your browser.\n`);
});
