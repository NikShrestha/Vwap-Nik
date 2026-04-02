
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args))); // If using node < 18, but Node 18 native fetch is better. We'll use global fetch.

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

let BOT = {
  balance: 110,
  startBalance: 100,
  targetBalance: 200,
  running: false,
  trades: [],       // closed
  activeTrades: [], // open
  gainers: [],
  selectedCoin: null,
  scanInterval: null,
  priceInterval: null,
  nextScanIn: 0,
  scanTimer: null,
  lastScanTime: null,
  maxPositions: 2,
  riskPct: 0.02,
  tpMultiplier: 3,
  maxDrawdownPct: 0.30,
  minGain: 30,
  showGain: 10,
  leverage: 20,
  qualifiedCoins: [],
  trackingData: {},
  resets: 0,
  highestBalance: 110,
  maxDrawdownAmt: 4.20,
  logs: [] // added for backend logs
};

const STATE_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'bot_state.json') : 'bot_state.json';

function saveState() {
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
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = fs.readFileSync(STATE_FILE, 'utf8');
      const p = JSON.parse(saved);
      if (p.balance !== undefined) BOT.balance = p.balance;
      if (p.startBalance !== undefined) BOT.startBalance = p.startBalance;
      if (p.trades) {
        BOT.trades = p.trades.map(t => ({
          ...t,
          openTime: t.openTime ? new Date(t.openTime) : new Date(),
          closeTime: t.closeTime ? new Date(t.closeTime) : new Date()
        }));
      }
      if (p.activeTrades) {
        BOT.activeTrades = p.activeTrades.map(t => ({
          ...t,
          openTime: t.openTime ? new Date(t.openTime) : new Date()
        }));
      }
      if (p.qualifiedCoins) BOT.qualifiedCoins = p.qualifiedCoins;
      if (p.resets !== undefined) BOT.resets = p.resets;
      if (p.highestBalance !== undefined) BOT.highestBalance = p.highestBalance;
      if (p.maxDrawdownAmt !== undefined) BOT.maxDrawdownAmt = p.maxDrawdownAmt;
    }
  } catch (e) { 
    console.error('Error loading bot state', e); 
  }
}

