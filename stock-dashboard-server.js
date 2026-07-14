// stock-dashboard-server.js
// Data server for the Fundamentals Dashboard. It also serves the dashboard HTML.
//
// Data sources (all cloud-accessible, US-listed companies):
//   - Finnhub  (free tier, key in FINNHUB_API_KEY): quote, profile, current
//     metrics/ratios, peers, company news, analyst ratings.
//   - SEC EDGAR (no key): historical statements, Piotroski F-Score, and RPO.
// A browser can't call these directly (CORS/keys), so it calls THIS server.
//
// Run locally:  FINNHUB_API_KEY=... node stock-dashboard-server.js

import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 5233;

// ---- data sources -----------------------------------------------------------
// Current market data + metrics: Finnhub (free tier, ~60 calls/min). The key
// lives in the FINNHUB_API_KEY env var (set in Render) — never in this public
// repo. Historical statements, Piotroski F-Score, and RPO: SEC EDGAR (no key).
// Both cover US-listed companies.
const FINNHUB_KEY = (process.env.FINNHUB_API_KEY || "").trim();
const FINNHUB = "https://finnhub.io/api/v1";
// Sliding-window limiter: at most FH_MAX Finnhub calls per trailing 60s (under the
// 60/min free cap). A single dashboard view (~20 calls) passes straight through;
// the screener paces itself so no request gets 429'd.
const FH_TIMES = [];
const FH_MAX = 55, FH_WIN = 60000;
let fhInteractiveWaiting = 0;
function fhTake(bulk) {
  return new Promise((resolve) => {
    if (!bulk) fhInteractiveWaiting++;
    const tick = () => {
      const now = Date.now();
      while (FH_TIMES.length && FH_TIMES[0] <= now - FH_WIN) FH_TIMES.shift();
      // Interactive (single-view) calls take priority; the bulk screener yields
      // whenever a live lookup is waiting, so student lookups never starve.
      const allowed = FH_TIMES.length < FH_MAX && (!bulk || fhInteractiveWaiting === 0);
      if (allowed) {
        FH_TIMES.push(now);
        if (!bulk) fhInteractiveWaiting--;
        resolve();
      } else {
        setTimeout(tick, 200);
      }
    };
    tick();
  });
}
async function fh(q, bulk = false) {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_API_KEY not set");
  await fhTake(bulk);
  const sep = q.includes("?") ? "&" : "?";
  const r = await fetch(`${FINNHUB}${q}${sep}token=${FINNHUB_KEY}`);
  if (r.status === 429) throw new Error("Finnhub rate limit (429)");
  if (!r.ok) throw new Error(`Finnhub ${q.split("?")[0]} ${r.status}`);
  return r.json();
}

// SEC EDGAR requires a descriptive User-Agent. Set SEC_UA to your email for best compliance.
const SEC_UA = process.env.SEC_UA || "LakeDillon-StockDashboard/1.0 (contact: contact@lakedilloneyecare.com)";
let SEC_TICKERS = null; // cached { TICKER: cik10 }

const app = express();
app.use(cors()); // allow the local HTML file / any localhost origin to fetch
app.use(express.json()); // parse JSON bodies (used by POST /login)

// ---- shared login gate -----------------------------------------------------
// One shared password for all students. The password is NEVER stored in this
// (public) repo — it's read from the APP_PASSWORD env var (set in Render). If
// APP_PASSWORD is unset the gate is disabled, so local dev stays open.
const GATE_PASSWORD = (process.env.APP_PASSWORD || "").trim();
// Unforgeable cookie value derived from the password. A visitor can't produce
// it without knowing the password, so a stolen/guessed cookie isn't possible.
const AUTH_TOKEN = GATE_PASSWORD
  ? crypto.createHash("sha256").update("fund-gate:" + GATE_PASSWORD).digest("hex")
  : "";
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function isAuthed(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)auth=([^;]+)/);
  return !!m && safeEq(decodeURIComponent(m[1]), AUTH_TOKEN);
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fundamentals — Sign in</title>
<style>
  :root{--bg:#0E1418;--panel:#151C22;--line:#26323B;--ink:#E7EDF0;--muted:#8496A2;--accent:#6FB5D9}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);
    color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif}
  .card{width:min(360px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:30px 28px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .wm{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:600;font-size:15px;margin-bottom:4px}
  .wm b{color:var(--accent)}
  h1{font-size:15px;font-weight:500;color:var(--muted);margin:0 0 22px}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:7px}
  input{width:100%;padding:12px 13px;border-radius:9px;border:1px solid var(--line);background:#0E1418;
    color:var(--ink);font-size:15px;font-family:"IBM Plex Mono",ui-monospace,monospace;outline:none}
  input:focus{border-color:var(--accent)}
  button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:9px;background:var(--accent);
    color:#08121a;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}
  .err{color:#E08262;font-size:13px;margin-top:12px;min-height:16px}
</style></head><body>
  <form class="card" id="f">
    <div class="wm"><b>FUND</b>·AMENTALS</div>
    <h1>Enter the class password to continue</h1>
    <label for="p">Password</label>
    <input id="p" type="password" autocomplete="current-password" autofocus>
    <button type="submit">Enter</button>
    <div class="err" id="e"></div>
  </form>
  <script>
    var f=document.getElementById("f"),e=document.getElementById("e");
    f.addEventListener("submit",async function(ev){
      ev.preventDefault(); e.textContent="";
      try{
        var r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({password:document.getElementById("p").value})});
        if(r.ok){location.href="/";} else{e.textContent="Incorrect password. Try again.";}
      }catch(_){e.textContent="Something went wrong. Try again.";}
    });
  </script>
