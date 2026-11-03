/**
 * 韭菜盒子 v1.2.0 — Snow App 面板插件
 *
 * 基金 / 行情 / 大饼（加密货币）三个页签：分时 + 日 K 蜡烛 + 交易账本（买入/卖出/校正 +
 * 已实现盈亏）+ 交易时段状态 + 名称/拼音搜索；另有独立资源库面板。
 *
 * 数据源（全部为公开接口，仅通过 api.net.fetch 读取）：
 *  - 基金净值：api.fund.eastmoney.com/f10/lsjz（Kimi automation.py 同款）
 *  - 实时行情：qt.gtimg.cn（GBK）
 *  - 日 K 线：ifzq.gtimg.cn（web.ifzq 仅回退）
 *  - 分时：push2his.eastmoney.com/trends2
 *  - 标的搜索：smartbox.gtimg.cn
 *  - 加密货币：data-api.binance.vision（api.binance.com 在部分出口返回 451）
 *
 * 约束：entry 被当作单文件 ES 模块执行，任何 import 都无法解析，全部代码内联。
 * React 从 window.SnowAppPlugin 取，且只在组件渲染期访问。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const KEYS = {
  funds: "funds.v1",
  stocks: "stocks.v1",
  crypto: "crypto.v1",
  holdings: "holdings.v1",
  settings: "settings.v1",
};

// 旧 id（com.shiroeirin.stock-panel）与新 id（com.shiroeirin.leek-box）分属不同存储空间。
// 改名后读取旧键，迁移一次后清除，老用户的持仓/自选不丢。
const LEGACY_KEYS = {
  funds: "com.shiroeirin.stock-panel:funds.v1",
  stocks: "com.shiroeirin.stock-panel:stocks.v1",
  crypto: "com.shiroeirin.stock-panel:crypto.v1",
  library: "com.shiroeirin.stock-panel:library.v1",
  holdings: "com.shiroeirin.stock-panel:holdings.v1",
  settings: "com.shiroeirin.stock-panel:settings.v1",
};

/** 一次性迁移旧 id 的存储键到新 id；已迁移或无需迁移时静默跳过。 */
async function migrateLegacyStorage(api) {
  try {
    const pairs = [
      [LEGACY_KEYS.funds, KEYS.funds],
      [LEGACY_KEYS.stocks, KEYS.stocks],
      [LEGACY_KEYS.crypto, KEYS.crypto],
      [LEGACY_KEYS.library, KEYS.library],
      [LEGACY_KEYS.holdings, KEYS.holdings],
      [LEGACY_KEYS.settings, KEYS.settings],
    ];
    for (let i = 0; i < pairs.length; i += 1) {
      const oldKey = pairs[i][0];
      const newKey = pairs[i][1];
      const oldValue = await api.storage.getJson(oldKey, null);
      if (oldValue !== null && oldValue !== undefined) {
        const existing = await api.storage.getJson(newKey, null);
        if (existing === null || existing === undefined) {
          await api.storage.setJson(newKey, oldValue);
        }
        await api.storage.remove(oldKey).catch(() => {});
      }
    }
  } catch (err) {
    // 迁移失败不阻塞面板加载
  }
}

const FUND_REFRESH_MS = 5 * 60 * 1000;
const STOCK_OPEN_MS = 30 * 1000;
const STOCK_CLOSED_MS = 5 * 60 * 1000;
const CLOCK_TICK_MS = 30 * 1000;
const FUND_CONCURRENCY = 3;
const FUND_PAGE_SIZE = 20;
const RANGES = [20, 60, 120];
const INTRADAY_TTL_MS = 60 * 1000;

// 可选刷新间隔（作者建议4：最低可到 1s）；值即毫秒，0 = 关闭自动刷新。
const REFRESH_OPTIONS = [
  { value: 0, label: "关闭" },
  { value: 1000, label: "1s" },
  { value: 5000, label: "5s" },
  { value: 30000, label: "30s" },
  { value: 60000, label: "1min" },
  { value: 300000, label: "5min" },
];
const DEFAULT_REFRESH_MS = 30000;

const KLINE_BASES = ["https://ifzq.gtimg.cn", "https://web.ifzq.gtimg.cn"];
const SEARCH_BASE = "https://smartbox.gtimg.cn";
const TRENDS_BASE = "https://push2his.eastmoney.com";
const CRYPTO_BASE = "https://data-api.binance.vision";

const CURRENCY_SYMBOL = { CNY: "¥", USD: "$", HKD: "HK$" };

// 发布版预置：只保留大众化的 A 股 / 美股指数基金，避免混入个人持仓。
const DEFAULT_FUNDS = [
  { code: "110020", name: "易方达沪深300ETF联接A", tag: "A股大盘" },
  { code: "050025", name: "博时标普500ETF联接A", tag: "美股大盘" },
  { code: "110022", name: "易方达消费行业股票", tag: "消费" },
  { code: "519736", name: "交银新成长混合", tag: "主动权益" },
];

const DEFAULT_STOCKS = [
  { symbol: "sh000001", name: "上证指数", group: "指数" },
  { symbol: "sz399001", name: "深证成指", group: "指数" },
  { symbol: "sz399006", name: "创业板指", group: "指数" },
  { symbol: "usIXIC", name: "纳斯达克", group: "美股" },
  { symbol: "usINX", name: "标普500", group: "美股" },
  { symbol: "usDJI", name: "道琼斯", group: "美股" },
  { symbol: "sh600519", name: "贵州茅台", group: "A股" },
  { symbol: "sz300750", name: "宁德时代", group: "A股" },
  { symbol: "usAAPL", name: "Apple", group: "美股" },
  { symbol: "usNVDA", name: "NVIDIA", group: "美股" },
];

const DEFAULT_CRYPTO = [
  { symbol: "BTCUSDT", name: "Bitcoin", group: "主流" },
  { symbol: "ETHUSDT", name: "Ethereum", group: "主流" },
  { symbol: "SOLUSDT", name: "Solana", group: "主流" },
  { symbol: "BNBUSDT", name: "BNB", group: "主流" },
  { symbol: "XRPUSDT", name: "XRP", group: "主流" },
  { symbol: "DOGEUSDT", name: "Dogecoin", group: "Meme" },
];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toNum(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "" || text === "--" || text === "null") return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function fmtNum(value, digits) {
  const num = toNum(value);
  if (num === null) return "—";
  return num.toFixed(digits === undefined ? 2 : digits);
}

function fmtMoney(value, currency) {
  const num = toNum(value);
  if (num === null) return "—";
  const symbol = CURRENCY_SYMBOL[currency] || "";
  const text = Math.abs(num).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (num < 0 ? "-" : "") + symbol + text;
}

function fmtPct(value) {
  const num = toNum(value);
  if (num === null) return "—";
  return (num > 0 ? "+" : "") + num.toFixed(2) + "%";
}

function fmtClock(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

/** 从 ISO 日期字符串提取 MM-DD。 */
function shortDate(dateText) {
  const text = String(dateText || "");
  const match = text.match(/\d{4}-(\d{2})-(\d{2})/);
  return match ? match[1] + "-" + match[2] : text;
}

/** 数字动画：值变化时从旧值平滑过渡到新值（尊重 prefers-reduced-motion）。 */
function AnimatedNumber(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState, useEffect, useRef } = R;
  const value = toNum(props.value);
  const digits = props.digits === undefined ? 2 : props.digits;
  const format = props.format || ((v) => fmtNum(v, digits));
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  const frameRef = useRef(0);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = value;
    if (from === null || to === null || from === to) {
      setDisplay(to);
      return;
    }
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const duration = 320;
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [value]);

  return h("span", { className: props.className || "" }, format(display));
}

function trendClass(value) {
  const num = toNum(value);
  if (num === null || num === 0) return "sp-flat";
  return num > 0 ? "sp-up" : "sp-down";
}

/** 涨跌徽章：淡色底药丸，比纯文字变色更醒目。 */
function badgeClass(value) {
  const num = toNum(value);
  if (num === null || num === 0) return "sp-badge-flat";
  return num > 0 ? "sp-badge-up" : "sp-badge-down";
}

function ChangeBadge(props) {
  const h = createH();
  return h(
    "span",
    { className: "sp-change-badge " + badgeClass(props.value) },
    fmtPct(props.value),
  );
}

function upDownColors(colorMode) {
  const greenUp = colorMode === "green-up";
  return {
    up: greenUp ? "#2f9e44" : "#e5484d",
    down: greenUp ? "#e5484d" : "#2f9e44",
  };
}

function errText(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  return String(error);
}

/** 生成 CSV 并触发下载。 */
function downloadCsv(filename, headers, rows) {
  const escape = (value) => {
    const text = String(value === null || value === undefined ? "" : value);
    if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  };
  const lines = [headers.map(escape).join(",")].concat(
    rows.map((row) => row.map(escape).join(",")),
  );
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function normalizeSymbol(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(lower)) return lower;
  if (/^hk\d{5}$/.test(lower)) return lower;
  if (/^us[a-z0-9.\-]+$/.test(lower)) return "us" + lower.slice(2).toUpperCase();
  if (/^\d{6}$/.test(lower)) {
    if (/^(6|9|5)/.test(lower)) return "sh" + lower;
    return "sz" + lower;
  }
  return text;
}

function marketOfSymbol(symbol) {
  const raw = String(symbol || "");
  if (/^[A-Z0-9]{2,}(USDT|USDC|BUSD|FDUSD)$/.test(raw.toUpperCase())) return "crypto";
  const lower = raw.toLowerCase();
  if (lower.indexOf("us") === 0) return "us";
  if (lower.indexOf("hk") === 0) return "hk";
  return "cn";
}

function currencyOfMarket(market) {
  if (market === "crypto") return "USD";
  if (market === "us") return "USD";
  if (market === "hk") return "HKD";
  return "CNY";
}

