# 汇率功能接入说明

> 面向 `apps/` 的汇率换算能力（人民币 ↔ 外币）。
> 本次接入**新增一个数据源适配器 + 前端 hook**，没有另起一套汇率口径。

---

## 一、先看清现状

项目里本来就有完整的 fx 链路：

| 已有                                                                    | 位置                                          |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| 6 条路由（`/fx/rate` `/fx/rates` `/fx/snapshot` `/fx/convert-batch` …） | `apps/server/src/domains/fx/fx.controller.ts` |
| 域服务（缓存 → 库内 → 回源 → 落库）                                     | `apps/server/src/domains/fx/fx.service.ts`    |
| 金额精度（decimal.js + 最小货币单位整数）                               | `apps/server/src/common/fx/amount.ts`         |
| 档位与缓存键（`SPOT_SELL` 唯一口径）                                    | `apps/server/src/common/fx/rate-tier.ts`      |
| 授权源白名单 + 生产 fail-fast                                           | `apps/server/src/common/fx/source-guard.ts`   |

**缺的只有一处**：`main.ts` 里 `sources: []` —— 没有任何真实汇率源被注入。
后果是 `getRate()` 一定抛 `FX_SOURCE_MISCONFIGURED`（5006），所有外币金额的
`amount_base` 恒为 `null`。

所以本次没有写「新接口」，而是把「数据源」补上。

### 🔴 红线 R7（必须知道）

`rate-tier.ts` 顶部写死了：**生产环境禁止抓取汇率，必须用签约授权源**。

公开免费 API（open.er-api、frankfurter）提供的是**中间价**，不是银行现汇卖出价
（`SPOT_SELL`），也不在授权范围内。因此 `PublicRateSource` 做了两道锁：

1. `resolvePublicFxSource()` 在 `NODE_ENV=production` 下**直接返回 `undefined`**，
   让 M3 的 fail-fast 照常拒绝启动；
2. 源名 `PUBLIC_RATE_DEV` 必须显式出现在 `FX_AUTHORIZED_SOURCES` 里。

**结论**：这套只服务开发 / 预览。要上线，按同一个 `FxRateSource` 接口写一个
签约源（银行 / 中国外汇交易中心），域代码一行不用改。

---

## 二、改动清单

| 文件                                                      | 动作 | 作用                                                                                      |
| --------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `apps/server/src/common/fx/sources/public-rate-source.ts` | 新增 | `FxRateSource` 实现：open.er-api → frankfurter 回退，8 位定点，进程内缓存 + 并发去重      |
| `apps/server/src/common/fx/sources/index.ts`              | 新增 | `resolvePublicFxSource()`：按环境决定是否注入（生产恒 undefined）                         |
| `apps/server/src/composition-root.ts`                     | 改   | 加 `installFxSource()` 登记位；`buildApp()` 解析 `options.fxSource ?? registeredFxSource` |
| `apps/server/src/main.ts`                                 | 改   | 启动时装配源；非生产自动补登白名单并告警                                                  |
| `apps/server/.env.example`                                | 改   | 补 `FX_AUTHORIZED_SOURCES` 的开发用法说明                                                 |
| `apps/client/src/api/types.ts`                            | 改   | 加 `FxRate` / `RateTier` 类型                                                             |
| `apps/client/src/api/client.ts`                           | 改   | `ApiClient` 加 `getFxRate()`                                                              |
| `apps/client/src/api/http.ts`                             | 改   | `GET /fx/rate` 实现（拆 `data.rate` 一层）                                                |
| `apps/client/src/api/mock.ts`                             | 改   | Mock 汇率表 + 交叉汇率，缺币种回 5006                                                     |
| `apps/client/src/utils/fx.ts`                             | 新增 | BigInt 定点换算（12 位内部精度），`cnyToForeign` / `foreignToCny`                         |
| `apps/client/src/hooks/useFxRate.ts`                      | 新增 | 取汇率 + 本地换算的 hook                                                                  |
| `cloudfunctions/fx-rate/`                                 | 新增 | 云函数版（**备选**，见第五节）                                                            |

---

## 三、跑起来

```bash
# 1. 启动后端（首次会自动把 PUBLIC_RATE_DEV 补进白名单并打一条 warn）
pnpm dev:server
```

验证接口（开发环境 `code` 随便传，stub 会把它拼成 openid）：

```bash
curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"code":"devcode"}'
# 复制返回里的 data.token
```

```bash
curl -s "http://127.0.0.1:3000/api/fx/rate?base=CNY&quote=JPY&date=2026-10-19" \
  -H "Authorization: Bearer <token>"
```

期望（实测值，2026-10-19）：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "rate": {
      "base": "CNY",
      "quote": "JPY",
      "rate": "23.60287900",
      "rateDate": "2026-10-19",
      "tier": "SPOT_SELL",
      "rateTime": "2026-10-19T06:12:33.000Z",
      "source": "PUBLIC_RATE_DEV",
      "fromCache": false
    }
  }
}
```

> `rate` 的含义是 **1 CNY = 23.602879 JPY**。方向写死在 `FxRate` 注释里，别反。
> 同币种（CNY→CNY）后端直接回 `rate: "1"`、`source: "IDENTITY"`，不落库。

---

## 四、前端怎么用

```tsx
import { useState } from 'react';
import { Input, Text, View } from '@tarojs/components';
import { useFxRate } from '@/hooks/useFxRate';
import { formatRate } from '@/utils/fx';