</body></html>`;

// Block everything until the visitor has the cookie. HTML page-loads get the
// login screen; data/asset requests get a 401.
app.use((req, res, next) => {
  if (!GATE_PASSWORD) return next();                               // gate disabled
  if (req.method === "POST" && req.path === "/login") return next(); // allow login attempt
  if (req.path === "/health") return next();                       // keep health open
  if (isAuthed(req)) return next();
  if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
    return res.status(200).type("html").send(LOGIN_PAGE);
  }
  return res.status(401).json({ error: "Login required." });
});

app.post("/login", (req, res) => {
  const pw = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (GATE_PASSWORD && safeEq(pw, GATE_PASSWORD)) {
    res.setHeader(
      "Set-Cookie",
      `auth=${AUTH_TOKEN}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax`
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Incorrect password." });
});

// serve the dashboard HTML + assets from this folder. index:false so "/" falls
// through to the route below (which serves stock-dashboard.html, not index.html).
app.use(express.static(APP_DIR, { index: false }));

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

// ---- news (Finnhub company-news) ----------------------------------------

async function getNews(symbol) {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400000);
    const day = (d) => d.toISOString().slice(0, 10);
    const items = await fh(`/company-news?symbol=${symbol}&from=${day(from)}&to=${day(to)}`);
    return (Array.isArray(items) ? items : [])
      .filter((n) => n && n.headline && n.url)
      .slice(0, 12)
      .map((n) => ({
        title: n.headline,
        publisher: n.source || null,
        link: n.url,
        publishedAt: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
        thumbnail: n.image || null,
        relatedTickers: n.related ? String(n.related).split(",").filter(Boolean) : [],
      }));
  } catch {
    return [];
  }
}

// ---- historical statements (SEC EDGAR companyfacts) ----------------------
// One companyfacts fetch per company feeds every "over time" chart, the
// share-count history, and the Piotroski F-Score. Cached (statements change
// only quarterly). US filers only.
const factsCache = new Map(); // cik10 -> { data, ts }
async function getCompanyFacts(symbol) {
  const map = await loadSecTickers();
  const cik = map[symbol.toUpperCase()];
  if (!cik) return null;
  const hit = factsCache.get(cik);
  if (hit && Date.now() - hit.ts < 6 * 60 * 60 * 1000) return hit.data;
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
    headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" },
  });
  if (!r.ok) throw new Error(`SEC facts ${r.status}`);
  const data = await r.json();
  factsCache.set(cik, { data, ts: Date.now() });
  // Bound memory: companyfacts JSON is large (multi-MB), so keep only a few.
  while (factsCache.size > 5) factsCache.delete(factsCache.keys().next().value);
  return data;
}

const _days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
// First present tag's fact array for a unit.
function tagUnits(gaap, tags, unit) {
  for (const t of tags) if (gaap[t] && gaap[t].units[unit]) return gaap[t].units[unit];
  return [];
}
// FLOW concept -> Map(end -> val): periods of a kind (annual ~365d | quarter ~90d),
// dedup by end-date (latest-filed wins).
function flowByEnd(gaap, tags, kind, unit = "USD") {
  const lo = kind === "annual" ? 350 : 80, hi = kind === "annual" ? 380 : 100;
  const m = new Map();
  for (const f of tagUnits(gaap, tags, unit)) {
    if (f.val == null || !f.start || !f.end) continue;
    const d = _days(f.start, f.end);
    if (d < lo || d > hi) continue;
    const prev = m.get(f.end);
    if (!prev || (f.filed || "") > prev.filed) m.set(f.end, { val: f.val, filed: f.filed || "" });
  }
  return new Map([...m].map(([e, o]) => [e, o.val]));
}
// INSTANT concept -> Map(end -> val): dedup by end-date (latest-filed wins).
function instantByEnd(gaap, tags, unit = "USD") {
  const m = new Map();
  for (const f of tagUnits(gaap, tags, unit)) {
    if (f.val == null || !f.end || f.start) continue; // instants have no start
    const prev = m.get(f.end);
    if (!prev || (f.filed || "") > prev.filed) m.set(f.end, { val: f.val, filed: f.filed || "" });
  }
  return new Map([...m].map(([e, o]) => [e, o.val]));
}

const SEC_TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  interestExpense: ["InterestExpense", "InterestExpenseNonoperating", "InterestAndDebtExpense"],
  pretax: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
  tax: ["IncomeTaxExpenseBenefit"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  ltDebtNon: ["LongTermDebtNoncurrent", "LongTermDebt"],
  ltDebtCur: ["LongTermDebtCurrent", "DebtCurrent"],
  sharesFlow: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfShareOutstandingBasicAndDiluted", "WeightedAverageNumberOfSharesOutstandingBasic"],
  sharesInstant: ["CommonStockSharesOutstanding"],
};

// Build a per-period series (kind = "annual" | "quarter") mirroring the old
// Yahoo timeSeries row shape so the charts, share history and F-Score work as-is.
function buildSecSeries(gaap, kind) {
  const rev = flowByEnd(gaap, SEC_TAGS.revenue, kind);
  const gp = flowByEnd(gaap, SEC_TAGS.grossProfit, kind);
  const oi = flowByEnd(gaap, SEC_TAGS.operatingIncome, kind);
  const ni = flowByEnd(gaap, SEC_TAGS.netIncome, kind);
  const iexp = flowByEnd(gaap, SEC_TAGS.interestExpense, kind);
  const pre = flowByEnd(gaap, SEC_TAGS.pretax, kind);
  const tax = flowByEnd(gaap, SEC_TAGS.tax, kind);
  const ocf = flowByEnd(gaap, SEC_TAGS.ocf, kind);
  const capex = flowByEnd(gaap, SEC_TAGS.capex, kind);
  const shFlow = flowByEnd(gaap, SEC_TAGS.sharesFlow, kind, "shares");
  const eq = instantByEnd(gaap, SEC_TAGS.equity);
  const assets = instantByEnd(gaap, SEC_TAGS.assets);
  const liab = instantByEnd(gaap, SEC_TAGS.liabilities);
  const ca = instantByEnd(gaap, SEC_TAGS.currentAssets);
  const cl = instantByEnd(gaap, SEC_TAGS.currentLiabilities);
  const ltdNon = instantByEnd(gaap, SEC_TAGS.ltDebtNon);
  const ltdCur = instantByEnd(gaap, SEC_TAGS.ltDebtCur);
  const shInst = instantByEnd(gaap, SEC_TAGS.sharesInstant, "shares");

  const at = (m, e) => (m.has(e) ? m.get(e) : null);
  let series = [...rev.keys()].sort().map((end) => {
    const revenue = at(rev, end);
    const grossProfit = at(gp, end), operatingIncome = at(oi, end), netIncome = at(ni, end);
    const ebit = operatingIncome;
    const interestExpense = at(iexp, end);
    const pretaxIncome = at(pre, end), taxProvision = at(tax, end);
    const equity = at(eq, end);
    const opCashFlow = at(ocf, end), cpx = at(capex, end);
    const freeCashFlow = opCashFlow != null && cpx != null ? opCashFlow - cpx : null;
    const dn = at(ltdNon, end), dc = at(ltdCur, end);
    const totalDebt = dn != null || dc != null ? (dn || 0) + (dc || 0) : null;
    const taxRate = pretaxIncome && taxProvision != null && pretaxIncome !== 0
      ? Math.min(Math.max(taxProvision / pretaxIncome, 0), 0.6) : 0.21;
    const nopat = ebit != null ? ebit * (1 - taxRate) : null;
    const investedCapital = equity != null || totalDebt != null ? (equity || 0) + (totalDebt || 0) : null;
    const dt = new Date(end);
    return {
      year: dt.getUTCFullYear(),
      label: kind === "quarter" ? `Q${Math.floor(dt.getUTCMonth() / 3) + 1} '${String(dt.getUTCFullYear()).slice(2)}` : undefined,
      end,
      revenue, grossProfit, operatingIncome, netIncome, ebit, interestExpense,
      grossMargin: safeDiv(grossProfit, revenue),
      operatingMargin: safeDiv(operatingIncome, revenue),
      netMargin: safeDiv(netIncome, revenue),
      interestCoverage: interestExpense && interestExpense !== 0 ? Math.abs(safeDiv(ebit, interestExpense)) : null,
      totalEquity: equity, totalLiabilities: at(liab, end), totalAssets: at(assets, end), totalDebt,
      debtToEquity: safeDiv(totalDebt, equity),
      returnOnEquity: safeDiv(netIncome, equity),
      operatingCashFlow: opCashFlow, capex: cpx, freeCashFlow,
      fcfMargin: safeDiv(freeCashFlow, revenue),
      roic: safeDiv(nopat, investedCapital),
      currentAssets: at(ca, end), currentLiabilities: at(cl, end),
      longTermDebt: at(ltdNon, end),
      shares: at(shFlow, end) ?? at(shInst, end),
    };
  });
  return kind === "quarter" ? series.slice(-8) : series.slice(-6);
}

