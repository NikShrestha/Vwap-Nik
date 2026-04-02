const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)));

const app = express();
app.use(express.json());

// Serve the HTML file directly when someone visits the URL
app.get('/', (req, res) => {
    try {
        const htmlContent = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        res.send(htmlContent);
    } catch (err) {
        res.status(500).send("Error loading simulator UI.");
    }
});

const PORT = process.env.PORT || 8080;
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const STATE_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'bot_state.json') : 'bot_state.json';

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────
let BOT = {
  balance: 100,
  startBalance: 100,
  targetBalance: 200,
  running: false,
  trades: [],       // closed trades
  activeTrades: [], // open positions
  gainers: [],
  selectedCoin: null,
  maxPositions: 2,
  riskPct: 0.02,
  tpMultiplier: 3,
  maxDrawdownPct: 0.30,
  minGain: 10,      // Track coins that pump >10%
  showGain: 5,      // Show in UI if >5%
  leverage: 20,
  qualifiedCoins: [],
  trackingData: {},
  resets: 0,
  highestBalance: 100,
  maxDrawdownAmt: 0,
  logs: []
};

function saveState() {
  try {
    const state = {
      balance: BOT.balance,
      startBalance: BOT.startBalance,
      trades: BOT.trades,
      activeTrades: BOT.activeTrades,
      qualifiedCoins: BOT.qualifiedCoins,
      resets: BOT.resets,
      highestBalance: BOT.highestBalance,
      maxDrawdownAmt: BOT.maxDrawdownAmt
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save state:", e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved.balance !== undefined) BOT.balance = saved.balance;
      if (saved.startBalance !== undefined) BOT.startBalance = saved.startBalance;
      if (saved.trades) {
        BOT.trades = saved.trades.map(t => ({
          ...t,
          openTime: t.openTime ? new Date(t.openTime) : new Date(),
          closeTime: t.closeTime ? new Date(t.closeTime) : new Date()
        }));
      }
      if (saved.activeTrades) {
        BOT.activeTrades = saved.activeTrades.map(t => ({
          ...t,
          openTime: t.openTime ? new Date(t.openTime) : new Date()
        }));
      }
      if (saved.qualifiedCoins) BOT.qualifiedCoins = saved.qualifiedCoins;
      if (saved.resets !== undefined) BOT.resets = saved.resets;
      if (saved.highestBalance !== undefined) BOT.highestBalance = saved.highestBalance;
      if (saved.maxDrawdownAmt !== undefined) BOT.maxDrawdownAmt = saved.maxDrawdownAmt;
    }
  } catch (e) { 
    console.error('Error loading bot state', e.message); 
  }
}

