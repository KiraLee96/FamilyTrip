/**
 * 微信云函数 · 汇率取数（备选方案）
 * ============================================================================
 * 什么时候用它：
 *   小程序要独立跑、不依赖 apps/server（例如后端还没部署到备案域名，
 *   而你又想在真机上看到真实汇率）。
 *
 * 什么时候**不要**用它：
 *   项目里已经有 NestJS 后端和 fx 域 —— 云函数会绕过 `FxService` 的缓存 /
 *   落库 / 口径校验，形成第二套汇率来源。记账类金额务必走后端 `/fx/rate`。
 *
 * 数据源：open.er-api.com → api.frankfurter.app（依次回退）
 * 返回：{ code, base, rates, updatedAt, source }，rates 为「1 base = X 外币」
 */

const https = require('node:https');

const TIMEOUT_MS = 6000;
/** 实例内存缓存：热实例可直接命中，冷启动失效（要持久化请落云数据库） */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`响应非 JSON：${url}`));
        }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`请求超时：${url}`)));
    req.on('error', reject);
  });
}

/** 数值 → 8 位定点字符串，非法值直接抛（不做 1 兜底） */
function toRate(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`汇率值非法：${String(raw)}`);
  return n.toFixed(8);
}

async function fromOpenErApi(base) {
  const json = await fetchJson(`https://open.er-api.com/v6/latest/${base}`);
  if (json.result !== 'success' || !json.rates) throw new Error('open.er-api 响应异常');
  const rates = {};
  for (const [code, value] of Object.entries(json.rates)) rates[code.toUpperCase()] = toRate(value);
  return {
    base,
    rates,
    updatedAt: json.time_last_update_unix ? json.time_last_update_unix * 1000 : Date.now(),
    source: 'OPEN_ER_API',
  };
}

async function fromFrankfurter(base) {
  const json = await fetchJson(`https://api.frankfurter.app/latest?from=${base}`);
  if (!json.rates) throw new Error('frankfurter 响应异常');
  const rates = { [base]: '1' };
  for (const [code, value] of Object.entries(json.rates)) rates[code.toUpperCase()] = toRate(value);
  return { base, rates, updatedAt: Date.now(), source: 'FRANKFURTER' };
}

exports.main = async (event = {}) => {
  const base = String(event.base || 'CNY').toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) {
    return { code: 400, message: `货币代码非法：${base}` };
  }

  const hit = cache.get(base);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return { code: 0, ...hit.data, cached: true };
  }

  const errors = [];
  for (const attempt of [() => fromOpenErApi(base), () => fromFrankfurter(base)]) {
    try {
      const data = await attempt();
      cache.set(base, { data, cachedAt: Date.now() });
      return { code: 0, ...data, cached: false };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // 全部失败时回退旧缓存（比让界面空着好，但要带上 stale 标记）
  if (hit) return { code: 0, ...hit.data, cached: true, stale: true };

  return { code: -1, message: `汇率源均不可用：${errors.join('；')}` };
};