async function getTimeSeries(symbol, type) {
  try {
    const facts = await getCompanyFacts(symbol);
    const gaap = facts && facts.facts && facts.facts["us-gaap"];
    if (!gaap) return [];
    return buildSecSeries(gaap, type === "annual" ? "annual" : "quarter");
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

// Fetch one us-gaap concept from SEC and return its USD facts as points sorted
// by period-end. Returns [] when the company doesn't report the concept (404).
async function secConceptPoints(cik, concept) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;
  const r = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`SEC concept ${concept} ${r.status}`);
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
  return [...groups.entries()]
    .map(([end, arr]) => { const f = pick(arr); return { end, val: f.val, fy: f.fy, fp: f.fp, form: f.form, label: j.label || null }; })
    .sort((a, b) => (a.end < b.end ? -1 : 1));
}

// Value of a points series at (or within ~45 days of) a target period-end.
function valAtEnd(points, endISO) {
  if (!points || !points.length) return null;
  const exact = points.find((p) => p.end === endISO);
  if (exact) return exact.val;
  let best = null, bd = Infinity;
  const t = new Date(endISO);
  for (const p of points) {
    const d = Math.abs(new Date(p.end) - t);
    if (d < bd) { bd = d; best = p; }
  }
  return best && bd < 45 * 86400000 ? best.val : null;
}