// ─── LOGGING & TELEGRAM ──────────────────────────────────────────────────────
function addLog(msg, type = '') {
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${timeStr}] ${msg}`);
  BOT.logs.unshift({ time: timeStr, msg, type });
  if (BOT.logs.length > 100) BOT.logs.pop();
}

function fmt(n, d = 4) { return (+n).toFixed(d); }
function fmtP(n) { return (n >= 0 ? '+' : '') + (+n).toFixed(2); }

async function sendTelegramMessage(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
    if (!res.ok) console.error(`Telegram API error: ${res.status}`);
  } catch (e) {
    console.error("Telegram network error:", e.message);
  }
}

function sendPeriodicReport() {
  const wins = BOT.trades.filter(t => t.result === 'WIN').length;
  const total = BOT.trades.length;
  const wr = total > 0 ? (wins / total * 100).toFixed(1) : 0;
  const roi = ((BOT.balance - BOT.startBalance) / BOT.startBalance * 100).toFixed(2);
  
  const msg = `📊 <b>VWAP BOT STATUS REPORT</b> 📊\n\n` +
              `💰 <b>Balance:</b> $${(+BOT.balance).toFixed(2)}\n` +
              `📈 <b>ROI:</b> ${roi >= 0 ? '+'+roi : roi}%\n` +
              `🏆 <b>Win Rate:</b> ${wr}% (${wins}/${total})\n` +
              `⚡ <b>Active Positions:</b> ${BOT.activeTrades.length}\n` +
              `⚠️ <b>Account Resets:</b> ${BOT.resets || 0}`;
  sendTelegramMessage(msg);
}

// ─── BINANCE API WRAPPER (ROBUST) ────────────────────────────────────────────
const BINANCE = 'https://fapi.binance.com/fapi/v1';
let validSymbols = new Set();

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function fetchValidSymbols() {
  try {
    const data = await fetchWithTimeout(`${BINANCE}/exchangeInfo`, 10000);
    if (data && data.symbols) {
      const valid = data.symbols
        .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
        .map(s => s.symbol);
      validSymbols = new Set(valid);
    }
  } catch (e) {
    console.error("ExchangeInfo fetch failed:", e.message);
  }
}

async function fetchTicker() {
  if (validSymbols.size === 0) await fetchValidSymbols();
  try {
    const data = await fetchWithTimeout(`${BINANCE}/ticker/24hr`);
    if (!Array.isArray(data)) return [];
    return data.filter(t => validSymbols.has(t.symbol));
  } catch (err) {
    return [];
  }
}

async function fetchKlines(symbol, interval = '5m', limit = 150) {
  try {
    return await fetchWithTimeout(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  } catch (e) {
    return [];
  }
}

// ─── INDICATORS & MATH ───────────────────────────────────────────────────────
function calcVWAP(klines) {
  let tpv = 0, vol = 0;
  return klines.map(k => {
    const h = +k[2], l = +k[3], c = +k[4], v = +k[5];
    const tp = (h + l + c) / 3;
    tpv += tp * v;
    vol += v;
    return tpv / vol;
  });
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiArr = [];
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr.push(100 - 100 / (1 + rs));
  }
  return rsiArr;
}

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trArr = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2], l = +klines[i][3], pc = +klines[i-1][4];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trArr.push(tr);
  }
  let atr = trArr.slice(0, period).reduce((a, b) => a + b) / period;
  const atrArr = [atr];
  for (let i = period; i < trArr.length; i++) {
    atr = (atr * (period - 1) + trArr[i]) / period;
    atrArr.push(atr);
  }
  return atrArr;
}

function calcFib(high, low) {
  const d = high - low;
  return [
    { level: '0.0 (High)', pct: 0, price: high },
    { level: '0.236', pct: 0.236, price: high - d * 0.236 },
    { level: '0.382', pct: 0.382, price: high - d * 0.382 },
    { level: '0.500', pct: 0.500, price: high - d * 0.500 },
    { level: '0.618 ★', pct: 0.618, price: high - d * 0.618 },
    { level: '0.786', pct: 0.786, price: high - d * 0.786 },
    { level: '1.0 (Low)', pct: 1, price: low },
  ];
}

// ─── ADVANCED TRADING ENGINE ─────────────────────────────────────────────────
async function analyzeSymbol(symbol) {
  try {
    const klines = await fetchKlines(symbol, '5m', 200);
    if (!klines || klines.length < 50) return null;

    const closes = klines.map(k => +k[4]);
    const highs = klines.map(k => +k[2]);
    const lows = klines.map(k => +k[3]);
    const vols = klines.map(k => +k[5]);

    const vwap = calcVWAP(klines);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(klines);
    
    const rsi = rsiArr ? rsiArr[rsiArr.length - 1] : null;
    const atr = atrArr ? atrArr[atrArr.length - 1] : 0;
    
    const currentPrice = closes[closes.length - 1];
    const currentVWAP = vwap[vwap.length - 1];
    
    // Recent 12 hours (144 candles)
    const recentHigh = Math.max(...highs.slice(-144));
    const recentLow = Math.min(...lows.slice(-144));
    
    // Flat Base Detection (Consolidation near highs)
    let hasFlatBase = false;
    let baseMaxVal = null;
    
    // Look backwards to find the peak, then analyze candles before the peak
    const peakIndex = highs.lastIndexOf(recentHigh);
    let baseEnd = peakIndex - 1;
    let pumpDuration = 0;
    
    while (baseEnd >= 12) {
      const windowHighs = highs.slice(baseEnd - 12, baseEnd + 1);
      const windowLows = lows.slice(baseEnd - 12, baseEnd + 1);
      const wMax = Math.max(...windowHighs);
      const wMin = Math.min(...windowLows);
      const fluctuation = (wMax - wMin) / wMin;
      
      // Tight consolidation (max 12% fluctuation) before a massive pump (>20%)
      if (fluctuation <= 0.12) {
        if (recentHigh >= wMax * 1.20) {
          hasFlatBase = true;
          baseMaxVal = wMax;
          pumpDuration = peakIndex - baseEnd;
          break;
        }
      }
      baseEnd--;
    }

    // Advanced VWAP Crossunder check (must be a decisive break with volume)
    const n = klines.length;
    const prevClose = +klines[n - 2][4];
    const currClose = +klines[n - 1][4];
    const prevVWAP = vwap[n - 2];
    const currVWAP = vwap[n - 1];
    
    const prevVol = +klines[n - 2][5];
    const currVol = +klines[n - 1][5];
    const avgVol = vols.slice(-20, -2).reduce((a, b) => a + b, 0) / 18; // Avg vol of previous 18 candles
    
    const isVWAPCrossunder = (prevClose > prevVWAP) && (currClose < currVWAP);
    // NEW: Volume Confirmation - The breakdown candle must have above-average volume
    const volumeConfirmation = currVol > avgVol * 1.2; 
    
    let hasRoomToFall = false;
    if (hasFlatBase && currentPrice > baseMaxVal) {
      const dropPct = (currentPrice - baseMaxVal) / currentPrice;
      if (dropPct * BOT.leverage * 100 >= 30) {
        hasRoomToFall = true;
      }
    }

    const fullSignal = isVWAPCrossunder && hasFlatBase && hasRoomToFall && volumeConfirmation;
    const partialSignal = isVWAPCrossunder;

    return {
      symbol, currentPrice, currentVWAP, rsi, atr,
      vwapCrossunder: isVWAPCrossunder, hasFlatBase, hasRoomToFall, baseMaxVal,
      volumeConfirmation, fullSignal, partialSignal,
      fibLevels: calcFib(recentHigh, recentLow),
      recentHigh, recentLow
    };
  } catch (e) {
    return null;
  }
}

// ─── POSITION MANAGEMENT ─────────────────────────────────────────────────────
function openTrade(analysis) {
  const { symbol, currentPrice, currentVWAP, rsi, atr, fibLevels, fullSignal, baseMaxVal } = analysis;
  
  // Dynamic compounding margin size based on current balance
  const margin = +(BOT.balance * BOT.riskPct).toFixed(4);
  const notional = margin * BOT.leverage;
  
  // NEW: ATR-based Dynamic Take Profit & Stop Loss
  // If ATR is high, use wider targets. If low, tighter targets.
  const atrPct = atr / currentPrice;
  const tpPricePct = Math.max(BOT.tpMultiplier / BOT.leverage, atrPct * 3); // Aim for 3x ATR or fixed TP
  let tpPrice = +(currentPrice * (1 - tpPricePct)).toFixed(8);
  
  // Cap Take Profit at the Flat Base support level if it exists
  if (baseMaxVal) tpPrice = +(Math.max(tpPrice, baseMaxVal)).toFixed(8);
  
  const allowedLoss = BOT.balance * BOT.maxDrawdownPct;
  const slPricePct = allowedLoss / notional;
  const slPrice = +(currentPrice * (1 + slPricePct)).toFixed(8);
  
  const tpProfit = +(((currentPrice - tpPrice) / currentPrice) * notional).toFixed(4);
  const slLoss = -allowedLoss;

  const trade = {
    id: Date.now(),
    symbol, entryPrice: currentPrice, vwapAtEntry: currentVWAP, rsiAtEntry: rsi, atrAtEntry: atr,
    margin, notional, tpPrice, slPrice, originalSlPrice: slPrice,
    tpProfit, slLoss,
    side: 'SHORT', leverage: BOT.leverage,
    openTime: new Date(),
    signalType: fullSignal ? 'FULL SIGNAL (VOL CONFIRMED)' : 'VWAP CROSS',
    fibLevels,
    unrealizedPnl: 0,
    highestPriceSinceEntry: currentPrice,
    lowestPriceSinceEntry: currentPrice,
    trailingActive: false,
    entryConditions: { hasFlatBase: analysis.hasFlatBase, hasRoomToFall: analysis.hasRoomToFall }
  };

  BOT.activeTrades.push(trade);
  BOT.balance = +(BOT.balance - margin).toFixed(4);

  addLog(`🟢 OPENED SHORT ${symbol} @ $${fmt(currentPrice)} | Margin $${fmt(margin)} | TP $${fmt(tpPrice)} | SL $${fmt(slPrice)}`, 'green');
  sendTelegramMessage(`🟢 <b>OPENED SHORT ${symbol}</b>\n<b>Entry:</b> $${fmt(currentPrice)}\n<b>Margin:</b> $${fmt(margin)}\n<b>TP:</b> $${fmt(tpPrice)}\n<b>SL:</b> $${fmt(slPrice)}`);
  
  sendPeriodicReport();
  saveState();
}

async function checkActiveTrades() {
  for (let i = BOT.activeTrades.length - 1; i >= 0; i--) {
    const t = BOT.activeTrades[i];
    try {
      // Faster lightweight fetch just for price
      const r = await fetchWithTimeout(`${BINANCE}/ticker/price?symbol=${t.symbol}`, 3000);
      if (!r || !r.price) continue;
      const price = +r.price;
      
      t.currentPrice = price;
      if (price < t.lowestPriceSinceEntry) t.lowestPriceSinceEntry = price;
      if (price > t.highestPriceSinceEntry) t.highestPriceSinceEntry = price;

      const rawPnl = (t.entryPrice - price) / t.entryPrice * t.notional;
      t.unrealizedPnl = +rawPnl.toFixed(4);

      // NEW: Dynamic Trailing Stop Loss
      // If we are significantly in profit, move SL to breakeven, then trail it
      const roiPct = t.unrealizedPnl / t.margin * 100; // ROI relative to margin
      if (roiPct > 50 && !t.trailingActive) {
        // Move to breakeven + slight profit to cover fees
        t.slPrice = +(t.entryPrice * 0.999).toFixed(8);
        t.trailingActive = true;
        addLog(`🛡️ SL moved to breakeven for ${t.symbol} (ROI: ${fmt(roiPct, 1)}%)`, 'blue');
      }
      if (t.trailingActive && roiPct > 100) {
        // Trail SL 1.5% away from the lowest price reached
        const trailPrice = +(t.lowestPriceSinceEntry * 1.015).toFixed(8);
        if (trailPrice < t.slPrice) {
          t.slPrice = trailPrice;
        }
      }

      let closed = false;
      let pnl = 0;
      let result = '';

      if (price <= t.tpPrice) {
        pnl = t.tpProfit;
        result = 'WIN';
        closed = true;
        addLog(`✅ TP HIT ${t.symbol} @ $${fmt(price)} | +$${fmt(pnl, 2)}`, 'green');
        sendTelegramMessage(`✅ <b>TP HIT ${t.symbol}</b>\n<b>Exit:</b> $${fmt(price)}\n<b>Profit:</b> +$${fmt(pnl, 2)}\n<b>ROI:</b> +${fmt(pnl / t.margin * 100, 2)}%`);
      } else if (price >= t.slPrice) {
        pnl = +(((t.entryPrice - price) / t.entryPrice) * t.notional).toFixed(4);
        result = pnl >= 0 ? 'WIN (TRAIL)' : 'LOSS';
        closed = true;
        const emoji = pnl >= 0 ? '✅' : '❌';
        const color = pnl >= 0 ? 'green' : 'red';
        addLog(`${emoji} SL HIT ${t.symbol} @ $${fmt(price)} | ${fmtP(pnl)}`, color);
        sendTelegramMessage(`${emoji} <b>SL HIT ${t.symbol}</b>\n<b>Exit:</b> $${fmt(price)}\n<b>P&L:</b> ${fmtP(pnl)}\n<b>ROI:</b> ${fmt(pnl / t.margin * 100, 2)}%`);
      }

      // Time-based exit (Close position if it stagnates for 24 hours)
      const durationMin = Math.round((Date.now() - new Date(t.openTime).getTime()) / 1000 / 60);
      if (!closed && durationMin > 1440) {
         pnl = t.unrealizedPnl;
         result = pnl >= 0 ? 'WIN (TIMEOUT)' : 'LOSS (TIMEOUT)';
         closed = true;
         addLog(`⏱️ 24H TIMEOUT ${t.symbol} @ $${fmt(price)} | ${fmtP(pnl)}`, pnl >= 0 ? 'green' : 'red');
         sendTelegramMessage(`⏱️ <b>TIMEOUT CLOSE ${t.symbol}</b>\n<b>Exit:</b> $${fmt(price)}\n<b>P&L:</b> ${fmtP(pnl)}\n<b>Duration:</b> ${durationMin}m`);
      }

      if (closed) {
        const closed_trade = {
          ...t, exitPrice: price, closeTime: new Date(), pnl, result, durationMin,
          roiPct: +(pnl / t.margin * 100).toFixed(2), balancePct: +(pnl / BOT.startBalance * 100).toFixed(2),
          analysisText: t.trailingActive ? "[TRAILED SL TRIGGERED]" : "[STANDARD CLOSE]"
        };
        BOT.trades.push(closed_trade);
        BOT.activeTrades.splice(i, 1);
        BOT.balance = +(BOT.balance + t.margin + pnl).toFixed(4);
        
        if (BOT.balance > BOT.highestBalance) {
            BOT.highestBalance = BOT.balance;
            BOT.maxDrawdownAmt = 0;
        } else {
            const currentDrawdown = BOT.highestBalance - BOT.balance;
            if (currentDrawdown > BOT.maxDrawdownAmt) BOT.maxDrawdownAmt = currentDrawdown;
        }
        
        if (BOT.balance < 2) {
          addLog(`💀 ACCOUNT BLOWN ($${fmt(BOT.balance)}). Auto-recovering...`, 'red');
          sendTelegramMessage(`🔄 <b>ACCOUNT BLOWN & RESET</b>\nBalance dropped to $${fmt(BOT.balance)}.\nBot is automatically restarting with $100.00!`);
          BOT.balance = 100; BOT.startBalance = 100; BOT.highestBalance = 100; BOT.maxDrawdownAmt = 0; BOT.resets++;
        }
        
        saveState();
        sendPeriodicReport();
      }
    } catch (e) { /* skip this cycle */ }
  }
}

// ─── MARKET SCANNER ──────────────────────────────────────────────────────────
let isScanning = false;
async function scan() {
  if (!BOT.running || isScanning) return;
  isScanning = true;
  const now = Date.now();
  
  if (!BOT.lastGainerScan || now - BOT.lastGainerScan >= 120000) {
    BOT.lastGainerScan = now;
    addLog(`🔍 Full Scan: Fetching gainers >${BOT.minGain}%...`, 'dim');
    
    try {
      const tickers = await fetchTicker();
      if (tickers && tickers.length > 0) {
        tickers.forEach(t => {
          if (+t.priceChangePercent >= BOT.minGain && !BOT.qualifiedCoins.includes(t.symbol)) {
            BOT.qualifiedCoins.push(t.symbol);
            saveState();
          }
        });

        const gainers = tickers
          .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') &&
            (+t.priceChangePercent >= BOT.showGain || BOT.qualifiedCoins.includes(t.symbol)) &&
            +t.quoteVolume > 1000000) // Minimum 1M daily volume filter
          .sort((a, b) => {
            const aQ = BOT.qualifiedCoins.includes(a.symbol) ? 1 : 0;
            const bQ = BOT.qualifiedCoins.includes(b.symbol) ? 1 : 0;
            if (aQ !== bQ) return bQ - aQ;
            return +b.priceChangePercent - +a.priceChangePercent;
          })
          .slice(0, 40);

        BOT.gainers = gainers;
        addLog(`📊 Tracked ${BOT.qualifiedCoins.length} highly volatile coins total.`, 'amber');
      }
    } catch (e) {
      addLog('⚠️ Gainer scan network error', 'red');
    }
  }

  try {
    const activeSymbols = BOT.activeTrades.map(t => t.symbol);
    
    // Scan all qualified coins sequentially to avoid rate limits
    for (const sym of BOT.qualifiedCoins) {
      const analysis = await analyzeSymbol(sym);
      if (!analysis) continue;

      let rejectReason = "Waiting for setup...";
      let rejectColor = "dim";
      
      if (!analysis.hasFlatBase) {
        rejectReason = "Rejected: No Flat Base Pattern";
        rejectColor = "red";
      } else if (!analysis.vwapCrossunder) {
        const dist = ((analysis.currentPrice - analysis.currentVWAP) / analysis.currentVWAP * 100);
        if (dist > 0) {
          rejectReason = `Waiting to drop to VWAP (-${dist.toFixed(2)}%)`;
          rejectColor = "blue";
        } else {
          rejectReason = `Price below VWAP. Needs bounce.`;
          rejectColor = "dim";
        }
      } else if (!analysis.volumeConfirmation) {
        rejectReason = "Rejected: Weak Volume on breakdown";
        rejectColor = "amber";
      } else if (!analysis.hasRoomToFall) {
        rejectReason = `Rejected: Flat base support too close`;
        rejectColor = "red";
      } else {
        rejectReason = "✅ PREMIUM SETUP FIRED!";
        rejectColor = "green";
      }
      
      if (activeSymbols.includes(sym)) {
        rejectReason = "Currently in active position";
        rejectColor = "blue";
      } else if (BOT.activeTrades.length >= BOT.maxPositions && analysis.fullSignal) {
        rejectReason = "Signal ready, but max positions reached";
        rejectColor = "amber";
      }

      BOT.trackingData[sym] = {
        reason: rejectReason,
        color: rejectColor,
        price: analysis.currentPrice,
        vwap: analysis.currentVWAP,
        flat: analysis.hasFlatBase ? "YES" : "NO",
        high: BOT.trackingData[sym] ? BOT.trackingData[sym].high : BOT.minGain
      };

      if (analysis.fullSignal && !activeSymbols.includes(sym) && BOT.activeTrades.length < BOT.maxPositions) {
        openTrade(analysis);
        activeSymbols.push(sym); // Prevent double-opening in same loop
      }
      
      // Artificial delay to prevent Binance rate limits (10 requests per second max)
      await new Promise(res => setTimeout(res, 150));
    }
  } catch (e) {
    addLog('⚠️ Analysis loop error: ' + e.message, 'red');
  } finally {
    isScanning = false;
  }
}

// ─── LIFECYCLE ───────────────────────────────────────────────────────────────
function startBot() {
  if (BOT.running) return;
  BOT.running = true;
  addLog('🚀 Advanced Bot Engine Started. Scanning market...', 'green');
  scan();
  BOT.scanInterval = setInterval(scan, 20000); // 20s interval
  BOT.priceInterval = setInterval(checkActiveTrades, 3000); // 3s fast price check
}

function stopBot() {
  BOT.running = false;
  BOT.lastGainerScan = null;
  clearInterval(BOT.scanInterval);
  clearInterval(BOT.priceInterval);
  addLog('Bot paused safely.', 'amber');
}

// ─── ERROR HANDLING & BOOTSTRAP ──────────────────────────────────────────────
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));

const SESSION_START = Date.now();

app.get('/api/state', (req, res) => {
  try {
    res.json({
      ...BOT,
      uptime: Date.now() - SESSION_START
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
  const { action, payload } = req.body;
  try {
    if (action === 'start') {
      startBot();
      res.json({ success: true, running: true });
    } else if (action === 'stop') {
      stopBot();
      res.json({ success: true, running: false });
    } else if (action === 'reset') {
      BOT.balance = 100; BOT.startBalance = 100; BOT.trades = []; BOT.activeTrades = [];
      BOT.qualifiedCoins = []; BOT.trackingData = {}; BOT.logs = []; BOT.resets = 0;
      BOT.highestBalance = 100; BOT.maxDrawdownAmt = 0;
      saveState();
      res.json({ success: true });
    } else if (action === 'restore') {
      if (payload) {
        BOT.balance = payload.balance || 100;
        BOT.trades = payload.trades || [];
        BOT.activeTrades = payload.activeTrades || [];
        BOT.qualifiedCoins = payload.qualifiedCoins || [];
        saveState();
      }
      res.json({ success: true });
    } else if (action === 'set_balance') {
      BOT.balance = parseFloat(payload.balance);
      if (BOT.balance > BOT.highestBalance) BOT.highestBalance = BOT.balance;
      saveState();
      res.json({ success: true });
    } else if (action === 'manual_trade') {
      const p = parseFloat(payload.entryPrice);
      const sym = payload.symbol.toUpperCase();
      const margin = +(BOT.balance * BOT.riskPct).toFixed(4);
      const notional = margin * BOT.leverage;
      const tp = p * (1 - (BOT.tpMultiplier / BOT.leverage));
      const sl = p * (1 + (BOT.balance * BOT.maxDrawdownPct) / notional);
      const trade = {
        id: Date.now(), symbol: sym, entryPrice: p, currentPrice: p, vwapAtEntry: p,
        rsiAtEntry: 50, atrAtEntry: 0, margin, notional, tpPrice: +tp.toFixed(8), slPrice: +sl.toFixed(8),
        originalSlPrice: +sl.toFixed(8), tpProfit: +(((p - tp) / p) * notional).toFixed(4), slLoss: -(BOT.balance * BOT.maxDrawdownPct),
        side: 'SHORT', leverage: BOT.leverage, openTime: new Date(), signalType: 'MANUAL',
        fibLevels: [], unrealizedPnl: 0, highestPriceSinceEntry: p, lowestPriceSinceEntry: p, trailingActive: false,
        entryConditions: { hasFlatBase: false, hasRoomToFall: false }
      };
      BOT.activeTrades.push(trade);
      BOT.balance = +(BOT.balance - margin).toFixed(4);
      saveState();
      res.json({ success: true });
    } else if (action === 'edit_trade') {
      const t = BOT.activeTrades.find(x => x.id === payload.id);
      if (t) {
        if (payload.tpPrice) { t.tpPrice = parseFloat(payload.tpPrice); t.tpProfit = +(((t.entryPrice - t.tpPrice) / t.entryPrice) * t.notional).toFixed(4); }
        if (payload.slPrice) { t.slPrice = parseFloat(payload.slPrice); t.slLoss = -Math.abs(((t.entryPrice - t.slPrice) / t.entryPrice) * t.notional); }
        saveState();
      }
      res.json({ success: true });
    } else if (action === 'close_trade') {
      const idx = BOT.activeTrades.findIndex(t => t.id === payload.id);
      if (idx !== -1) {
        const t = BOT.activeTrades[idx];
        let price = t.currentPrice;
        try {
          const r = await fetchWithTimeout(`${BINANCE}/ticker/price?symbol=${t.symbol}`, 3000);
          if (r && r.price) price = +r.price;
        } catch (e) {}
        const pnl = +(((t.entryPrice - price) / t.entryPrice) * t.notional).toFixed(4);
        const closed_trade = {
          ...t, exitPrice: price, closeTime: new Date(), pnl, result: pnl >= 0 ? 'WIN' : 'LOSS',
          durationMin: Math.round((Date.now() - new Date(t.openTime).getTime()) / 1000 / 60),
          roiPct: +(pnl / t.margin * 100).toFixed(2), balancePct: +(pnl / BOT.startBalance * 100).toFixed(2),
          analysisText: "[MANUAL CLOSE]"
        };
        BOT.trades.push(closed_trade);
        BOT.activeTrades.splice(idx, 1);
        BOT.balance = +(BOT.balance + t.margin + pnl).toFixed(4);
        addLog(`${pnl >= 0 ? '✅' : '❌'} MANUAL CLOSE ${t.symbol} | ${fmtP(pnl)}`, pnl >= 0 ? 'green' : 'red');
        saveState(); sendPeriodicReport();
      }
      res.json({ success: true });
    } else if (action === 'cancel_trade') {
      const idx = BOT.activeTrades.findIndex(t => t.id === payload.id);
      if (idx !== -1) {
        BOT.balance = +(BOT.balance + BOT.activeTrades[idx].margin).toFixed(4);
        BOT.activeTrades.splice(idx, 1);
        saveState();
      }
      res.json({ success: true });
    } else if (action === 'analyze') {
       const a = await analyzeSymbol(payload.symbol);
       res.json({ success: true, analysis: a });
    } else {
      res.json({ success: false, msg: 'Unknown action' });
    }
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

// ─── ERROR HANDLING & BOOTSTRAP ──────────────────────────────────────────────
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));

loadState();
startBot(); // Auto-start

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend Engine running on port ${PORT}`);
});