// ─── LOG ─────────────────────────────────────────────────────────────────────
function addLog(msg, type = '') {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[${timeStr}] ${msg}`);
  BOT.logs.unshift({ time: timeStr, msg, type });
  if (BOT.logs.length > 60) BOT.logs.pop();
}

function fmt(n, d = 2) { return (+n).toFixed(d); }
function fmtP(n) { return (n >= 0 ? '+' : '') + fmt(n, 2); }

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegramMessage(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

function sendPeriodicReport() {
  const wins = BOT.trades.filter(t => t.result === 'WIN').length;
  const total = BOT.trades.length;
  const wr = total > 0 ? (wins / total * 100).toFixed(1) : 0;
  
  const todayStr = new Date().toLocaleDateString();
  const tradesToday = BOT.trades.filter(t => new Date(t.closeTime).toLocaleDateString() === todayStr).length;
  
  const roi = ((BOT.balance - BOT.startBalance) / BOT.startBalance * 100).toFixed(2);
  
  const msg = `📊 <b>VWAP BOT STATUS REPORT</b> 📊\n\n` +
              `💰 <b>Balance:</b> $${fmt(BOT.balance)}\n` +
              `📈 <b>ROI:</b> ${roi >= 0 ? '+'+roi : roi}%\n` +
              `🏆 <b>Win Rate:</b> ${wr}% (${wins}/${total})\n` +
              `🔄 <b>Trades Today:</b> ${tradesToday}\n` +
              `⚡ <b>Active Positions:</b> ${BOT.activeTrades.length}\n` +
              `⚠️ <b>Account Resets:</b> ${BOT.resets || 0}`;
  sendTelegramMessage(msg);
}

// ─── BINANCE API ──────────────────────────────────────────────────────────────
const BINANCE = 'https://fapi.binance.com/fapi/v1';

let validSymbols = new Set();
async function fetchValidSymbols() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(`${BINANCE}/exchangeInfo`, { signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await r.json();
    
    if (!data.symbols) {
       throw new Error(data.msg || JSON.stringify(data).substring(0, 100));
    }
    
    const valid = data.symbols
      .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map(s => s.symbol);
    validSymbols = new Set(valid);
  } catch (e) {
    console.error("Error fetching exchange info", e);
    throw e;
  }
}

async function fetchTicker() {
  if (validSymbols.size === 0) await fetchValidSymbols();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  
  try {
    const r = await fetch(`${BINANCE}/ticker/24hr`, { signal: controller.signal });
    clearTimeout(timeoutId);
    const text = await r.text();
    let tickers;
    try {
      tickers = JSON.parse(text);
    } catch(err) {
      console.error('Binance API JSON Parse Error:', text.substring(0, 100));
      return [];
    }
    if (!Array.isArray(tickers)) return [];
    return tickers.filter(t => validSymbols.has(t.symbol));
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
async function fetchKlines(symbol, interval = '5m', limit = 100) {
  const r = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return r.json();
}
async function fetchPrice(symbol) {
  const r = await fetch(`${BINANCE}/ticker/price?symbol=${symbol}`);
  return r.json();
}

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

function checkVWAPCrossunder(klines, vwap) {
  const n = klines.length;
  if (n < 3) return false;
  const prevClose = +klines[n - 2][4];
  const currClose = +klines[n - 1][4];
  const prevVWAP = vwap[n - 2];
  const currVWAP = vwap[n - 1];
  return prevClose > prevVWAP && currClose < currVWAP;
}

async function analyzeSymbol(symbol) {
  try {
    const klines = await fetchKlines(symbol, '5m', 300); // 300 candles = 25 hours
    if (!klines || !Array.isArray(klines) || klines.length < 20) return null;

    const closes = klines.map(k => +k[4]);
    const highs = klines.map(k => +k[2]);
    const lows = klines.map(k => +k[3]);
    const vols = klines.map(k => +k[5]);

    const vwap = calcVWAP(klines);
    const rsiArr = calcRSI(closes);
    const rsi = rsiArr ? rsiArr[rsiArr.length - 1] : null;

    const currentPrice = closes[closes.length - 1];
    const currentVWAP = vwap[vwap.length - 1];

    const recentHigh = Math.max(...highs.slice(-150)); // Search for peak in the last 12.5 hours
    
    let hasFlatBase = false;
    let baseMaxVal = null;
    let hasRoomToFall = false;
    
    const peakVal = recentHigh;
    const peakIndex = highs.lastIndexOf(peakVal);
    let pumpDuration = 0;
    
    let baseEnd = peakIndex - 1;
    while (baseEnd >= 12) {
      const windowHighs = highs.slice(baseEnd - 12, baseEnd + 1);
      const windowLows = lows.slice(baseEnd - 12, baseEnd + 1);
      const wMax = Math.max(...windowHighs);
      const wMin = Math.min(...windowLows);
      const fluctuation = (wMax - wMin) / wMin;
      
      if (fluctuation <= 0.15) { // 15% fluctuation tolerance for a "flat base"
        if (peakVal >= wMax * 1.25) { // The peak must be at least a 25% jump from this flat base
          pumpDuration = peakIndex - baseEnd;
          if (pumpDuration <= 144) { // The jump must have happened within 12 hours (144 candles)
            hasFlatBase = true;
            baseMaxVal = wMax;
          }
          break;
        }
      }
      baseEnd--;
    }

    const baseLowIndex = baseEnd > 0 ? baseEnd - 12 : 0;
    const recentLow = Math.min(...lows.slice(baseLowIndex, peakIndex + 1));
    const fibLevels = calcFib(recentHigh, recentLow);
    
    if (hasFlatBase) {
      if (currentPrice > baseMaxVal) {
        const maxDropPct = (currentPrice - baseMaxVal) / currentPrice;
        const maxRoi = maxDropPct * BOT.leverage * 100;
        if (maxRoi >= 50) {
          hasRoomToFall = true;
        }
      }
    }

    const vwapCrossunder = checkVWAPCrossunder(klines, vwap);

    const fullSignal = vwapCrossunder && hasFlatBase && hasRoomToFall;
    const partialSignal = vwapCrossunder;

    return {
      symbol, currentPrice, currentVWAP,
      rsi, vwapCrossunder,
      hasFlatBase, hasRoomToFall, baseMaxVal,
      fullSignal, partialSignal,
      fibLevels, klines, vwap,
      recentHigh, recentLow,
    };
  } catch (e) {
    return null;
  }
}

function openTrade(analysis) {
  const { symbol, currentPrice, currentVWAP, rsi, fibLevels, fullSignal, baseMaxVal } = analysis;
  const margin = +(BOT.balance * BOT.riskPct).toFixed(4);
  const notional = margin * BOT.leverage;
  
  const idealTpPricePct = BOT.tpMultiplier / BOT.leverage;
  const idealTpPrice = +(currentPrice * (1 - idealTpPricePct)).toFixed(8);
  
  const tpPrice = baseMaxVal ? +(Math.max(idealTpPrice, baseMaxVal)).toFixed(8) : idealTpPrice;
  
  const allowedLoss = BOT.balance * BOT.maxDrawdownPct;
  const slPricePct = allowedLoss / notional;
  const slPrice = +(currentPrice * (1 + slPricePct)).toFixed(8);
  
  const tpProfit = +(((currentPrice - tpPrice) / currentPrice) * notional).toFixed(4);
  const slLoss = -allowedLoss;

  const trade = {
    id: Date.now(),
    symbol, entryPrice: currentPrice, vwapAtEntry: currentVWAP,
    rsiAtEntry: rsi, margin, notional, tpPrice, slPrice,
    tpProfit, slLoss,
    side: 'SHORT', leverage: BOT.leverage,
    openTime: new Date(),
    signalType: fullSignal ? 'FULL SIGNAL' : 'VWAP',
    fibLevels,
    unrealizedPnl: 0,
    entryConditions: {
      hasFlatBase: analysis.hasFlatBase,
      hasRoomToFall: analysis.hasRoomToFall
    }
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
      const data = await fetchPrice(t.symbol);
      const price = +data.price;
      t.currentPrice = price;
      const rawPnl = (t.entryPrice - price) / t.entryPrice * t.notional;
      t.unrealizedPnl = +rawPnl.toFixed(4);

      let closed = false;
      let pnl = 0;
      let result = '';

      if (price <= t.tpPrice) {
        pnl = t.tpProfit;
        result = 'WIN';
        closed = true;
        addLog(`✅ TP HIT ${t.symbol} @ $${fmt(price)} | +$${fmt(pnl)}`, 'green');
        sendTelegramMessage(`✅ <b>TP HIT ${t.symbol}</b>\n<b>Exit:</b> $${fmt(price)}\n<b>Profit:</b> +$${fmt(pnl)}\n<b>ROI:</b> +${fmt(pnl / t.margin * 100)}%`);
      } else if (price >= t.slPrice) {
        pnl = t.slLoss;
        result = 'LOSS';
        closed = true;
        addLog(`❌ SL HIT ${t.symbol} @ $${fmt(price)} | -$${fmt(Math.abs(pnl))}`, 'red');
        sendTelegramMessage(`❌ <b>SL HIT ${t.symbol}</b>\n<b>Exit:</b> $${fmt(price)}\n<b>Loss:</b> -$${fmt(Math.abs(pnl))}\n<b>ROI:</b> -${fmt(Math.abs(pnl) / t.margin * 100)}%`);
      }

        if (closed) {
          const duration = Math.round((Date.now() - new Date(t.openTime).getTime()) / 1000 / 60);
          
          let exitAnalysisText = "";
          try {
            const exitA = await analyzeSymbol(t.symbol);
            if (exitA) {
              const exitRsi = exitA.rsi ? exitA.rsi.toFixed(1) : '?';
              const exitVwap = exitA.currentVWAP ? fmt(exitA.currentVWAP, 4) : '?';
              const cond = t.entryConditions || {};
              exitAnalysisText = `[ENTRY CHECKS] FlatBase: ${cond.hasFlatBase||false}   [EXIT STATUS] RSI: ${exitRsi} | VWAP: $${exitVwap}`;
            }
          } catch(e) {}

          const closed_trade = {
            ...t,
            exitPrice: price,
            closeTime: new Date(),
            pnl, result,
            durationMin: duration,
            roiPct: +(pnl / t.margin * 100).toFixed(2),
            balancePct: +(pnl / BOT.startBalance * 100).toFixed(2),
            analysisText: exitAnalysisText
          };
          BOT.trades.push(closed_trade);
          BOT.activeTrades.splice(i, 1);
          BOT.balance = +(BOT.balance + t.margin + pnl).toFixed(4);
          if (BOT.balance < 0) BOT.balance = 0;
          saveState();
          checkGameOver();
          sendPeriodicReport();
        } else {
          // If not closed, check timeout
          const duration = Math.round((Date.now() - new Date(t.openTime).getTime()) / 1000 / 60);
          if (duration >= 1500 && pnl >= 0) {
             // Close in profit after 1500m
             pnl = +(((t.entryPrice - price) / t.entryPrice) * t.notional).toFixed(4);
             result = 'WIN';
             addLog(`⏱️ TIMEOUT CLOSE ${t.symbol} @ $${fmt(price)} | +$${fmt(pnl)}`, 'green');
             sendTelegramMessage(`⏱️ <b>TIMEOUT CLOSE ${t.symbol}</b>\n<b>Exit:</b> $${fmt(price)}\n<b>Profit:</b> +$${fmt(pnl)}\n<b>Duration:</b> ${duration}m`);
             
             let exitAnalysisText = "[TIMEOUT CLOSE]";
             const closed_trade = {
               ...t, exitPrice: price, closeTime: new Date(), pnl, result, durationMin: duration,
               roiPct: +(pnl / t.margin * 100).toFixed(2), balancePct: +(pnl / BOT.startBalance * 100).toFixed(2),
               analysisText: exitAnalysisText
             };
             BOT.trades.push(closed_trade);
             BOT.activeTrades.splice(i, 1);
             BOT.balance = +(BOT.balance + t.margin + pnl).toFixed(4);
             saveState();
             checkGameOver();
             sendPeriodicReport();
          }
        }
      } catch (e) { /* skip */ }
  }
}

function checkGameOver() {
  if (BOT.balance < 2 && BOT.activeTrades.length === 0) {
    addLog(`💀 ACCOUNT BLOWN ($${fmt(BOT.balance)}). Auto-recovering...`, 'red');
    sendTelegramMessage(`🔄 <b>ACCOUNT BLOWN & RESET</b>\nBalance dropped to $${fmt(BOT.balance)}.\nBot is automatically restarting with $100.00!`);
    BOT.balance = 100;
    BOT.startBalance = 100;
    BOT.highestBalance = 100;
    BOT.maxDrawdownAmt = 0;
    BOT.resets = (BOT.resets || 0) + 1;
    saveState();
  }
}

async function scan() {
  if (!BOT.running) return;
  const now = Date.now();
  
  if (!BOT.lastGainerScan || now - BOT.lastGainerScan >= 120000) {
    BOT.lastGainerScan = now;
    addLog('🔍 Full Scan: Fetching market gainers >10%...', 'dim');
    
    try {
      const tickers = await fetchTicker();
      if (!tickers || tickers.length === 0) return;
      
      tickers.forEach(t => {
        if (+t.priceChangePercent >= BOT.minGain) {
          if (!BOT.qualifiedCoins.includes(t.symbol)) {
            BOT.qualifiedCoins.push(t.symbol);
            saveState();
          }
        }
      });

      const gainers = tickers
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') &&
          (+t.priceChangePercent >= BOT.showGain || BOT.qualifiedCoins.includes(t.symbol)) &&
          +t.quoteVolume > 500000)
        .sort((a, b) => {
          const aQual = BOT.qualifiedCoins.includes(a.symbol) ? 1 : 0;
          const bQual = BOT.qualifiedCoins.includes(b.symbol) ? 1 : 0;
          if (aQual > bQual) return -1;
          if (bQual > aQual) return 1;
          return +b.priceChangePercent - +a.priceChangePercent;
        })
        .slice(0, 30);

      BOT.gainers = gainers;
      addLog(`📊 Found ${gainers.length} gainers >+${BOT.showGain}% (Trading only tracked >+${BOT.minGain}%)`, gainers.length > 0 ? 'amber' : 'dim');
    } catch (e) {
      addLog('⚠️ Gainer scan error: ' + e.message, 'red');
    }
  }

  try {
    if (BOT.gainers && BOT.gainers.length > 0) {
      const alreadyTrading = BOT.activeTrades.map(t => t.symbol);

      for (const g of BOT.gainers) {
        if (!BOT.qualifiedCoins.includes(g.symbol)) {
          continue;
        }

        const analysis = await analyzeSymbol(g.symbol);
        if (!analysis) continue;

        const highPct = ((+g.highPrice - +g.openPrice) / +g.openPrice) * 100;
        let rejectReason = "Waiting...";
        let rejectColor = "amber";
        
        if (!analysis.hasFlatBase) {
          rejectReason = "Rejected: No Flat Base";
          rejectColor = "red";
        } else if (!analysis.vwapCrossunder) {
          const dist = ((analysis.currentPrice - analysis.currentVWAP) / analysis.currentVWAP * 100);
          if (dist > 0) {
            rejectReason = `Waiting to drop to VWAP (-${dist.toFixed(2)}%)`;
            rejectColor = "blue";
          } else {
            rejectReason = `Price below VWAP. Needs to bounce over it.`;
            rejectColor = "dim";
          }
        } else if (!analysis.hasRoomToFall) {
          rejectReason = `Rejected: Already near flat base ($${fmt(analysis.baseMaxVal, 4)})`;
          rejectColor = "red";
        } else {
          rejectReason = "✅ VWAP CROSSED! FIRING SIGNAL!";
          rejectColor = "green";
        }
        
        if (alreadyTrading.includes(g.symbol)) {
          rejectReason = "Currently in active position";
          rejectColor = "blue";
        } else if (BOT.activeTrades.length >= BOT.maxPositions && analysis.fullSignal) {
          rejectReason = "Signal ready, but max positions reached";
          rejectColor = "amber";
        }

        BOT.trackingData[g.symbol] = {
          reason: rejectReason,
          color: rejectColor,
          price: analysis.currentPrice,
          vwap: analysis.currentVWAP,
          flat: analysis.hasFlatBase ? "YES" : "NO",
          high: highPct
        };

        if (analysis.fullSignal && !alreadyTrading.includes(g.symbol) && BOT.activeTrades.length < BOT.maxPositions) {
          openTrade(analysis);
        }
      }
    }
    
    for (const sym of BOT.qualifiedCoins) {
      if (!BOT.gainers || !BOT.gainers.some(g => g.symbol === sym)) {
         try {
            const analysis = await analyzeSymbol(sym);
            if (analysis) {
               let rejectReason = "Not in Top 30 Gainers";
               let rejectColor = "dim";
               if (!analysis.hasFlatBase) {
                  rejectReason = "Rejected: No Flat Base";
                  rejectColor = "red";
               } else if (!analysis.vwapCrossunder) {
                  const dist = ((analysis.currentPrice - analysis.currentVWAP) / analysis.currentVWAP * 100);
                  if (dist > 0) {
                     rejectReason = `Waiting to drop to VWAP (-${dist.toFixed(2)}%)`;
                     rejectColor = "blue";
                  } else {
                     rejectReason = `Price below VWAP. Needs to bounce over it.`;
                     rejectColor = "dim";
                  }
               }
               BOT.trackingData[sym] = {
                  reason: rejectReason,
                  color: rejectColor,
                  price: analysis.currentPrice,
                  vwap: analysis.currentVWAP,
                  flat: analysis.hasFlatBase ? "YES" : "NO",
                  high: BOT.trackingData[sym] ? BOT.trackingData[sym].high : 30
               };
            }
         } catch (e) {}
      }
    }
  } catch (e) {
    addLog('⚠️ Scan error: ' + e.message, 'red');
  }
}

function startBot() {
  if (BOT.running) return;
  BOT.running = true;
  addLog('🚀 Bot started. Entering scan loop.', 'green');
  scan();
  BOT.scanInterval = setInterval(scan, 15000);
  BOT.priceInterval = setInterval(checkActiveTrades, 3000);
}

function stopBot() {
  BOT.running = false;
  BOT.lastGainerScan = null;
  clearInterval(BOT.scanInterval);
  clearInterval(BOT.priceInterval);
  addLog('Bot paused.', 'amber');
}

// ─── EXPRESS API ─────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({
    balance: BOT.balance,
    startBalance: BOT.startBalance,
    targetBalance: BOT.targetBalance,
    running: BOT.running,
    trades: BOT.trades,
    activeTrades: BOT.activeTrades,
    gainers: BOT.gainers,
    selectedCoin: BOT.selectedCoin,
    nextScanIn: BOT.nextScanIn,
    maxPositions: BOT.maxPositions,
    riskPct: BOT.riskPct,
    tpMultiplier: BOT.tpMultiplier,
    maxDrawdownPct: BOT.maxDrawdownPct,
    minGain: BOT.minGain,
    showGain: BOT.showGain,
    leverage: BOT.leverage,
    qualifiedCoins: BOT.qualifiedCoins,
    trackingData: BOT.trackingData,
    resets: BOT.resets,
    highestBalance: BOT.highestBalance,
    maxDrawdownAmt: BOT.maxDrawdownAmt,
    logs: BOT.logs
  });
});

app.post('/api/action', async (req, res) => {
  const { action, payload } = req.body;
  try {
    if (action === 'start') {
      startBot();
      res.json({ success: true, running: true });
    } else if (action === 'stop') {
      stopBot();
      res.json({ success: true, running: false });
    } else if (action === 'reset') {
      BOT.balance = 100;
      BOT.startBalance = 100;
      BOT.trades = [];
      BOT.activeTrades = [];
      BOT.qualifiedCoins = [];
      BOT.trackingData = {};
      BOT.logs = [];
      BOT.resets = 0;
      BOT.highestBalance = 100;
      BOT.maxDrawdownAmt = 0;
      saveState();
      res.json({ success: true });
    } else if (action === 'restore') {
      BOT.balance = 110.00;
      BOT.startBalance = 100.00;
      BOT.highestBalance = 110.00;
      BOT.maxDrawdownAmt = 4.20;
      BOT.resets = 0;
      BOT.trades = payload.trades || [];
      BOT.activeTrades = payload.activeTrades || [];
      BOT.qualifiedCoins = payload.qualifiedCoins || [];
      saveState();
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
        rsiAtEntry: 50, margin, notional, tpPrice: +tp.toFixed(8), slPrice: +sl.toFixed(8),
        tpProfit: +(((p - tp) / p) * notional).toFixed(4), slLoss: -(BOT.balance * BOT.maxDrawdownPct),
        side: 'SHORT', leverage: BOT.leverage, openTime: new Date(), signalType: 'MANUAL',
        fibLevels: [], unrealizedPnl: 0, entryConditions: { hasFlatBase: false, hasRoomToFall: false }
      };
      BOT.activeTrades.push(trade);
      BOT.balance = +(BOT.balance - margin).toFixed(4);
      saveState();
      res.json({ success: true });
    } else if (action === 'edit_trade') {
      const t = BOT.activeTrades.find(x => x.id === payload.id);
      if (t) {
        if (payload.tpPrice) {
          t.tpPrice = parseFloat(payload.tpPrice);
          t.tpProfit = +(((t.entryPrice - t.tpPrice) / t.entryPrice) * t.notional).toFixed(4);
        }
        if (payload.slPrice) {
          t.slPrice = parseFloat(payload.slPrice);
          t.slLoss = -Math.abs(((t.entryPrice - t.slPrice) / t.entryPrice) * t.notional);
        }
        saveState();
      }
      res.json({ success: true });
    } else if (action === 'close_trade') {
      const idx = BOT.activeTrades.findIndex(t => t.id === payload.id);
      if (idx !== -1) {
        const t = BOT.activeTrades[idx];
        let price = t.currentPrice;
        try {
          const data = await fetchPrice(t.symbol);
          price = +data.price;
        } catch (e) {}
        const pnl = +(((t.entryPrice - price) / t.entryPrice) * t.notional).toFixed(4);
        const result = pnl >= 0 ? 'WIN' : 'LOSS';
        const duration = Math.round((Date.now() - new Date(t.openTime).getTime()) / 1000 / 60);
        const closed_trade = {
          ...t, exitPrice: price, closeTime: new Date(), pnl, result, durationMin: duration,
          roiPct: +(pnl / t.margin * 100).toFixed(2), balancePct: +(pnl / BOT.startBalance * 100).toFixed(2),
          analysisText: "[MANUAL CLOSE]"
        };
        BOT.trades.push(closed_trade);
        BOT.activeTrades.splice(idx, 1);
        BOT.balance = +(BOT.balance + t.margin + pnl).toFixed(4);
        if (BOT.balance < 0) BOT.balance = 0;
        addLog(`${pnl >= 0 ? '✅' : '❌'} MANUAL CLOSE ${t.symbol} @ $${fmt(price)} | ${fmtP(pnl)}`, pnl >= 0 ? 'green' : 'red');
        saveState();
        checkGameOver();
        sendPeriodicReport();
      }
      res.json({ success: true });
    } else if (action === 'cancel_trade') {
      const idx = BOT.activeTrades.findIndex(t => t.id === payload.id);
      if (idx !== -1) {
        const t = BOT.activeTrades[idx];
        BOT.activeTrades.splice(idx, 1);
        BOT.balance = +(BOT.balance + t.margin).toFixed(4); // Refund the margin without profit/loss
        saveState();
        res.json({ success: true, msg: 'Trade cancelled and margin refunded' });
      } else {
        res.json({ success: false, msg: 'Trade not found' });
      }
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

loadState();

// Start bot if it was running or auto-start is fine, but lets default to waiting for UI.
addLog('Bot backend initialized. Waiting for START command.', 'blue');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