// RPO changes only quarterly, and each lookup makes several SEC requests — cache
// results so repeat/concurrent views don't hammer SEC (which rate-limits by IP).
const rpoCache = new Map(); // ticker -> { data, ts }
const RPO_TTL_MS = 6 * 60 * 60 * 1000;
async function getRpoCached(ticker) {
  const hit = rpoCache.get(ticker);
  if (hit && Date.now() - hit.ts < RPO_TTL_MS) return hit.data;
  const data = await getRpo(ticker);
  rpoCache.set(ticker, { data, ts: Date.now() }); // cache successes only (throws bypass this)
  return data;
}

// RPO is a point-in-time balance (an XBRL "instant"), reported in 10-K/10-Q notes
// under us-gaap:RevenueRemainingPerformanceObligation. We also split it into the
// deferred-revenue (already invoiced) portion and the unbilled backlog.
async function getRpo(ticker) {
  const map = await loadSecTickers();
  const cik = map[ticker];
  if (!cik) return { supported: false, disclosed: false };

  const all = await secConceptPoints(cik, "RevenueRemainingPerformanceObligation");
  if (!all.length) return { supported: true, disclosed: false, cik };

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

  // Split total RPO into: deferred revenue (already invoiced = a contract
  // liability on the balance sheet) and unbilled backlog (contracted but not
  // yet invoiced) = RPO − deferred. Try the modern ASC 606 tags first, then
  // fall back to the legacy DeferredRevenue tag.
  let deferred = null, unbilled = null;
  try {
    const [clTotal, clCur, clNon, drLegacy] = await Promise.all([
      secConceptPoints(cik, "ContractWithCustomerLiability").catch(() => []),
      secConceptPoints(cik, "ContractWithCustomerLiabilityCurrent").catch(() => []),
      secConceptPoints(cik, "ContractWithCustomerLiabilityNoncurrent").catch(() => []),
      secConceptPoints(cik, "DeferredRevenue").catch(() => []),
    ]);
    const end = latest.end;
    deferred = valAtEnd(clTotal, end);
    if (deferred == null) {
      const c = valAtEnd(clCur, end), n = valAtEnd(clNon, end);
      if (c != null || n != null) deferred = (c || 0) + (n || 0);
    }
    if (deferred == null) deferred = valAtEnd(drLegacy, end);
  } catch { deferred = null; }

  if (deferred != null && latest.val != null) {
    // Guard against a reporting mismatch where deferred exceeds total RPO.
    if (deferred <= latest.val * 1.02) unbilled = Math.max(latest.val - deferred, 0);
    else deferred = null;
  }

  return {
    supported: true,
    disclosed: true,
    cik,
    label: latest.label || null,
    latest: { end: latest.end, val: latest.val },
    priorYear: priorYear ? { end: priorYear.end, val: priorYear.val } : null,
    growthYoY,
    deferred,
    unbilled,
    annual,
  };
}

// ---- peer tickers (related symbols + batched quote) ----------------------