export function CurrencyConverter() {
  const [amount, setAmount] = useState('100');
  // quote 换成 USD / THB / KRW 都行；base 默认 CNY
  const { rate, loading, error, missing, toForeign, toBase } = useFxRate({ quote: 'JPY' });

  if (loading) return <View>汇率加载中…</View>;
  if (missing) return <View>暂无日元汇率，稍后再试</View>;
  if (error) return <View>获取失败：{error}</View>;

  return (
    <View>
      <Text>1 人民币 ≈ {formatRate(rate!.rate)} 日元</Text>

      <Input type="digit" value={amount} onInput={(e) => setAmount(e.detail.value)} />

      <Text>
        {amount} 元 ≈ {toForeign(amount)} 日元
      </Text>
      <Text>
        {amount} 日元 ≈ {toBase(amount)} 元
      </Text>
    </View>
  );
}
```

要点：

- `toForeign` / `toBase` 在**无汇率时返回 `undefined`**，UI 必须判空 —— 不会偷偷按 1:1 算。
- 取数只在 `quote / base / date` 变化时发生；输入金额不会触发请求。
- `date` 不传默认本地今天。要查历史汇率（frankfurter 支持），显式传 `date: '2026-03-02'`。
- 弹窗场景用 `enabled: isOpen` 延迟到打开时再请求。

### 为什么换算不用 `Number()`

`apps/client/src/utils/fx.ts` 用 BigInt 定点（内部 12 位小数）算：

```ts
cnyToForeign('368.00', '20.85000000', 'JPY'); // '7672'
foreignToCny('7672', '20.85000000'); // '368.01'
```

`Number` 会在 `368.00 × 20.85` 上出现 `7672.800000000001`。
🔴 但这套**只用于展示**：真要落库的金额走服务端 `POST /fx/convert-batch`
（decimal.js + 最小货币单位整数），前端不参与写路径。

---

## 五、云函数版（备选，非首选）

`cloudfunctions/fx-rate/` 是给你「不想依赖 server」时用的：比如后端还没部署到
备案域名，但想在真机上看到真实汇率。

**为什么不是首选**：这个项目是 Taro 同构（小程序 + H5 预留），云函数只在微信端
可用；更关键的是它会绕过 `FxService` 的缓存 / 落库 / 口径校验，形成第二套汇率
来源 —— 记账类金额**绝不能**走它。

启用步骤：

1. `project.config.json` 加一行 `"cloudfunctionRoot": "cloudfunctions/"`；
2. 微信开发者工具里右键 `fx-rate` → 上传并部署（云端安装依赖，本项目零依赖）；
3. 小程序端调用：

```ts
// 建议只在微信端用：H5 下 Taro.cloud 不存在
const res = await Taro.cloud.callFunction({
  name: 'fx-rate',
  data: { base: 'CNY' },
});
const { rates } = res.result as { rates: Record<string, string> };
const jpy = rates['JPY']; // 1 CNY = jpy JPY
```

云函数返回 `{ code, base, rates, updatedAt, source, cached }`，`rates` 是全量表，
一次拿 166 个币种，比 `/fx/rate` 一次一个 quote 更适合做「币种选择器」。

---

## 六、上线前 checklist

- [ ] **接签约授权源**：实现 `FxRateSource`，在 `main.ts` 里替换 `resolvePublicFxSource()`
- [ ] `FX_AUTHORIZED_SOURCES` 配成真实源名（生产不做自动补登，缺了直接起不来）
- [ ] 确认源能提供 `SPOT_SELL`（现汇卖出价），而不是中间价
- [ ] 金额链路（记账、汇总、回忆快照）验证 `amount_base` 有值且对账通过
- [ ] 页面上标注「汇率数据仅供参考，交易以银行柜台成交价为准」

---

## 七、常见问题

**Q：接口报 `5006` / `汇率源未配置为合规授权源`**
A：三种可能 —— ① `NODE_ENV=production` 但没配授权源（设计如此）；
② `FX_AUTHORIZED_SOURCES` 里没有源名；③ 该币种在数据源里不存在（如 frankfurter
不含 TWD 的某些日期）。看 `message` 字段能区分。

**Q：`rateDate` 和我请求的 `date` 不一样**
A：`rateDate` 是**数据实际对应的日期**。当日请求走 open.er-api（日更，可能滞后
几小时到前一天）；历史请求走 frankfurter（返回的就是那一天）。不伪造日期。

**Q：能同时查 10 个币种吗**
A：`/fx/rate` 一次一个。批量请用 `POST /fx/convert-batch`（最多 200 条），
或在云函数里一次取全表。

**Q：本地改了 `.env` 没生效**
A：`load-env.ts` 只在变量**未设置**时填充，shell 里已有的同名变量优先级更高。
另外它必须在 `main.ts` 第一行被 import（现在就是）。