/** 东财 secid：沪 1.*、深/北 0.*、美股 105/106/107.*、港股 116.* */
function eastmoneySecId(symbol, fullCode) {
  const lower = String(symbol || "").toLowerCase();
  const suffix = String(fullCode || "").toUpperCase();
  if (lower.indexOf("us") === 0) {
    const ticker = lower.slice(2).toUpperCase();
    let prefix = "105";
    if (suffix.indexOf(".N") > 0) prefix = "106";
    else if (suffix.indexOf(".A") > 0) prefix = "107";
    return prefix + "." + ticker;
  }
  if (lower.indexOf("hk") === 0) return "116." + lower.slice(2);
  if (lower.indexOf("sh") === 0) return "1." + lower.slice(2);
  if (lower.indexOf("sz") === 0) return "0." + lower.slice(2);
  if (lower.indexOf("bj") === 0) return "0." + lower.slice(2);
  return "";
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit || 1, items.length));
  const runners = [];
  for (let i = 0; i < size; i += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          out[index] = await worker(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return out;
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeGbk(base64) {
  return new TextDecoder("gb18030").decode(decodeBase64(base64));
}

/* ------------------------------------------------------------------ */
/* 交易时段（移植 dsh-trading 的 market-status 规则）                   */
/* ------------------------------------------------------------------ */

function zonedTime(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    let weekday = "";
    let hour = 0;
    let minute = 0;
    parts.forEach((part) => {
      if (part.type === "weekday") weekday = part.value;
      else if (part.type === "hour") hour = Number(part.value);
      else if (part.type === "minute") minute = Number(part.value);
    });
    const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = days[weekday];
    return {
      dayOfWeek: dayOfWeek === undefined ? date.getUTCDay() : dayOfWeek,
      minutes: hour * 60 + minute,
    };
  } catch (error) {
    return { dayOfWeek: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

const SESSION_CLOSED = { key: "closed", label: "已收盘", isOpen: false, color: "#8e95a3" };

function getSession(market, timestamp) {
  const date = new Date(timestamp === undefined ? Date.now() : timestamp);
  if (market === "crypto") {
    return { key: "open", label: "7×24", isOpen: true, color: "#2ba471" };
  }

  if (market === "us") {
    const t = zonedTime(date, "America/New_York");
    if (t.dayOfWeek === 0 || t.dayOfWeek === 6) return SESSION_CLOSED;
    if (t.minutes >= 240 && t.minutes < 570) return { key: "pre", label: "盘前", isOpen: false, color: "#e37318" };
    if (t.minutes >= 570 && t.minutes < 960) return { key: "open", label: "交易中", isOpen: true, color: "#2ba471" };
    if (t.minutes >= 960 && t.minutes < 1200) return { key: "after", label: "盘后", isOpen: false, color: "#e37318" };
    return SESSION_CLOSED;
  }

  if (market === "hk") {
    const t = zonedTime(date, "Asia/Hong_Kong");
    if (t.dayOfWeek === 0 || t.dayOfWeek === 6) return SESSION_CLOSED;
    if (t.minutes >= 540 && t.minutes < 570) return { key: "auction", label: "竞价", isOpen: false, color: "#e37318" };
    if (t.minutes >= 570 && t.minutes < 720) return { key: "open", label: "交易中", isOpen: true, color: "#2ba471" };
    if (t.minutes >= 720 && t.minutes < 780) return { key: "midday", label: "午休", isOpen: false, color: "#e37318" };
    if (t.minutes >= 780 && t.minutes < 960) return { key: "open", label: "交易中", isOpen: true, color: "#2ba471" };
    if (t.minutes >= 960 && t.minutes < 970) return { key: "auction", label: "收市竞价", isOpen: false, color: "#e37318" };
    return SESSION_CLOSED;
  }

  const t = zonedTime(date, "Asia/Shanghai");
  if (t.dayOfWeek === 0 || t.dayOfWeek === 6) return SESSION_CLOSED;
  if (t.minutes >= 555 && t.minutes < 570) return { key: "auction", label: "集合竞价", isOpen: false, color: "#e37318" };
  if (t.minutes >= 570 && t.minutes < 690) return { key: "open", label: "交易中", isOpen: true, color: "#2ba471" };
  if (t.minutes >= 690 && t.minutes < 780) return { key: "midday", label: "午间休市", isOpen: false, color: "#e37318" };
  if (t.minutes >= 780 && t.minutes < 900) return { key: "open", label: "交易中", isOpen: true, color: "#2ba471" };
  return SESSION_CLOSED;
}

/* ------------------------------------------------------------------ */
/* 持仓账本                                                            */
/* ------------------------------------------------------------------ */

/** 兼容旧 entryPrice；新账本用 avgCost。 */
function avgCostOf(holding) {
  if (!holding) return null;
  const cost = holding.avgCost !== undefined ? holding.avgCost : holding.entryPrice;
  return toNum(cost);
}

function positionOf(holding, price) {
  const size = holding ? toNum(holding.size) : null;
  if (!holding || size === null || size <= 0) return null;
  const avgCost = avgCostOf(holding);
  const mark = toNum(price);
  const marketValue = mark === null ? null : mark * size;
  const cost = avgCost === null ? null : avgCost * size;
  const pnl = marketValue !== null && cost !== null ? marketValue - cost : null;
  const ratio = pnl !== null && cost ? (pnl / cost) * 100 : null;
  return {
    size: size,
    avgCost: avgCost,
    price: mark,
    marketValue: marketValue,
    cost: cost,
    pnl: pnl,
    ratio: ratio,
    realizedPnl: toNum(holding.realizedPnl),
  };
}

function applyTrade(holding, side, size, price) {
  const tradeSize = toNum(size);
  const tradePrice = toNum(price);
  if (tradeSize === null || tradeSize <= 0 || tradePrice === null || tradePrice <= 0) return null;

  const prevSize = holding ? toNum(holding.size) || 0 : 0;
  const prevCost = avgCostOf(holding);
  const prevRealized = holding ? toNum(holding.realizedPnl) || 0 : 0;
  const now = Date.now();

  if (side === "buy") {
    const nextSize = prevSize + tradeSize;
    const base = prevCost === null ? tradePrice : prevCost;
    const totalCost = prevSize * base + tradeSize * tradePrice;
    return {
      size: nextSize,
      avgCost: nextSize ? totalCost / nextSize : null,
      realizedPnl: prevRealized,
      updatedAt: now,
    };
  }

  if (prevSize <= 0 || tradeSize > prevSize) return null;
  const realized = prevCost === null ? prevRealized : prevRealized + (tradePrice - prevCost) * tradeSize;
  const nextSize = prevSize - tradeSize;
  if (nextSize <= 0) {
    return { size: 0, avgCost: null, realizedPnl: realized, updatedAt: now };
  }
  return { size: nextSize, avgCost: prevCost, realizedPnl: realized, updatedAt: now };
}

/** 按币种汇总：缺价/缺成本不参与该口径；已清仓的已实现盈亏仍计入。 */
function summarizePositions(rows) {
  const buckets = {};
  rows.forEach((row) => {
    const realized =
      row.realized !== undefined
        ? toNum(row.realized)
        : row.position
          ? row.position.realizedPnl
          : null;
    if (!row.position && realized === null) return;

    const currency = row.currency;
    if (!buckets[currency]) {
      buckets[currency] = {
        currency: currency,
        marketValue: 0,
        cost: 0,
        pnl: 0,
        realized: 0,
        count: 0,
        hasValue: false,
        hasCost: false,
        hasPnl: false,
        hasRealized: false,
      };
    }
    const bucket = buckets[currency];

    if (row.position) {
      bucket.count += 1;
      if (row.position.marketValue !== null) {
        bucket.marketValue += row.position.marketValue;
        bucket.hasValue = true;
      }
      if (row.position.cost !== null) {
        bucket.cost += row.position.cost;
        bucket.hasCost = true;
      }
      if (row.position.pnl !== null) {
        bucket.pnl += row.position.pnl;
        bucket.hasPnl = true;
      }
    }
    if (realized !== null) {
      bucket.realized += realized;
      bucket.hasRealized = true;
    }
  });
  return Object.keys(buckets).map((key) => {
    const bucket = buckets[key];
    return {
      currency: key,
      marketValue: bucket.hasValue ? bucket.marketValue : null,
      cost: bucket.hasCost ? bucket.cost : null,
      pnl: bucket.hasPnl ? bucket.pnl : null,
      ratio: bucket.hasPnl && bucket.cost ? (bucket.pnl / bucket.cost) * 100 : null,
      realized: bucket.hasRealized ? bucket.realized : null,
      count: bucket.count,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

function readableNetError(error) {
  const text = errText(error);
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return "请求超时";
  if (/abort/i.test(text)) return "请求被取消";
  if (/ENOTFOUND|dns/i.test(text)) return "域名解析失败";
  if (/ECONN|refused|reset/i.test(text)) return "连接失败";
  return text;
}

async function httpGet(api, url, options) {
  const opt = options || {};
  let res;
  try {
    res = await api.net.fetch(url, {
      method: "GET",
      headers: Object.assign({ "User-Agent": UA }, opt.headers || {}),
      timeoutMs: opt.timeoutMs || 15000,
      responseType: opt.gbk ? "arraybuffer" : "text",
    });
  } catch (error) {
    return { ok: false, error: "请求异常：" + readableNetError(error) };
  }
  if (!res) return { ok: false, error: "无响应" };
  if (res.error) return { ok: false, error: readableNetError(res.error) };
  if (!res.ok) return { ok: false, error: "HTTP " + res.status + " " + (res.statusText || "") };

  if (opt.gbk) {
    if (!res.bodyBase64) return { ok: false, error: "响应缺少二进制正文" };
    try {
      return { ok: true, text: decodeGbk(res.bodyBase64), status: res.status };
    } catch (error) {
      return { ok: false, error: "GBK 解码失败：" + errText(error) };
    }
  }
  return { ok: true, text: res.body || "", status: res.status };
}

/* ------------------------------------------------------------------ */
/* 数据源                                                              */
/* ------------------------------------------------------------------ */

/** 单只基金最新净值（Kimi automation.py 同款接口）。 */
async function fetchFundQuote(api, fund) {
  const url =
    "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" +
    encodeURIComponent(fund.code) +
    "&pageIndex=1&pageSize=1";
  const res = await httpGet(api, url, {
    headers: { Referer: "https://fundf10.eastmoney.com/" },
    timeoutMs: 12000,
  });
  if (!res.ok) return Object.assign({}, fund, { error: res.error });

  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch (error) {
    return Object.assign({}, fund, { error: "返回不是 JSON" });
  }
  const rows = (payload && payload.Data && payload.Data.LSJZList) || [];
  const row = rows[0];
  if (!row) return Object.assign({}, fund, { error: "无净值记录" });

  return Object.assign({}, fund, {
    nav: toNum(row.DWJZ),
    navDate: row.FSRQ || null,
    dayChangePct: toNum(row.JZZZL),
  });
}

/** 基金历史净值（pageSize 上限 20，按日期去重排序）。 */
async function fetchFundHistory(api, code, days) {
  const pages = Math.max(1, Math.ceil(days / FUND_PAGE_SIZE));
  const bucket = {};
  for (let page = 1; page <= pages; page += 1) {
    const url =
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" +
      encodeURIComponent(code) +
      "&pageIndex=" +
      page +
      "&pageSize=" +
      FUND_PAGE_SIZE;
    const res = await httpGet(api, url, {
      headers: { Referer: "https://fundf10.eastmoney.com/" },
      timeoutMs: 12000,
    });
    if (!res.ok) return { error: res.error, points: [] };

    let payload;
    try {
      payload = JSON.parse(res.text);
    } catch (error) {
      return { error: "返回不是 JSON", points: [] };
    }
    const list = (payload && payload.Data && payload.Data.LSJZList) || [];
    if (!list.length) break;
    list.forEach((row) => {
      const value = toNum(row.DWJZ);
      if (value !== null && row.FSRQ) bucket[row.FSRQ] = value;
    });
    if (list.length < FUND_PAGE_SIZE) break;
  }

  const dates = Object.keys(bucket).sort();
  const points = dates.slice(-days).map((date) => ({ date: date, value: bucket[date] }));
  if (!points.length) return { error: "无历史净值", points: [] };
  return { points: points };
}

/** 批量实时行情（GBK）。 */
async function fetchStockQuotes(api, list) {
  if (!list.length) return [];
  const symbols = list.map((item) => item.symbol).join(",");
  const res = await httpGet(api, "https://qt.gtimg.cn/q=" + symbols, {
    gbk: true,
    headers: { Referer: "https://gu.qq.com/" },
    timeoutMs: 12000,
  });
  if (!res.ok) return list.map((item) => Object.assign({}, item, { error: res.error }));

  const parsed = {};
  const pattern = /v_([A-Za-z0-9_.]+)="([^"]*)"/g;
  let match = pattern.exec(res.text);
  while (match !== null) {
    const fields = match[2].split("~");
    const price = toNum(fields[3]);
    const prevClose = toNum(fields[4]);
    const calcPct = price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    const change = toNum(fields[31]);
    const changePct = toNum(fields[32]);
    parsed[match[1].toLowerCase()] = {
      name: fields[1] || "",
      fullCode: fields[2] || "",
      price: price,
      prevClose: prevClose,
      open: toNum(fields[5]),
      high: toNum(fields[33]),
      low: toNum(fields[34]),
      change: change === null && price !== null && prevClose !== null ? price - prevClose : change,
      changePct: changePct === null ? calcPct : changePct,
      time: fields[30] || "",
    };
    match = pattern.exec(res.text);
  }

  return list.map((item) => {
    const quote = parsed[String(item.symbol).toLowerCase()];
    return quote ? Object.assign({}, item, quote) : Object.assign({}, item, { error: "无行情" });
  });
}

/** 日 K 线：美股需带交易所后缀；域名 ifzq → web.ifzq 回退。 */
async function fetchStockHistory(api, item, days) {
  const symbol = String(item.symbol || "");
  const candidates = [];
  if (/^us/i.test(symbol)) {
    const hint = String(item.fullCode || "");
    if (hint && hint.indexOf(".") > 0) candidates.push("us" + hint);
    const ticker = symbol.slice(2).toUpperCase();
    candidates.push("us" + ticker + ".OQ", "us" + ticker + ".N", "us" + ticker + ".A");
  } else {
    candidates.push(symbol);
  }

  let lastError = "无 K 线数据";
  for (let c = 0; c < candidates.length; c += 1) {
    const code = candidates[c];
    for (let b = 0; b < KLINE_BASES.length; b += 1) {
      const url =
        KLINE_BASES[b] +
        "/appstock/app/fqkline/get?param=" +
        encodeURIComponent(code) +
        ",day,,," +
        days +
        ",qfq";
      const res = await httpGet(api, url, { timeoutMs: 12000 });
      if (!res.ok) {
        lastError = res.error;
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(res.text);
      } catch (error) {
        lastError = "返回不是 JSON";
        continue;
      }
      if (!payload || payload.code !== 0 || !payload.data) {
        lastError = (payload && payload.msg) || "接口返回异常";
        break;
      }
      const node = payload.data[code] || payload.data[Object.keys(payload.data)[0]];
      const rows = node ? node.qfqday || node.day || [] : [];
      if (!rows.length) {
        lastError = "无 K 线数据";
        break;
      }
      const points = [];
      rows.forEach((row) => {
        const date = row[0];
        const close = toNum(row[2]);
        if (date && close !== null) {
          points.push({
            date: date,
            value: close,
            open: toNum(row[1]),
            high: toNum(row[3]),
            low: toNum(row[4]),
          });
        }
      });
      if (!points.length) {
        lastError = "无 K 线数据";
        break;
      }
      return { points: points.slice(-days), code: code, base: KLINE_BASES[b] };
    }
  }
  return { error: lastError, points: [] };
}

/** 分时（东财 trends2）：A股/指数/美股/港股通用。 */
async function fetchIntraday(api, secid) {
  if (!secid) return { error: "该标的无分时", points: [] };
  const url =
    TRENDS_BASE +
    "/api/qt/stock/trends2/get?secid=" +
    encodeURIComponent(secid) +
    "&fields1=f1,f2,f3&fields2=f51,f53&ndays=1";
  const res = await httpGet(api, url, { timeoutMs: 10000 });
  if (!res.ok) return { error: res.error, points: [] };

  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch (error) {
    return { error: "返回不是 JSON", points: [] };
  }
  const data = payload && payload.data;
  const rows = (data && data.trends) || [];
  const points = [];
  rows.forEach((row) => {
    const comma = String(row).indexOf(",");
    if (comma < 0) return;
    const stamp = String(row).slice(0, comma);
    const value = toNum(String(row).slice(comma + 1));
    if (value === null) return;
    points.push({
      date: stamp.slice(0, 10),
      label: stamp.slice(11, 16),
      value: value,
    });
  });
  if (!points.length) return { error: "无分时数据", points: [] };
  return { points: points, prevClose: toNum(data && data.preClose) };
}

/** 加密货币：币安公共数据域名。api.binance.com 在部分出口返回 451，data-api 未被封锁。 */
async function fetchCryptoQuotes(api, list) {
  if (!list.length) return [];
  const symbols = "[" + list.map((item) => '"' + item.symbol.toUpperCase() + '"').join(",") + "]";
  const url = CRYPTO_BASE + "/api/v3/ticker/24hr?symbols=" + encodeURIComponent(symbols);
  const res = await httpGet(api, url, { timeoutMs: 12000 });
  if (!res.ok) return list.map((item) => Object.assign({}, item, { error: res.error }));

  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch (error) {
    return list.map((item) => Object.assign({}, item, { error: "返回不是 JSON" }));
  }
  const rows = Array.isArray(payload) ? payload : [];
  const parsed = {};
  rows.forEach((row) => {
    if (!row || !row.symbol) return;
    parsed[String(row.symbol).toUpperCase()] = {
      price: toNum(row.lastPrice),
      prevClose: toNum(row.prevClosePrice),
      open: toNum(row.openPrice),
      high: toNum(row.highPrice),
      low: toNum(row.lowPrice),
      change: toNum(row.priceChange),
      changePct: toNum(row.priceChangePercent),
      quoteVolume: toNum(row.quoteVolume),
    };
  });
  return list.map((item) => {
    const quote = parsed[String(item.symbol).toUpperCase()];
    return quote ? Object.assign({}, item, quote) : Object.assign({}, item, { error: "无行情" });
  });
}

async function fetchCryptoKlines(api, symbol, mode, range) {
  const interval = mode === "intraday" ? "5m" : "1d";
  const limit = mode === "intraday" ? 288 : range;
  const url =
    CRYPTO_BASE +
    "/api/v3/klines?symbol=" +
    encodeURIComponent(String(symbol).toUpperCase()) +
    "&interval=" +
    interval +
    "&limit=" +
    limit;
  const res = await httpGet(api, url, { timeoutMs: 12000 });
  if (!res.ok) return { error: res.error, points: [] };

  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch (error) {
    return { error: "返回不是 JSON", points: [] };
  }
  if (!Array.isArray(rows) || !rows.length) return { error: "无 K 线数据", points: [] };

  const pad = (n) => (n < 10 ? "0" + n : String(n));
  const points = [];
  rows.forEach((row) => {
    const openTime = Number(row[0]);
    const value = toNum(row[4]);
    if (!Number.isFinite(openTime) || value === null) return;
    const date = new Date(openTime);
    points.push({
      date: date.toISOString().slice(0, 10),
      label: pad(date.getHours()) + ":" + pad(date.getMinutes()),
      value: value,
      open: toNum(row[1]),
      high: toNum(row[2]),
      low: toNum(row[3]),
      volume: toNum(row[5]),
    });
  });
  return { points: points };
}

/** 标的搜索（腾讯智能联想）。 */
async function searchInstruments(api, query) {
  const text = String(query || "").trim();
  if (!text) return [];
  const res = await httpGet(api, SEARCH_BASE + "/s3/?t=all&q=" + encodeURIComponent(text), {
    timeoutMs: 8000,
  });
  if (!res.ok) return [];

  const match = /v_hint="([^"]*)"/.exec(res.text);
  if (!match || !match[1]) return [];

  const decoded = match[1].replace(/\\u([0-9a-fA-F]{4})/g, (all, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  const out = [];
  const seen = {};
  decoded
    .split("^")
    .filter(Boolean)
    .forEach((record) => {
      const parts = record.split("~");
      if (parts.length < 3) return;
      const market = String(parts[0] || "").toLowerCase();
      const code = String(parts[1] || "");
      const name = String(parts[2] || "");
      if (!market || !code || !name) return;

      let symbol = "";
      if (market === "sh" || market === "sz" || market === "bj") symbol = market + code;
      else if (market === "us") symbol = "us" + code.split(".")[0].toUpperCase();
      else if (market === "hk" && /^\d+$/.test(code)) symbol = "hk" + code.padStart(5, "0");
      else return;

      if (seen[symbol]) return;
      seen[symbol] = true;
      out.push({ market: market, symbol: symbol, name: name, kind: parts[4] || "" });
    });
  return out.slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* 图标（内联 SVG，不再用文本符号当按钮）                               */
/* ------------------------------------------------------------------ */

function createH() {
  return window.SnowAppPlugin.React.createElement;
}

function Icon(props) {
  const h = createH();
  const d = props.d || "";
  return h(
    "svg",
    {
      className: "sp-icon",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    h("path", { d: d }),
  );
}

const ICONS = {
  refresh: "M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-9.44l6.57-2.13",
  palette: "M12 21a9 9 0 1 1 9-9c0 2.5-1.5 3.5-3 3.5h-2a2 2 0 0 0-1.5 3.3c.5.6 0 2.2-1.5 2.2z M7.5 10.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M10.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M14.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M16.5 10.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  plus: "M12 5v14M5 12h14",
};

/* ------------------------------------------------------------------ */
/* 图表：折线（含基准线，零填充避免截断误导）                            */
/* ------------------------------------------------------------------ */

let CHART_SEQ = 0;

function chartDomain(values, baseline) {
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  if (baseline !== null && baseline !== undefined) {
    min = Math.min(min, baseline);
    max = Math.max(max, baseline);
  }
  if (max === min) {
    max = min + 1;
    min = min - 1;
  }
  // 零填充 15%，避免贴近边缘且防止小波动被放大成剧烈走势
  const pad = (max - min) * 0.15;
  return { min: min - pad, max: max + pad };
}

function SparkChart(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState, useRef } = R;
  const points = props.points || [];
  const digits = props.digits === undefined ? 2 : props.digits;
  const height = props.height || 140;
  const colors = upDownColors(props.colorMode);
  const baseline = toNum(props.baseline);
  const [hover, setHover] = useState(-1);
  const gidRef = useRef("");
  if (!gidRef.current) {
    CHART_SEQ += 1;
    gidRef.current = "spg" + CHART_SEQ;
  }
  const gid = gidRef.current;

  if (points.length < 2) {
    return h(
      "div",
      { className: "sp-chart-empty", style: { height: height + "px" } },
      props.loading ? "加载走势…" : props.error || "暂无走势数据",
    );
  }

  const values = points.map((point) => point.value);
  const domain = chartDomain(values, baseline);
  const min = domain.min;
  const max = domain.max;

  const W = 600;
  const H = 200;
  const xOf = (index) => (points.length === 1 ? 0 : (index / (points.length - 1)) * W);
  const yOf = (value) => H - ((value - min) / (max - min)) * H;

  let path = "";
  points.forEach((point, index) => {
    path += (index === 0 ? "M" : "L") + xOf(index).toFixed(2) + " " + yOf(point.value).toFixed(2) + " ";
  });
  const area = path + "L" + W + " " + H + " L0 " + H + " Z";

  const first = points[0];
  const last = points[points.length - 1];
  const anchor = baseline === null ? first.value : baseline;
  const delta = anchor ? ((last.value - anchor) / anchor) * 100 : null;
  const stroke = last.value >= anchor ? colors.up : colors.down;
  const hoverPoint = hover >= 0 ? points[hover] : null;

  const handleMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    let index = Math.round(ratio * (points.length - 1));
    if (index < 0) index = 0;
    if (index > points.length - 1) index = points.length - 1;
    setHover(index);
  };

  return h(
    "div",
    { className: "sp-chart" },
    h(
      "div",
      { className: "sp-chart-wrap", style: { height: height + "px" } },
      h(
        "svg",
        {
          className: "sp-chart-svg",
          viewBox: "0 0 " + W + " " + H,
          preserveAspectRatio: "none",
          onMouseMove: handleMove,
          onMouseLeave: () => setHover(-1),
        },
        h(
          "defs",
          null,
          h(
            "linearGradient",
            { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" },
            h("stop", { offset: "0%", stopColor: stroke, stopOpacity: "0.22" }),
            h("stop", { offset: "100%", stopColor: stroke, stopOpacity: "0" }),
          ),
        ),
        [0.25, 0.5, 0.75].map((ratio) =>
          h("line", {
            key: "g" + ratio,
            x1: 0,
            x2: W,
            y1: H * ratio,
            y2: H * ratio,
            className: "sp-chart-grid",
            vectorEffect: "non-scaling-stroke",
          }),
        ),
        baseline !== null
          ? h("line", {
              x1: 0,
              x2: W,
              y1: yOf(baseline),
              y2: yOf(baseline),
              className: "sp-chart-base",
              vectorEffect: "non-scaling-stroke",
            })
          : null,
        h("path", { d: area, fill: "url(#" + gid + ")", stroke: "none" }),
        h("path", {
          d: path,
          fill: "none",
          stroke: stroke,
          strokeWidth: 1.8,
          strokeLinejoin: "round",
          vectorEffect: "non-scaling-stroke",
        }),
        hoverPoint
          ? h("line", {
              x1: xOf(hover),
              x2: xOf(hover),
              y1: 0,
              y2: H,
              className: "sp-chart-cursor",
              vectorEffect: "non-scaling-stroke",
            })
          : null,
        hoverPoint
          ? h("circle", {
              cx: xOf(hover),
              cy: yOf(hoverPoint.value),
              r: 3,
              fill: stroke,
              stroke: "#fff",
              strokeWidth: 1,
              vectorEffect: "non-scaling-stroke",
            })
          : null,
      ),
      h(
        "div",
        { className: "sp-chart-axis" },
        h("span", null, fmtNum(max, digits)),
        h("span", null, fmtNum(min, digits)),
      ),
      hoverPoint
        ? h(
            "div",
            { className: "sp-chart-tip" },
            h("span", { className: "sp-chart-tip-date" }, hoverPoint.label || hoverPoint.date),
            h("span", { className: "sp-chart-tip-val" }, fmtNum(hoverPoint.value, digits)),
          )
        : h(
            "div",
            { className: "sp-chart-tip sp-chart-tip-static" },
            h("span", { className: "sp-chart-tip-date" }, last.label || last.date),
            h("span", { className: "sp-chart-tip-val" }, fmtNum(last.value, digits)),
          ),
    ),
    h(
      "div",
      { className: "sp-chart-foot" },
      h(
        "span",
        { className: "sp-dim" },
        baseline === null
          ? (first.label || first.date) + " → " + (last.label || last.date)
          : "昨收 " + fmtNum(baseline, digits),
      ),
      h(
        "span",
        { className: "sp-mono " + trendClass(delta) },
        (baseline === null ? "区间 " : "较昨收 ") + fmtPct(delta) + " · " + points.length + " 点",
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 图表：日 K 蜡烛                                                     */
/* ------------------------------------------------------------------ */

function CandleChart(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState } = R;
  const colors = upDownColors(props.colorMode);
  const height = props.height || 140;
  const digits = props.digits === undefined ? 2 : props.digits;
  const raw = props.points || [];
  const points = raw.filter(
    (point) =>
      toNum(point.open) !== null &&
      toNum(point.high) !== null &&
      toNum(point.low) !== null &&
      toNum(point.value) !== null,
  );
  const [hover, setHover] = useState(-1);

  if (points.length < 2) {
    return h(
      "div",
      { className: "sp-chart-empty", style: { height: height + "px" } },
      props.loading ? "加载走势…" : props.error || "暂无 K 线数据",
    );
  }

  let min = Infinity;
  let max = -Infinity;
  points.forEach((point) => {
    min = Math.min(min, toNum(point.low));
    max = Math.max(max, toNum(point.high));
  });
  const pad = (max - min) * 0.08 || 1;
  min -= pad;
  max += pad;

  const W = 600;
  const H = 200;
  const step = W / points.length;
  const bodyWidth = Math.max(2, step * 0.72);
  const yOf = (value) => H - ((value - min) / (max - min)) * H;

  const handleMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    let index = Math.floor(ratio * points.length);
    if (index < 0) index = 0;
    if (index > points.length - 1) index = points.length - 1;
    setHover(index);
  };

  const hoverPoint = hover >= 0 ? points[hover] : null;
  const first = points[0];
  const last = points[points.length - 1];
  const delta = first.value ? ((last.value - first.value) / first.value) * 100 : null;

  return h(
    "div",
    { className: "sp-chart" },
    h(
      "div",
      { className: "sp-chart-wrap", style: { height: height + "px" } },
      h(
        "svg",
        {
          className: "sp-chart-svg",
          viewBox: "0 0 " + W + " " + H,
          preserveAspectRatio: "none",
          onMouseMove: handleMove,
          onMouseLeave: () => setHover(-1),
        },
        [0.25, 0.5, 0.75].map((ratio) =>
          h("line", {
            key: "g" + ratio,
            x1: 0,
            x2: W,
            y1: H * ratio,
            y2: H * ratio,
            className: "sp-chart-grid",
            vectorEffect: "non-scaling-stroke",
          }),
        ),
        points.map((point, index) => {
          const open = toNum(point.open);
          const close = toNum(point.value);
          const high = toNum(point.high);
          const low = toNum(point.low);
          const rising = close >= open;
          const color = rising ? colors.up : colors.down;
          const x = (index + 0.5) * step;
          const top = yOf(Math.max(open, close));
          const bottom = yOf(Math.min(open, close));
          // A 股惯例：阳线（涨）空心，阴线（跌）实心
          return h(
            "g",
            { key: "c" + index },
            h("line", {
              x1: x,
              x2: x,
              y1: yOf(high),
              y2: yOf(low),
              stroke: color,
              strokeWidth: 1.2,
              vectorEffect: "non-scaling-stroke",
            }),
            h("rect", {
              x: x - bodyWidth / 2,
              y: top,
              width: bodyWidth,
              height: Math.max(bottom - top, 1),
              fill: rising ? "transparent" : color,
              stroke: color,
              strokeWidth: rising ? 1.2 : 0,
              vectorEffect: "non-scaling-stroke",
            }),
          );
        }),
        hoverPoint
          ? h("line", {
              x1: (hover + 0.5) * step,
              x2: (hover + 0.5) * step,
              y1: 0,
              y2: H,
              className: "sp-chart-cursor",
              vectorEffect: "non-scaling-stroke",
            })
          : null,
      ),
      h(
        "div",
        { className: "sp-chart-axis" },
        h("span", null, fmtNum(max, digits)),
        h("span", null, fmtNum(min, digits)),
      ),
      hoverPoint
        ? h(
            "div",
            { className: "sp-chart-tip" },
            h("span", { className: "sp-chart-tip-date" }, shortDate(hoverPoint.date)),
            h(
              "span",
              { className: "sp-chart-tip-val" },
              "开 " + fmtNum(hoverPoint.open, digits) + " 收 " + fmtNum(hoverPoint.value, digits),
            ),
          )
        : h(
            "div",
            { className: "sp-chart-tip sp-chart-tip-static" },
            h("span", { className: "sp-chart-tip-date" }, shortDate(last.date)),
            h("span", { className: "sp-chart-tip-val" }, fmtNum(last.value, digits)),
          ),
    ),
    h(
      "div",
      { className: "sp-chart-foot" },
      hoverPoint
        ? h(
            "span",
            { className: "sp-dim" },
            "高 " + fmtNum(hoverPoint.high, digits) + " · 低 " + fmtNum(hoverPoint.low, digits),
          )
        : h("span", { className: "sp-dim" }, shortDate(first.date) + " → " + shortDate(last.date)),
      h("span", { className: "sp-mono " + trendClass(delta) }, "区间 " + fmtPct(delta) + " · " + points.length + " 根"),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 通用小部件                                                          */
/* ------------------------------------------------------------------ */

function useAutoRefresh(R, callbackRef, isActive, autoRefresh, intervalMs) {
  R.useEffect(() => {
    if (!isActive || !autoRefresh || !intervalMs) return undefined;
    const timer = setInterval(() => {
      const fn = callbackRef.current;
      if (fn) fn();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [isActive, autoRefresh, intervalMs]);
}

function useClock(R) {
  const { useState, useEffect } = R;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function renderError(h, message) {
  if (!message) return null;
  return h("div", { className: "sp-error", role: "alert" }, message);
}

function renderEmpty(h, text) {
  return h("div", { className: "sp-empty" }, text);
}

function renderRangeBar(h, value, onChange) {
  return h(
    "div",
    { className: "sp-range", role: "tablist" },
    RANGES.map((days) =>
      h(
        "button",
        {
          key: days,
          role: "tab",
          "aria-selected": value === days,
          className: "sp-range-btn" + (value === days ? " sp-range-on" : ""),
          onClick: () => onChange(days),
        },
        days + "D",
      ),
    ),
  );
}

function renderModeBar(h, mode, onChange) {
  return h(
    "div",
    { className: "sp-range", role: "tablist" },
    h(
      "button",
      {
        role: "tab",
        "aria-selected": mode === "intraday",
        className: "sp-range-btn" + (mode === "intraday" ? " sp-range-on" : ""),
        onClick: () => onChange("intraday"),
      },
      "分时",
    ),
    h(
      "button",
      {
        role: "tab",
        "aria-selected": mode === "daily",
        className: "sp-range-btn" + (mode === "daily" ? " sp-range-on" : ""),
        onClick: () => onChange("daily"),
      },
      "日K",
    ),
  );
}

function SessionBadge(props) {
  const h = window.SnowAppPlugin.React.createElement;
  const session = props.session;
  if (!session) return null;
  return h(
    "span",
    { className: "sp-session", title: "按交易所当地时区计算" },
    h("i", { className: "sp-dot", style: { background: session.color } }),
    session.label,
  );
}

/** 持仓块：展示成本/浮盈/已实现，并提供买入、卖出、校正。可折叠。 */
function TradeBox(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState, useEffect } = R;
  const { holding, price, currency, digits, itemKey, holdings, itemName, externalOpen } = props;
  const [mode, setMode] = useState("");
  const [sizeText, setSizeText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [costText, setCostText] = useState("");
  const position = positionOf(holding, price);

  useEffect(() => {
    setMode("");
  }, [itemKey]);

  // 行内「记仓」按钮通过 externalOpen 直达买入表单
  useEffect(() => {
    if (externalOpen) open("buy");
  }, [externalOpen]);

  const open = (nextMode) => {
    setMode(nextMode);
    setSizeText(holding && holding.size !== undefined ? String(holding.size) : "");
    setPriceText(price === null || price === undefined ? "" : String(price));
    const cost = avgCostOf(holding);
    setCostText(cost === null ? "" : String(cost));
  };

  const commit = (next) => {
    const all = Object.assign({}, holdings || {});
    if (!next) {
      delete all[itemKey];
    } else if (next.size > 0) {
      all[itemKey] = next;
    } else if (toNum(next.realizedPnl)) {
      all[itemKey] = {
        size: 0,
        avgCost: null,
        realizedPnl: next.realizedPnl,
        updatedAt: next.updatedAt || Date.now(),
      };
    } else {
      delete all[itemKey];
    }
    props.onPersist(all);
    setMode("");
  };

  const submit = () => {
    if (mode === "adjust") {
      const size = toNum(sizeText);
      const cost = toNum(costText);
      if (size === null || size < 0) {
        props.onError("份额不能为负");
        return;
      }
      if (size === 0) {
        commit(null);
        return;
      }
      commit({
        size: size,
        avgCost: cost,
        realizedPnl: holding ? toNum(holding.realizedPnl) || 0 : 0,
        updatedAt: Date.now(),
      });
      return;
    }
    const size = toNum(sizeText);
    const tradePrice = toNum(priceText);
    if (size === null || size <= 0) {
      props.onError("数量必须大于 0");
      return;
    }
    if (tradePrice === null || tradePrice <= 0) {
      props.onError("价格必须大于 0");
      return;
    }
    const next = applyTrade(holding, mode === "sell" ? "sell" : "buy", size, tradePrice);
    if (!next) {
      props.onError("卖出数量超过当前持仓");
      return;
    }
    commit(next);
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") setMode("");
  };

  // 表单头：显示「标的 · 操作」，让表单自解释
  const formLabel = h(
    "span",
    { className: "sp-pos-formhead" },
    h("span", { className: "sp-pos-formname" }, itemName || itemKey),
    h(
      "span",
      { className: "sp-pos-tag" },
      mode === "adjust" ? "校正" : mode === "sell" ? "卖出" : "买入",
    ),
  );

  if (mode) {
    const isAdjust = mode === "adjust";
    return h(
      "div",
      { className: "sp-pos sp-pos-edit" },
      formLabel,
      h("input", {
        className: "sp-input sp-input-mini",
        placeholder: isAdjust ? "份额" : "数量",
        value: sizeText,
        onChange: (event) => setSizeText(event.target.value),
        onKeyDown: onKeyDown,
        autoFocus: true,
        "aria-label": isAdjust ? "份额" : "数量",
      }),
      isAdjust
        ? h("input", {
            className: "sp-input sp-input-mini",
            placeholder: "均价（可空）",
            value: costText,
            onChange: (event) => setCostText(event.target.value),
            onKeyDown: onKeyDown,
            "aria-label": "均价",
          })
        : h("input", {
            className: "sp-input sp-input-mini",
            placeholder: "成交价",
            value: priceText,
            onChange: (event) => setPriceText(event.target.value),
            onKeyDown: onKeyDown,
            "aria-label": "成交价",
          }),
      h(
        "div",
        { className: "sp-pos-actions" },
        h("button", { className: "sp-btn sp-btn-primary", onClick: submit }, "确认"),
        h("button", { className: "sp-btn", onClick: () => setMode("") }, "取消"),
      ),
    );
  }

  if (!position) {
    // 空仓：不渲染持仓条（行内「记仓」已是唯一记仓入口）；
    // 但若历史上有过已实现盈亏（已清仓），保留一行只读小字提示。
    const realized = holding ? toNum(holding.realizedPnl) : null;
    if (!realized) return null;
    return h(
      "div",
      { className: "sp-pos sp-pos-realized-only" },
      h(
        "span",
        { className: "sp-pos-item " + trendClass(realized) },
        h("span", { className: "sp-dim" }, "已实现 "),
        h("span", { className: "sp-mono" }, (realized > 0 ? "+" : "") + fmtMoney(realized, currency)),
      ),
    );
  }

  return h(
    "div",
    { className: "sp-pos" },
    h(
      "span",
      { className: "sp-pos-item" },
      h("span", { className: "sp-dim" }, "份额 "),
      h("span", { className: "sp-mono" }, fmtNum(position.size, position.size % 1 === 0 ? 0 : 2)),
    ),
    position.avgCost !== null
      ? h(
          "span",
          { className: "sp-pos-item" },
          h("span", { className: "sp-dim" }, "均价 "),
          h("span", { className: "sp-mono" }, fmtNum(position.avgCost, digits)),
        )
      : null,
    position.marketValue !== null
      ? h(
          "span",
          { className: "sp-pos-item" },
          h("span", { className: "sp-dim" }, "市值 "),
          h("span", { className: "sp-mono" }, fmtMoney(position.marketValue, currency)),
        )
      : null,
    position.pnl !== null
      ? h(
          "span",
          { className: "sp-pos-item " + trendClass(position.pnl) },
          h("span", { className: "sp-dim" }, "浮盈 "),
          h("span", { className: "sp-mono" }, (position.pnl > 0 ? "+" : "") + fmtMoney(position.pnl, currency)),
          h("span", { className: "sp-mono sp-small" }, " (" + fmtPct(position.ratio) + ")"),
        )
      : null,
    position.realizedPnl
      ? h(
          "span",
          { className: "sp-pos-item " + trendClass(position.realizedPnl) },
          h("span", { className: "sp-dim" }, "已实现 "),
          h(
            "span",
            { className: "sp-mono" },
            (position.realizedPnl > 0 ? "+" : "") + fmtMoney(position.realizedPnl, currency),
          ),
        )
      : null,
    h(
      "span",
      { className: "sp-pos-actions" },
      h("button", { className: "sp-link-btn", onClick: () => open("buy") }, "买入"),
      h("button", { className: "sp-link-btn", onClick: () => open("sell") }, "卖出"),
      h("button", { className: "sp-link-btn", onClick: () => open("adjust") }, "校正"),
    ),
  );
}

/** 组合总览卡片：总资产、总浮盈、总已实现。 */
function PortfolioCard(props) {
  const h = window.SnowAppPlugin.React.createElement;
  const buckets = props.buckets || [];
  if (!buckets.length) return null;

  const totals = {};
  buckets.forEach((bucket) => {
    if (!totals[bucket.currency]) {
      totals[bucket.currency] = { marketValue: 0, pnl: 0, realized: 0, count: 0 };
    }
    const t = totals[bucket.currency];
    if (bucket.marketValue !== null) t.marketValue += bucket.marketValue;
    if (bucket.pnl !== null) t.pnl += bucket.pnl;
    if (bucket.realized !== null) t.realized += bucket.realized;
    t.count += bucket.count || 0;
  });

  const primary = buckets[0];
  const total = totals[primary.currency] || {};
  const hasMixed = Object.keys(totals).length > 1;

  return h(
    "div",
    { className: "sp-portfolio" },
    h(
      "div",
      { className: "sp-portfolio-main" },
      h(
        "div",
        { className: "sp-portfolio-cell" },
        h("span", { className: "sp-portfolio-label" }, "总市值"),
        h(
          "span",
          { className: "sp-portfolio-value" },
          fmtMoney(total.marketValue, primary.currency),
        ),
      ),
      h(
        "div",
        { className: "sp-portfolio-cell" },
        h("span", { className: "sp-portfolio-label" }, "浮动盈亏"),
        h(
          "span",
          { className: "sp-portfolio-value " + trendClass(total.pnl) },
          (total.pnl > 0 ? "+" : "") + fmtMoney(total.pnl, primary.currency),
        ),
      ),
      total.realized
        ? h(
            "div",
            { className: "sp-portfolio-cell" },
            h("span", { className: "sp-portfolio-label" }, "已实现"),
            h(
              "span",
              { className: "sp-portfolio-value " + trendClass(total.realized) },
              (total.realized > 0 ? "+" : "") + fmtMoney(total.realized, primary.currency),
            ),
          )
        : null,
      h(
        "div",
        { className: "sp-portfolio-cell" },
        h("span", { className: "sp-portfolio-label" }, "持仓"),
        h("span", { className: "sp-portfolio-value" }, String(total.count || 0)),
      ),
    ),
    hasMixed
      ? h(
          "div",
          { className: "sp-portfolio-note" },
          "含 " + Object.keys(totals).length + " 种货币，未做汇率折算",
        )
      : null,
  );
}

function SummaryBar(props) {
  const h = window.SnowAppPlugin.React.createElement;
  const buckets = (props.buckets || []).slice().sort((a, b) => {
    const aVal = a.pnl === null ? -Infinity : Math.abs(a.pnl);
    const bVal = b.pnl === null ? -Infinity : Math.abs(b.pnl);
    return bVal - aVal;
  });
  if (!buckets.length) return null;
  return h(
    "div",
    { className: "sp-summary" },
    buckets.map((bucket) =>
      h(
        "div",
        { className: "sp-summary-row", key: bucket.currency },
        h("span", { className: "sp-summary-cur" }, bucket.currency),
        h(
          "span",
          { className: "sp-summary-cell" },
          h("span", { className: "sp-dim" }, "市值 "),
          h("span", { className: "sp-mono sp-strong" }, fmtMoney(bucket.marketValue, bucket.currency)),
        ),
        h(
          "span",
          { className: "sp-summary-cell" },
          h("span", { className: "sp-dim" }, "成本 "),
          h("span", { className: "sp-mono" }, fmtMoney(bucket.cost, bucket.currency)),
        ),
        h(
          "span",
          { className: "sp-summary-cell " + trendClass(bucket.pnl) },
          h("span", { className: "sp-dim" }, "浮盈 "),
          h(
            "span",
            { className: "sp-mono" },
            bucket.pnl === null ? "—" : (bucket.pnl > 0 ? "+" : "") + fmtMoney(bucket.pnl, bucket.currency),
          ),
          h("span", { className: "sp-mono sp-small" }, " (" + fmtPct(bucket.ratio) + ")"),
        ),
        bucket.realized
          ? h(
              "span",
              { className: "sp-summary-cell " + trendClass(bucket.realized) },
              h("span", { className: "sp-dim" }, "已实现 "),
              h(
                "span",
                { className: "sp-mono" },
                (bucket.realized > 0 ? "+" : "") + fmtMoney(bucket.realized, bucket.currency),
              ),
            )
          : null,
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 行情/基金通用视图                                                    */
/* ------------------------------------------------------------------ */

/**
 * 通用行情视图：基金（line）、股票（intraday/daily）、加密货币（intraday/daily）。
 * 用 props 注入数据源与格式化，避免三份几乎相同的代码。
 */
function MarketView(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState, useEffect, useRef, useCallback } = R;
  const api = props.api;
  const isActive = props.isActive !== false;
  const colorMode = props.colorMode || "red-up";
  const now = useClock(R);

  const [defs, setDefs] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [holdings, setHoldings] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastAt, setLastAt] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshMs, setRefreshMs] = useState(DEFAULT_REFRESH_MS);
  const [adding, setAdding] = useState(false);
  const [draftSymbol, setDraftSymbol] = useState("");
  const [draftName, setDraftName] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [pendingRemove, setPendingRemove] = useState("");
  const [selected, setSelected] = useState("");
  const [tradeToken, setTradeToken] = useState(0);
  const [range, setRange] = useState(60);
  const [chartMode, setChartMode] = useState(props.defaultChartMode || "daily");
  const [chart, setChart] = useState(null);
  const busyRef = useRef(false);
  const refreshRef = useRef(null);
  const refreshSeqRef = useRef(0);
  const cacheRef = useRef({});
  const searchTimer = useRef(null);

  useEffect(() => {
    let alive = true;
    api.storage
      .getJson(KEYS.settings, null)
      .then((saved) => {
        if (!alive || !saved) return;
        if (typeof saved.autoRefresh === "boolean") setAutoRefresh(saved.autoRefresh);
        if (typeof saved.refreshMs === "number" && REFRESH_OPTIONS.some((o) => o.value === saved.refreshMs)) {
          setRefreshMs(saved.refreshMs);
          setAutoRefresh(saved.refreshMs > 0);
        }
        if (RANGES.indexOf(saved[props.rangeKey]) !== -1) setRange(saved[props.rangeKey]);
        const savedMode = saved[props.chartModeKey];
        if (savedMode === "intraday" || savedMode === "daily") setChartMode(savedMode);
      })
      .catch(() => {});
    api.storage
      .getJson(KEYS.holdings, null)
      .then((saved) => {
        if (alive && saved && typeof saved === "object") setHoldings(saved);
      })
      .catch(() => {});
    api.storage
      .getJson(props.storageKey, null)
      .then((saved) => {
        if (!alive) return;
        const list = Array.isArray(saved) && saved.length ? saved : props.defaultList.slice();
        setDefs(list);
        setSelected(props.getKey(list[0]));
      })
      .catch(() => {
        if (!alive) return;
        setDefs(props.defaultList.slice());
        setSelected(props.getKey(props.defaultList[0]));
      });
    return () => {
      alive = false;
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [api]);

  const refresh = useCallback(async () => {
    const list = defs;
    if (!list || !list.length || busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError("");
    const fetchId = ++refreshSeqRef.current;
    try {
      const fetched = await props.fetchQuotes(api, list);
      // 竞态保护：只有最新的请求才更新状态
      if (fetchId !== refreshSeqRef.current) return;
      const next = {};
      let failed = 0;
      fetched.forEach((item) => {
        next[props.getKey(item)] = item;
        if (item.error) failed += 1;
      });
      setQuotes((prev) => Object.assign({}, prev, next));
      setLastAt(Date.now());
      if (failed) setError(failed + " / " + list.length + " 个标的无行情");
    } catch (err) {
      if (fetchId === refreshSeqRef.current) setError(errText(err));
    } finally {
      if (fetchId === refreshSeqRef.current) {
        setLoading(false);
        busyRef.current = false;
      }
    }
  }, [api, defs]);

  refreshRef.current = refresh;

  useEffect(() => {
    if (defs) refresh();
  }, [defs, refresh]);

  const selectedDef =
    defs && selected ? defs.find((item) => props.getKey(item) === selected) || defs[0] : null;
  const selectedQuote = selectedDef ? quotes[props.getKey(selectedDef)] || {} : {};
  const session = selectedDef
    ? getSession(props.sessionMarket ? props.sessionMarket(selectedDef) : "cn", now)
    : null;
  const pollMs = session && session.isOpen ? STOCK_OPEN_MS : STOCK_CLOSED_MS;

  // 用户选择的间隔优先；基金固定 5min（净值每日一更，无意义高频）
  const effectivePollMs = props.fixedPollMs || refreshMs || pollMs;

  useAutoRefresh(R, refreshRef, isActive, autoRefresh, effectivePollMs);

  useEffect(() => {
    if (!selectedDef) return undefined;
    const key = props.getKey(selectedDef);
    const cacheKey = key + "|" + chartMode + "|" + range;
    const ttl = chartMode === "intraday" ? INTRADAY_TTL_MS : 5 * 60 * 1000;
    const cached = cacheRef.current[cacheKey];
    if (cached && Date.now() - cached.at < ttl) {
      setChart(cached.payload);
      return () => {};
    }
    let alive = true;
    // 保留旧数据，只标 loading，避免切换时闪烁
    setChart((prev) =>
      prev && prev.points && prev.points.length
        ? Object.assign({}, prev, { loading: true })
        : { loading: true, points: [] },
    );
    props
      .fetchHistory(api, selectedDef, chartMode, range, quotes[key] || {})
      .then((result) => {
        if (!alive) return;
        const payload = {
          loading: false,
          points: result.points || [],
          prevClose: result.prevClose,
          error: result.error || "",
        };
        if (!result.error) cacheRef.current[cacheKey] = { at: Date.now(), payload: payload };
        setChart(payload);
      })
      .catch((err) => {
        if (alive)
          setChart((prev) => ({
            loading: false,
            points: (prev && prev.points) || [],
            error: errText(err),
          }));
      });
    return () => {
      alive = false;
    };
  }, [api, selectedDef, chartMode, range, quotes]);

  const persistHoldings = (next) => {
    setHoldings(next);
    api.storage.setJson(KEYS.holdings, next).catch((err) => setError(errText(err)));
  };

  const persistDefs = (list) => {
    setDefs(list);
    api.storage.setJson(props.storageKey, list).catch((err) => setError(errText(err)));
  };

  const toggleAuto = (checked) => {
    setAutoRefresh(checked);
    api.storage
      .getJson(KEYS.settings, {})
      .then((saved) =>
        api.storage.setJson(KEYS.settings, Object.assign({}, saved || {}, { autoRefresh: checked })),
      )
      .catch(() => {});
  };

  const changeRefreshMs = (value) => {
    const ms = Number(value);
    if (!REFRESH_OPTIONS.some((o) => o.value === ms)) return;
    setRefreshMs(ms);
    const on = ms > 0;
    setAutoRefresh(on);
    api.storage
      .getJson(KEYS.settings, {})
      .then((saved) =>
        api.storage.setJson(
          KEYS.settings,
          Object.assign({}, saved || {}, { refreshMs: ms, autoRefresh: on }),
        ),
      )
      .catch(() => {});
  };

  const changeRange = (days) => {
    setRange(days);
    api.storage
      .getJson(KEYS.settings, {})
      .then((saved) =>
        api.storage.setJson(KEYS.settings, Object.assign({}, saved || {}, { [props.rangeKey]: days })),
      )
      .catch(() => {});
  };

  const changeChartMode = (mode) => {
    setChartMode(mode);
    api.storage
      .getJson(KEYS.settings, {})
      .then((saved) =>
        api.storage.setJson(KEYS.settings, Object.assign({}, saved || {}, { [props.chartModeKey]: mode })),
      )
      .catch(() => {});
  };

  const onSearchChange = (text) => {
    setDraftSymbol(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const query = text.trim();
    if (!query) {
      setResults([]);
      setSearching(false);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const list = await props.search(api, query);
        setResults(list);
      } catch (err) {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
  };

  const addItem = () => {
    const symbol = props.normalize(draftSymbol);
    if (!symbol) {
      setError(props.invalidTip || "请输入有效的代码");
      return;
    }
    if (!defs) return;
    if (defs.some((item) => props.getKey(item).toLowerCase() === symbol.toLowerCase())) {
      setError("该标的已在列表中");
      return;
    }
    setError("");
    const item = props.createItem(symbol, draftName.trim());
    persistDefs(defs.concat([item]));
    setDraftSymbol("");
    setDraftName("");
    setResults([]);
    setAdding(false);
    setSelected(props.getKey(item));
  };

  const removeItem = (symbol) => {
    if (!defs) return;
    const next = defs.filter((item) => props.getKey(item) !== symbol);
    persistDefs(next);
    setPendingRemove("");
    if (selected === symbol && next.length) setSelected(props.getKey(next[0]));
  };

  if (!defs) {
    return h(
      "div",
      { className: "sp-view" },
      h(
        "div",
        { className: "sp-empty-state" },
        h("div", { className: "sp-empty-icon" }, "📈"),
        h("div", { className: "sp-empty-title" }, "还没有关注任何标的"),
        h("div", { className: "sp-empty-hint" }, "点击下方按钮，添加你的第一只基金、股票或币种"),
        h(
          "button",
          {
            className: "sp-btn sp-btn-primary",
            onClick: () => setAdding(true),
          },
          props.addLabel,
        ),
      ),
    );
  }

  const buckets = summarizePositions(
    defs.map((item) => {
      const key = props.getKey(item);
      const holding = holdings[props.holdingPrefix + key];
      return {
        currency: props.currencyOf(item),
        position: positionOf(holding, props.priceOf(quotes[key] || {})),
        realized: holding ? holding.realizedPnl : null,
      };
    }),
  );

  const groups = [];
  defs.forEach((item) => {
    const name = props.groupOf(item);
    let group = groups.find((entry) => entry.name === name);
    if (!group) {
      group = { name: name, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });

  const chartTitle = h(
    "div",
    { className: "sp-chart-head" },
    h(
      "div",
      { className: "sp-chart-id" },
      h(
        "div",
        { className: "sp-chart-title-row" },
        h("span", { className: "sp-chart-name" }, props.nameOf(selectedDef, selectedQuote)),
        session ? h(SessionBadge, { session: session }) : null,
      ),
      h(
        "div",
        { className: "sp-chart-price-row" },
        h(
          "span",
          { className: "sp-chart-value sp-mono " + trendClass(props.pctOf(selectedQuote)) },
          h(AnimatedNumber, {
            value: props.priceOf(selectedQuote),
            digits: props.digitsOf(selectedQuote),
          }),
        ),
        h(
          "span",
          { className: "sp-change-badge " + badgeClass(props.pctOf(selectedQuote)) },
          h(AnimatedNumber, {
            value: props.pctOf(selectedQuote),
            format: (v) => fmtPct(v) + props.pctSuffix,
          }),
        ),
      ),
    ),
    h(
      "div",
      { className: "sp-chart-tools" },
      props.hasChartMode ? renderModeBar(h, chartMode, changeChartMode) : null,
      chartMode === "daily" && props.hasRange ? renderRangeBar(h, range, changeRange) : null,
      h("span", { className: "sp-time" }, lastAt ? fmtClock(lastAt) : ""),
      h(
        "button",
        {
          className: "sp-icon-btn",
          onClick: () => refreshRef.current && refreshRef.current(),
          disabled: loading,
          title: "刷新",
          "aria-label": "刷新行情",
        },
        h(Icon, { d: ICONS.refresh }),
      ),
    ),
  );

  const chartView = props.renderChart({
    mode: chartMode,
    chart: chart,
    quote: selectedQuote,
    digits: props.digitsOf(selectedQuote),
    colorMode: colorMode,
    height: 168,
  });

  const headerCells = props.columns;

  const searchBox = adding
    ? h(
        "div",
        { className: "sp-form sp-form-stack" },
        h(
          "div",
          { className: "sp-search" },
          h("input", {
            className: "sp-input",
            placeholder: props.searchPlaceholder,
            value: draftSymbol,
            onChange: (event) => onSearchChange(event.target.value),
            autoFocus: true,
          }),
          searching ? h("span", { className: "sp-dim sp-small" }, "搜索中…") : null,
          results.length
            ? h(
                "div",
                { className: "sp-suggest" },
                results.map((item) =>
                  h(
                    "button",
                    {
                      className: "sp-suggest-item",
                      key: item.symbol,
                      onClick: () => {
                        setDraftSymbol(item.symbol);
                        setDraftName(item.name);
                        setResults([]);
                      },
                    },
                    h("span", { className: "sp-strong" }, item.name),
                    h("span", { className: "sp-mono sp-dim" }, item.symbol.toUpperCase()),
                  ),
                ),
              )
            : null,
        ),
        h("input", {
          className: "sp-input",
          placeholder: "显示名称（选中候选会自动填入）",
          value: draftName,
          onChange: (event) => setDraftName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") addItem();
            if (event.key === "Escape") setAdding(false);
          },
        }),
        h(
          "div",
          { className: "sp-form-actions" },
          h("button", { className: "sp-btn sp-btn-primary", onClick: addItem }, "添加"),
          h(
            "button",
            {
              className: "sp-btn",
              onClick: () => {
                setAdding(false);
                setResults([]);
              },
            },
            "取消",
          ),
        ),
      )
    : null;

  return h(
    "div",
    { className: "sp-view" },
    chartTitle,
    chartView,
    h(TradeBox, {
      itemKey: props.holdingPrefix + props.getKey(selectedDef),
      itemName: props.nameOf(selectedDef, selectedQuote),
      externalOpen: tradeToken,
      holding: holdings[props.holdingPrefix + props.getKey(selectedDef)],
      holdings: holdings,
      price: props.priceOf(selectedQuote),
      currency: props.currencyOf(selectedDef),
      digits: props.digitsOf(selectedQuote),
      onPersist: persistHoldings,
      onError: setError,
    }),
    h(PortfolioCard, { buckets: buckets }),
    h(SummaryBar, { buckets: buckets }),
    error
      ? h(
          "div",
          { className: "sp-error", role: "alert" },
          h("span", null, error),
          h(
            "button",
            {
              className: "sp-link-btn",
              onClick: () => refreshRef.current && refreshRef.current(),
            },
            "重试",
          ),
        )
      : null,
    h(
      "div",
      { className: "sp-list" },
      groups.map((group) =>
        h(
          "div",
          { className: "sp-section", key: group.name },
          h("div", { className: "sp-section-head" }, group.name),
          h(
            "div",
            { className: "sp-table " + props.tableClass },
            h(
              "div",
              { className: "sp-tr sp-th" },
              headerCells.map((text, index) => h("div", { className: "sp-td", key: "h" + index }, text)),
            ),
            group.items.map((item) => {
              const key = props.getKey(item);
              const quote = quotes[key] || {};
              const position = positionOf(
                holdings[props.holdingPrefix + key],
                props.priceOf(quote),
              );
              const active = key === selected;
              const itemSession = props.sessionMarket ? getSession(props.sessionMarket(item), now) : null;
              return h(
                "div",
                {
                  className: "sp-tr sp-tr-click" + (active ? " sp-tr-on" : ""),
                  key: key,
                  role: "button",
                  tabIndex: 0,
                  onClick: () => setSelected(key),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(key);
                    }
                  },
                },
                h(
                  "div",
                  { className: "sp-td sp-td-name" },
                  h(
                    "span",
                    { className: "sp-strong" },
                    itemSession
                      ? h("i", {
                          className: "sp-dot sp-dot-inline",
                          style: { background: itemSession.isOpen ? "#2ba471" : "#8e95a3" },
                        })
                      : null,
                    props.nameOf(item, quote),
                  ),
                  h("span", { className: "sp-mono sp-dim" }, props.codeOf(item)),
                ),
                h(
                  "div",
                  { className: "sp-td sp-mono sp-price-cell" },
                  fmtNum(props.priceOf(quote), props.digitsOf(quote)),
                ),
                h(
                  "div",
                  { className: "sp-td sp-mono" },
                  h(
                    "span",
                    { className: "sp-change-badge " + badgeClass(props.pctOf(quote)) },
                    fmtPct(props.pctOf(quote)),
                  ),
                ),
                h(
                  "div",
                  { className: "sp-td sp-mono " + (position && position.pnl !== null ? trendClass(position.pnl) : "") },
                  position && position.marketValue !== null
                    ? fmtMoney(position.marketValue, props.currencyOf(item))
                    : "—",
                ),
                h(
                  "div",
                  { className: "sp-td sp-td-actions" },
                  h(
                    "button",
                    {
                      className: "sp-link-btn sp-row-trade",
                      title: "记录该标的的持仓（买入）",
                      onClick: (event) => {
                        event.stopPropagation();
                        setSelected(key);
                        setTradeToken((t) => t + 1);
                      },
                    },
                    "记仓",
                  ),
                  pendingRemove === key
                    ? h(
                        "button",
                        {
                          className: "sp-link-btn sp-danger",
                          onClick: (event) => {
                            event.stopPropagation();
                            removeItem(key);
                          },
                        },
                        "确认",
                      )
                    : h(
                        "button",
                        {
                          className: "sp-link-btn",
                          title: quote.error || "从列表移除（不会删除持仓账本）",
                          onClick: (event) => {
                            event.stopPropagation();
                            setPendingRemove(key);
                          },
                        },
                        quote.error ? "!" : "移除",
                      ),
                ),
              );
            }),
          ),
        ),
      ),
    ),
    searchBox,
    adding
      ? null
      : h(
          "div",
          { className: "sp-foot" },
          h(
            "button",
            {
              className: "sp-btn",
              onClick: () => setAdding(true),
            },
            props.addLabel,
          ),
          h(
            "label",
            { className: "sp-check" },
            h("span", null, "刷新"),
            h(
              "select",
              {
                className: "sp-refresh-select",
                value: String(refreshMs),
                onChange: (event) => changeRefreshMs(event.target.value),
                "aria-label": "刷新间隔",
              },
              REFRESH_OPTIONS.map((opt) =>
                h("option", { key: opt.value, value: String(opt.value) }, opt.label),
              ),
            ),
          ),
          h("span", { className: "sp-dim sp-small" }, props.pollHint),
          h(
            "button",
            {
              className: "sp-link-btn",
              title: "导出持仓 CSV",
              onClick: () => {
                const rows = defs.map((item) => {
                  const key = props.getKey(item);
                  const quote = quotes[key] || {};
                  const holding = holdings[props.holdingPrefix + key];
                  const position = positionOf(holding, props.priceOf(quote));
                  return [
                    props.nameOf(item, quote),
                    props.codeOf(item),
                    position ? position.size : "",
                    position && position.avgCost !== null ? position.avgCost : "",
                    position && position.marketValue !== null ? position.marketValue : "",
                    position && position.pnl !== null ? position.pnl : "",
                    position && position.ratio !== null ? position.ratio : "",
                    position && position.realizedPnl !== null ? position.realizedPnl : "",
                  ];
                });
                downloadCsv(
                  "holdings-" + new Date().toISOString().slice(0, 10) + ".csv",
                  ["名称", "代码", "份额", "均价", "市值", "浮盈", "收益率%", "已实现"],
                  rows,
                );
              },
            },
            "导出 CSV",
          ),
        ),
  );
}

/* ------------------------------------------------------------------ */
/* 三视图配置                                                           */
/* ------------------------------------------------------------------ */

function renderFundChart({ chart, colorMode, height }) {
  const h = createH();
  return h(SparkChart, {
    points: (chart && chart.points) || [],
    loading: !!(chart && chart.loading),
    error: (chart && chart.error) || "",
    digits: 4,
    height: height,
    colorMode: colorMode,
  });
}

function renderStockChart({ mode, chart, quote, colorMode, height }) {
  const h = createH();
  if (mode === "intraday") {
    return h(SparkChart, {
      points: (chart && chart.points) || [],
      loading: !!(chart && chart.loading),
      error: (chart && chart.error) || "",
      digits: 2,
      height: height,
      baseline: (chart && chart.prevClose) || quote.prevClose || null,
      colorMode: colorMode,
    });
  }
  return h(CandleChart, {
    points: (chart && chart.points) || [],
    loading: !!(chart && chart.loading),
    error: (chart && chart.error) || "",
    digits: 2,
    height: height,
    colorMode: colorMode,
  });
}

function renderCryptoChart({ mode, chart, quote, digits, colorMode, height }) {
  const h = createH();
  if (mode === "intraday") {
    return h(SparkChart, {
      points: (chart && chart.points) || [],
      loading: !!(chart && chart.loading),
      error: (chart && chart.error) || "",
      digits: digits,
      height: height,
      baseline: quote.prevClose || null,
      colorMode: colorMode,
    });
  }
  return h(CandleChart, {
    points: (chart && chart.points) || [],
    loading: !!(chart && chart.loading),
    error: (chart && chart.error) || "",
    digits: digits,
    height: height,
    colorMode: colorMode,
  });
}

function FundsView(props) {
  const h = createH();
  return h(MarketView, {
    api: props.api,
    isActive: props.isActive,
    colorMode: props.colorMode,
    storageKey: KEYS.funds,
    defaultList: DEFAULT_FUNDS,
    rangeKey: "fundRange",
    chartModeKey: "fundChartMode",
    defaultChartMode: "daily",
    hasChartMode: false,
    hasRange: true,
    holdingPrefix: "fund:",
    tableClass: "sp-table-funds sp-table-pos",
    columns: ["名称 / 代码", "净值", "日涨跌", "市值", ""],
    addLabel: "+ 添加基金",
    pollHint: "净值每日更新 · 5min",
    invalidTip: "基金代码应为 6 位数字",
    searchPlaceholder: "基金代码（6 位）",
    fetchQuotes: fetchFundQuoteList,
    fetchHistory: (api, item, mode, range) => fetchFundHistory(api, item.code, range),
    search: () => Promise.resolve([]),
    normalize: (text) => {
      const code = String(text || "").trim();
      return /^\d{6}$/.test(code) ? code : "";
    },
    createItem: (code, name) => ({ code: code, name: name || code, tag: "自选" }),
    getKey: (item) => item.code,
    codeOf: (item) => item.code + (item.tag ? " · " + item.tag : ""),
    nameOf: (item) => (item && item.name) || (item && item.code) || "",
    priceOf: (quote) => quote.nav,
    pctOf: (quote) => quote.dayChangePct,
    pctSuffix: " 日",
    currencyOf: () => "CNY",
    digitsOf: () => 4,
    groupOf: (item) => item.tag || "自选",
    sessionMarket: null,
    renderChart: renderFundChart,
  });
}

async function fetchFundQuoteList(api, list) {
  return mapLimit(list, FUND_CONCURRENCY, (fund) => fetchFundQuote(api, fund));
}

function StocksView(props) {
  const h = createH();
  return h(MarketView, {
    api: props.api,
    isActive: props.isActive,
    colorMode: props.colorMode,
    storageKey: KEYS.stocks,
    defaultList: DEFAULT_STOCKS,
    rangeKey: "stockRange",
    chartModeKey: "stockChartMode",
    defaultChartMode: "daily",
    hasChartMode: true,
    hasRange: true,
    holdingPrefix: "stock:",
    tableClass: "sp-table-stocks sp-table-pos",
    columns: ["名称", "现价", "涨跌幅", "市值", ""],
    addLabel: "+ 添加标的",
    pollHint: "交易中 30s · 非交易 5min",
    invalidTip: "请输入代码，如 sh600519 / 600519 / usAAPL",
    searchPlaceholder: "搜索名称 / 代码 / 拼音：茅台、AAPL、腾讯",
    fetchQuotes: fetchStockQuotes,
    fetchHistory: (api, item, mode, range, quote) => {
      if (mode === "intraday") {
        return fetchIntraday(api, eastmoneySecId(item.symbol, quote.fullCode));
      }
      return fetchStockHistory(api, Object.assign({}, item, { fullCode: quote.fullCode }), range);
    },
    search: searchInstruments,
    normalize: normalizeSymbol,
    createItem: (symbol, name) => {
      const market = marketOfSymbol(symbol);
      const group = market === "us" ? "美股" : market === "hk" ? "港股" : "A股";
      return { symbol: symbol, name: name || symbol.toUpperCase(), group: group };
    },
    getKey: (item) => item.symbol,
    codeOf: (item) => item.symbol.toUpperCase(),
    nameOf: (item, quote) => (item && item.name) || quote.name || (item && item.symbol) || "",
    priceOf: (quote) => quote.price,
    pctOf: (quote) => quote.changePct,
    pctSuffix: " 日",
    currencyOf: (item) => currencyOfMarket(marketOfSymbol(item.symbol)),
    digitsOf: () => 2,
    groupOf: (item) => item.group || "自选",
    sessionMarket: (item) => marketOfSymbol(item.symbol),
    renderChart: renderStockChart,
  });
}

function normalizeCryptoSymbol(raw) {
  const text = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!text) return "";
  if (/(USDT|USDC|BUSD|FDUSD)$/.test(text)) return text;
  return text + "USDT";
}

function CryptoView(props) {
  const h = createH();
  return h(MarketView, {
    api: props.api,
    isActive: props.isActive,
    colorMode: props.colorMode,
    storageKey: KEYS.crypto,
    defaultList: DEFAULT_CRYPTO,
    rangeKey: "cryptoRange",
    chartModeKey: "cryptoChartMode",
    defaultChartMode: "daily",
    hasChartMode: true,
    hasRange: true,
    holdingPrefix: "crypto:",
    tableClass: "sp-table-stocks sp-table-pos",
    columns: ["币种", "价格", "24h", "市值", ""],
    addLabel: "+ 添加币种",
    pollHint: "币安公共数据 · 30s",
    invalidTip: "请输入币种，如 BTC 或 BTCUSDT",
    searchPlaceholder: "币种：BTC / ETH / BTCUSDT",
    fixedPollMs: STOCK_OPEN_MS,
    fetchQuotes: fetchCryptoQuotes,
    fetchHistory: (api, item, mode, range) => fetchCryptoKlines(api, item.symbol, mode, range),
    search: () => Promise.resolve([]),
    normalize: normalizeCryptoSymbol,
    createItem: (symbol, name) => ({
      symbol: symbol,
      name: name || symbol.replace(/(USDT|USDC|BUSD|FDUSD)$/, ""),
      group: "自选",
    }),
    getKey: (item) => item.symbol,
    codeOf: (item) => item.symbol,
    nameOf: (item) => (item && item.name) || (item && item.symbol) || "",
    priceOf: (quote) => quote.price,
    pctOf: (quote) => quote.changePct,
    pctSuffix: " 24h",
    currencyOf: () => "USD",
    digitsOf: (quote) => (quote.price !== null && quote.price < 1 ? 6 : 2),
    groupOf: (item) => item.group || "自选",
    sessionMarket: () => "crypto",
    renderChart: renderCryptoChart,
  });
}

/* ------------------------------------------------------------------ */
/* 韭菜盒子                                                            */
/* ------------------------------------------------------------------ */

function LeekPanel(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState, useEffect } = R;
  const api = props.api;
  const isActive = props.isActive !== false;
  const [view, setView] = useState("funds");
  const [colorMode, setColorMode] = useState("red-up");

  useEffect(() => {
    let alive = true;
    api.storage
      .getJson(KEYS.settings, null)
      .then((saved) => {
        if (alive && saved && saved.colorMode === "green-up") setColorMode("green-up");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const toggleColor = () => {
    const next = colorMode === "red-up" ? "green-up" : "red-up";
    setColorMode(next);
    api.storage
      .getJson(KEYS.settings, {})
      .then((saved) =>
        api.storage.setJson(KEYS.settings, Object.assign({}, saved || {}, { colorMode: next })),
      )
      .catch(() => {});
  };

  return h(
    "div",
    { className: "sp-root" + (colorMode === "green-up" ? " sp-green-up" : "") },
    h(
      "div",
      { className: "sp-tabs", role: "tablist" },
      h(
        "button",
        {
          role: "tab",
          "aria-selected": view === "funds",
          className: "sp-tab" + (view === "funds" ? " sp-tab-on" : ""),
          onClick: () => setView("funds"),
        },
        "基金",
      ),
      h(
        "button",
        {
          role: "tab",
          "aria-selected": view === "stocks",
          className: "sp-tab" + (view === "stocks" ? " sp-tab-on" : ""),
          onClick: () => setView("stocks"),
        },
        "行情",
      ),
      h(
        "button",
        {
          role: "tab",
          "aria-selected": view === "crypto",
          className: "sp-tab" + (view === "crypto" ? " sp-tab-on" : ""),
          onClick: () => setView("crypto"),
        },
        "大饼",
      ),
      h(
        "button",
        {
          className: "sp-icon-btn sp-color-btn",
          title: "切换涨跌配色（A 股红涨 / 美股绿涨）",
          "aria-label": "切换涨跌配色",
          onClick: toggleColor,
        },
        h(Icon, { d: ICONS.palette }),
      ),
    ),
    view === "funds"
      ? h(FundsView, { api: api, isActive: isActive, colorMode: colorMode })
      : view === "crypto"
        ? h(CryptoView, { api: api, isActive: isActive, colorMode: colorMode })
        : h(StocksView, { api: api, isActive: isActive, colorMode: colorMode }),
  );
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */


/** 迁移旧 id 存储后再渲染面板，保证持仓/自选不丢。 */
function RootWithMigration(props) {
  const R = window.SnowAppPlugin.React;
  const h = R.createElement;
  const { useState, useEffect } = R;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    migrateLegacyStorage(props.api)
      .catch(() => {})
      .then(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [props.api]);

  if (!ready) {
    return h("div", { className: "sp-root" }, h("div", { className: "sp-empty" }, "加载中…"));
  }
  const panelId = props.panelId || "leek";
  return h(LeekPanel, props);
}

export default function StockPanel(props) {
  const h = window.SnowAppPlugin.React.createElement;
  return h(RootWithMigration, props);
}