async function getPeers(symbol) {
  try {
    const cur = symbol.toUpperCase();
    const list = await fh(`/stock/peers?symbol=${symbol}`);
    let syms = [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).toUpperCase()))];
    if (!syms.includes(cur)) syms.unshift(cur);
    syms = syms.slice(0, 6); // current + up to 5 peers (keeps us well under the rate limit)
    const rows = await Promise.all(
      syms.map(async (s) => {
        try {
          const [q, mres, p] = await Promise.all([
            fh(`/quote?symbol=${s}`),
            fh(`/stock/metric?symbol=${s}&metric=all`),
            fh(`/stock/profile2?symbol=${s}`),
          ]);
          const M = (mres && mres.metric) || {};
          return {
            symbol: s,
            name: (p && p.name) || null,
            price: q && q.c ? num(q.c) : null,
            changePct: num(q && q.dp),
            marketCap: p && p.marketCapitalization != null ? p.marketCapitalization * 1e6 : null,
            trailingPE: num(M.peTTM),
            forwardPE: num(M.forwardPE),
            priceToBook: num(M.pbQuarterly) ?? num(M.pbAnnual) ?? num(M.pb),
            divYield: M.dividendYieldIndicatedAnnual != null ? M.dividendYieldIndicatedAnnual / 100 : null,
            isCurrent: s === cur,
          };
        } catch {
          return null;
        }
      })
    );
    return rows.filter(Boolean);
  } catch {
    return [];
  }
}

// ---- core fetch + normalize ------------------------------------------------

async function getFundamentals(symbol, opts = {}) {
  const lite = !!opts.lite; // screener mode: skip news/peers/RPO/quarterly for speed

  // SEC (statements/F-Score/RPO) + Finnhub (news/peers) — kicked off in parallel.
  const newsPromise = lite ? Promise.resolve([]) : getNews(symbol);
  const annualPromise = getTimeSeries(symbol, "annual"); // needed for score
  const quarterlyPromise = lite ? Promise.resolve([]) : getTimeSeries(symbol, "quarterly");
  const rpoPromise = lite ? Promise.resolve(null) : withTimeout(getRpoCached(symbol), 9000).catch(() => null);
  const peersPromise = lite ? Promise.resolve([]) : getPeers(symbol);

  // Current market data + metrics from Finnhub (parallel).
  const [quote, prof, metricRes, reco] = await Promise.all([
    lite ? Promise.resolve({}) : fh(`/quote?symbol=${symbol}`),   // price: not part of the score
    fh(`/stock/profile2?symbol=${symbol}`, lite),
    fh(`/stock/metric?symbol=${symbol}&metric=all`, lite),
    lite ? Promise.resolve([]) : fh(`/stock/recommendation?symbol=${symbol}`).catch(() => []),
  ]);
  const m = (metricRes && metricRes.metric) || {};
  const pctd = (v) => (v == null ? null : num(v) / 100); // Finnhub % -> decimal

  const price = quote && quote.c ? num(quote.c) : null;
  const marketCap = prof && prof.marketCapitalization != null ? prof.marketCapitalization * 1e6 : null;
  const sharesOut = prof && prof.shareOutstanding != null ? prof.shareOutstanding * 1e6 : null;
  const currency = (prof && prof.currency) || "USD";

  // Latest SEC annual period gives absolute $ figures Finnhub doesn't expose.
  const timeSeries = await annualPromise;
  const latest = timeSeries.length ? timeSeries[timeSeries.length - 1] : {};
  const ebitda = m.ebitdPerShareTTM != null && sharesOut != null ? num(m.ebitdPerShareTTM) * sharesOut : null;

  // Total cash (cash + short-term investments) from SEC at the latest period end.
  let totalCash = null;
  try {
    const facts = await getCompanyFacts(symbol);
    const gaap = facts && facts.facts && facts.facts["us-gaap"];
    if (gaap && latest.end) {
      const combined = instantByEnd(gaap, ["CashCashEquivalentsAndShortTermInvestments"]);
      if (combined.has(latest.end)) totalCash = combined.get(latest.end);
      else {
        const cash = instantByEnd(gaap, ["CashAndCashEquivalentsAtCarryingValue"]);
        const sti = instantByEnd(gaap, ["ShortTermInvestments"]);
        if (cash.has(latest.end)) totalCash = cash.get(latest.end) + (sti.has(latest.end) ? sti.get(latest.end) : 0);
      }
    }
  } catch {}

  const totalDebt = latest.totalDebt ?? null;
  const netDebt = totalDebt != null && totalCash != null ? totalDebt - totalCash : null;

  // Analyst rating from the buy/hold/sell trend (Finnhub price targets are premium).
  let analystRecommendation = null, numAnalysts = null;
  if (Array.isArray(reco) && reco.length) {
    const r0 = reco[0];
    const buy = (r0.strongBuy || 0) + (r0.buy || 0), hold = r0.hold || 0, sell = (r0.sell || 0) + (r0.strongSell || 0);
    numAnalysts = buy + hold + sell || null;
    analystRecommendation = buy >= hold && buy >= sell
      ? ((r0.strongBuy || 0) > (r0.buy || 0) ? "strong_buy" : "buy")
      : sell > buy && sell > hold ? "sell" : "hold";
  }

  // Finnhub free tier doesn't include next-earnings date or ex-dividend date.
  const events = { nextEarningsDate: null, nextEarningsDateEnd: null, earningsDateIsEstimate: false, epsEstimate: null, exDividendDate: null };
  const earnings = { period: null, quarter: null, epsActual: null, epsEstimate: null, surprisePercent: null, nextEpsEstimate: null, nextEarningsDate: null };

  const profile = {
    symbol: (prof && prof.ticker ? prof.ticker : symbol).toUpperCase(),
    name: (prof && prof.name) || null,
    exchange: (prof && prof.exchange) || null,
    currency,
    sector: (prof && prof.finnhubIndustry) || null,
    industry: (prof && prof.finnhubIndustry) || null,
    employees: null,
    summary: null,
    price,
    changePct: num(quote && quote.dp),
    marketCap,
    fiftyTwoWeekLow: num(m["52WeekLow"]),
    fiftyTwoWeekHigh: num(m["52WeekHigh"]),
    analystRecommendation,
    targetMeanPrice: null,
    numAnalysts,
  };

  const current = {
    profitability: {
      grossMargin: pctd(m.grossMarginTTM),
      operatingMargin: pctd(m.operatingMarginTTM),
      netMargin: pctd(m.netProfitMarginTTM),
      ebitdaMargin: ebitda != null && latest.revenue ? ebitda / latest.revenue : null,
      returnOnEquity: pctd(m.roeTTM),
      returnOnAssets: pctd(m.roaTTM),
    },
    growth: {
      revenueGrowthYoY: pctd(m.revenueGrowthTTMYoy),
      earningsGrowthYoY: pctd(m.epsGrowthTTMYoy),
      earningsQuarterlyGrowth: pctd(m.epsGrowthQuarterlyYoy),
    },
    cashFlow: {
      operatingCashFlow: latest.operatingCashFlow ?? null,
      freeCashFlow: latest.freeCashFlow ?? null,
      totalRevenue: latest.revenue ?? null,
      ebitda,
      totalCash,
      netIncomeToCommon: latest.netIncome ?? null,
    },
    balanceSheet: {
      totalDebt,
      // Finnhub gives D/E as a ratio; the UI expects Yahoo's percentage convention.
      debtToEquity: m["totalDebt/totalEquityQuarterly"] != null ? num(m["totalDebt/totalEquityQuarterly"]) * 100
        : m["totalDebt/totalEquityAnnual"] != null ? num(m["totalDebt/totalEquityAnnual"]) * 100 : null,
      currentRatio: num(m.currentRatioQuarterly) ?? num(m.currentRatioAnnual),
      quickRatio: num(m.quickRatioQuarterly) ?? num(m.quickRatioAnnual),
      bookValuePerShare: num(m.bookValuePerShareQuarterly) ?? num(m.bookValuePerShareAnnual),
      totalCash,
      netDebt,
      netDebtToEbitda: safeDiv(netDebt, ebitda),
    },
    valuation: {
      trailingPE: num(m.peTTM),
      forwardPE: num(m.forwardPE),
      pegRatio: num(m.pegTTM) ?? num(m.forwardPEG),
      priceToSales: num(m.psTTM),
      priceToBook: num(m.pbQuarterly) ?? num(m.pbAnnual) ?? num(m.pb),
      enterpriseToEbitda: num(m.evEbitdaTTM),
      enterpriseToRevenue: num(m.evRevenueTTM),
      enterpriseValue: m.enterpriseValue != null ? num(m.enterpriseValue) * 1e6 : null,
      trailingEps: num(m.epsTTM),
      forwardEps: null,
      fcfYield: latest.freeCashFlow != null && marketCap ? latest.freeCashFlow / marketCap : null,
    },
    capitalAllocation: {
      heldPercentInsiders: null,      // Finnhub ownership is premium
      heldPercentInstitutions: null,
      sharesOutstanding: sharesOut,
      beta: num(m.beta),
    },
    dividend: {
      dividendYield: pctd(m.dividendYieldIndicatedAnnual) ?? pctd(m.currentDividendYieldTTM),
      dividendRate: num(m.dividendPerShareTTM) ?? num(m.dividendPerShareAnnual),
      payoutRatio: pctd(m.payoutRatioTTM) ?? pctd(m.payoutRatioAnnual),
      fiveYearAvgDividendYield: null,
    },
  };

  const news = await newsPromise;
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
    res.status(502).json({ error: "Could not load market data. Try again." });
  }
});

// Historical price chart is disabled: no free cloud-accessible source remains
// (Finnhub candles are premium; Stooq now blocks server requests). Returns an
// empty series so the Risk Report's price trend just renders nothing.
app.get("/prices/:ticker", (_req, res) => {
  res.json({ prices: [], currency: "USD" });
});

// ---- Risk-Report score (server port of computeRisk() in the dashboard) ------
// Mirrors the exact 0-100 score shown on the page so the screener ranks by the
// same number. Keep the scM thresholds in sync with stock-dashboard.html.
const _scM = (v, lo, hi) =>
  v == null ? null : Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
const _avg = (arr) => {
  const s = arr.filter((x) => x != null);
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
};
const _lastVal = (ts, k) => { for (let i = ts.length - 1; i >= 0; i--) if (ts[i][k] != null) return ts[i][k]; return null; };
const _firstVal = (ts, k) => { for (let i = 0; i < ts.length; i++) if (ts[i][k] != null) return ts[i][k]; return null; };
function _cagr(ts, k) {
  const rows = ts.filter((r) => r[k] != null && r[k] > 0);
  if (rows.length < 2) return null;
  const yrs = rows[rows.length - 1].year - rows[0].year;
  if (yrs <= 0) return null;
  return Math.pow(rows[rows.length - 1][k] / rows[0][k], 1 / yrs) - 1;
}
function riskScore(d) {
  const c = d.current, ts = d.timeSeries || [], fs = d.fScore;
  const v = c.valuation, h = c.balanceSheet, pr = c.profitability, g = c.growth;
  const valuation = _avg([
    _scM(v.trailingPE, 45, 10), _scM(v.forwardPE, 40, 9), _scM(v.pegRatio, 3.5, 0.8),
    _scM(v.priceToSales, 12, 1), _scM(v.enterpriseToEbitda, 25, 6), _scM(v.fcfYield, 0, 0.08),
  ]);
  const ic = _lastVal(ts, "interestCoverage");
  const fcf = c.cashFlow.freeCashFlow, ni = c.cashFlow.netIncomeToCommon;
  const fq = fcf != null && ni != null && ni > 0 ? fcf / ni : null;
  const health = _avg([
    fs && fs.total != null ? _scM(fs.total, 0, 9) : null,
    _scM(h.netDebtToEbitda, 5, 0), _scM(h.currentRatio, 0.7, 2.5),
    _scM(ic, 1, 12), _scM(pr.netMargin, -0.05, 0.25), _scM(fq, 0, 1.2),
  ]);
  const nmF = _firstVal(ts, "netMargin"), nmL = _lastVal(ts, "netMargin");
  const nmDelta = nmF != null && nmL != null ? nmL - nmF : null;
  const growth = _avg([
    _scM(g.revenueGrowthYoY, -0.1, 0.25), _scM(g.earningsGrowthYoY, -0.2, 0.3),
    _scM(_cagr(ts, "revenue"), -0.05, 0.2), _scM(pr.operatingMargin, -0.05, 0.25),
    _scM(pr.returnOnEquity, -0.05, 0.25), _scM(nmDelta, -0.05, 0.05),
  ]);
  const parts = [[valuation, 35], [health, 35], [growth, 30]].filter((p) => p[0] != null);
  const wsum = parts.reduce((a, p) => a + p[1], 0);
  const overall = wsum ? Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum) : null;
  return { overall, valuation, health, growth };
}
function riskBadgeText(o) {
  if (o == null) return "NO SCORE";
  if (o >= 75) return "LOW RISK";
  if (o >= 60) return "MODERATE";
  if (o >= 45) return "ELEVATED";
  return "HIGH RISK";
}

// ---- screeners (Nasdaq 100 + S&P 100) --------------------------------------
// Editable ticker lists. Bad/renamed symbols just get skipped, so an
// out-of-date entry won't break the scan.
const NASDAQ_100 = [
  "AAPL","MSFT","AMZN","NVDA","GOOGL","GOOG","META","AVGO","TSLA","COST",
  "NFLX","TMUS","ASML","CSCO","ADBE","AMD","PEP","LIN","AZN","INTU",
  "TXN","ISRG","QCOM","BKNG","AMGN","HON","CMCSA","AMAT","PANW","ADP",
  "GILD","VRTX","MU","ADI","SBUX","MELI","REGN","LRCX","INTC","KLAC",
  "MDLZ","SNPS","CDNS","PYPL","CRWD","MAR","CTAS","ORLY","ABNB","CEG",
  "PDD","MRVL","FTNT","DASH","ADSK","WDAY","NXPI","ROP","CHTR","AEP",
  "PCAR","MNST","PAYX","CPRT","ROST","KDP","FANG","ODFL","BKR","EA",
  "VRSK","EXC","CSGP","XEL","CCEP","DDOG","IDXX","TTWO","GEHC","ON",
  "TEAM","GFS","DXCM","BIIB","WBD","MDB","ZS","TTD","ARM","LULU",
  "MRNA","APP","PLTR","MSTR","AXON","KHC","CDW","FAST","CTSH","TER",
];
const SP_100 = [
  "AAPL","ABBV","ABT","ACN","ADBE","AIG","AMD","AMGN","AMT","AMZN",
  "AVGO","AXP","BA","BAC","BK","BKNG","BLK","BMY","BRK-B","C",
  "CAT","CHTR","CL","CMCSA","COF","COP","COST","CRM","CSCO","CVS",
  "CVX","DE","DHR","DIS","DUK","EMR","F","FDX","GD","GE",
  "GILD","GM","GOOG","GOOGL","GS","HD","HON","IBM","INTC","INTU",
  "JNJ","JPM","KO","LIN","LLY","LMT","LOW","MA","MCD","MDLZ",
  "MDT","MET","META","MMM","MO","MRK","MS","MSFT","NEE","NFLX",
  "NKE","NVDA","ORCL","PEP","PFE","PG","PM","PYPL","QCOM","RTX",
  "SBUX","SCHW","SO","T","TGT","TMO","TMUS","TSLA","TXN","UNH",
  "UNP","UPS","USB","V","VZ","WFC","WMT","XOM",
];
const UNIVERSES = {
  nasdaq100: { label: "Nasdaq 100", tickers: NASDAQ_100 },
  sp100: { label: "S&P 100", tickers: SP_100 },
};

const SCREEN_TTL_MS = 6 * 60 * 60 * 1000; // reuse a completed scan for 6 hours
const SCREEN_CONCURRENCY = 5;             // parallel Yahoo pulls (gentle on rate limits)
// One independent cache/state per universe.
const screens = {};
for (const id of Object.keys(UNIVERSES)) {
  screens[id] = { status: "idle", done: 0, total: 0, results: [], computedAt: 0, error: null };
}

async function runScreen(uid) {
  const uni = UNIVERSES[uid];
  const st = screens[uid];
  if (!uni || st.status === "running") return;
  st.status = "running";
  st.done = 0;
  st.total = uni.tickers.length;
  st.error = null;
  const out = [];
  let i = 0;
  async function worker() {
    while (i < uni.tickers.length) {
      const sym = uni.tickers[i++];
      try {
        const d = await withTimeout(getFundamentals(sym, { lite: true }), 20000);
        const r = riskScore(d);
        if (r.overall != null) {
          out.push({
            symbol: sym,
            name: d.profile.name || sym,
            price: d.profile.price,
            score: r.overall,
            badge: riskBadgeText(r.overall),
            pe: d.current.valuation.trailingPE,
            revGrowth: d.current.growth.revenueGrowthYoY,
            fscore: d.fScore ? d.fScore.total : null,
          });
        }
      } catch {
        // skip individual failures — a partial screen is still useful
      }
      st.done++;
    }
  }
  await Promise.all(Array.from({ length: SCREEN_CONCURRENCY }, worker));
  out.sort((a, b) => b.score - a.score);
  st.results = out;      // only swap in the fresh list once the scan finishes
  st.computedAt = Date.now();
  st.status = "ready";
}

// Returns the cached screen instantly; kicks off a background scan when stale
// or when ?refresh=1 is passed. ?u=nasdaq100|sp100 picks the universe (default
// nasdaq100). The page polls this and shows a progress bar.
app.get("/screen", (req, res) => {
  const uid = UNIVERSES[req.query.u] ? req.query.u : "nasdaq100";
  const uni = UNIVERSES[uid];
  const st = screens[uid];
  const fresh = st.computedAt && Date.now() - st.computedAt < SCREEN_TTL_MS;
  const force = req.query.refresh === "1";
  if (st.status !== "running" && (force || !fresh)) {
    runScreen(uid).catch((e) => {
      st.error = String(e && e.message ? e.message : e);
      st.status = "ready";
    });
  }
  res.json({
    status: st.status,
    progress: { done: st.done, total: st.total },
    computedAt: st.computedAt || null,
    universe: uni.label,
    total: uni.tickers.length,
    count: st.results.length,
    results: st.results,
  });
});

// Serve the dashboard itself at the root so one deployment = one URL.
app.get("/", (_req, res) => res.sendFile(path.join(APP_DIR, "stock-dashboard.html")));

app.listen(PORT, () => {
  console.log(`\n  Fundamentals data server running`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  Login gate: ${GATE_PASSWORD ? "ON" : "OFF (set APP_PASSWORD to enable)"}`);
  console.log(`  Now open stock-dashboard.html in your browser.\n`);
});
