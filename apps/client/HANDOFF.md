# 交付交接清单（派发单 ② · 前端泳道 A1–A5）

> 里程碑：**M-Client-1** —— 微信开发者工具（测试号 AppID）打开后，首页 / 心愿池 / 行程 / 年度规划 四页面可显示、可交互、控制台 0 error。
> 交付范围：仅 `apps/client`（红线 #4，`apps/server/**` 未触碰）。

## 一、交付物

| #   | 交付物                             | 位置                                                                                                                                      |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Taro 4.x 工程骨架 + 构建脚本       | `config/index.ts`、`babel.config.cjs`、`project.config.json`、`package.json`（scripts: `dev:weapp`/`build:weapp`/`build:h5`/`typecheck`） |
| A2  | 路由抽象层 + 5 页小程序页面        | `src/nav/index.ts`（`navigate/back/useRouteParams`）、`src/nav/Link.tsx`、`src/pages/*.tsx`                                               |
| A3  | 样式适配说明                       | `STYLE_ADAPTATION.md`                                                                                                                     |
| A4  | 原生 tabBar 配置                   | `src/app.config.ts` 的 `tabBar`（4 tab，纯文字）                                                                                          |
| A5  | `Taro.request` 网络层（Mock 可跑） | `src/api/http.ts`、`src/api/index.ts`（`ApiClient` 接口一字未动）                                                                         |

## 二、质量证据（可复现）

```bash
# 1) 类型：strict 0 错误
pnpm --filter @family-trip/client run typecheck      # exit 0

# 2) 构建：微信小程序产物
pnpm --filter @family-trip/client run build:weapp    # Compiled successfully, exit 0
#    ModuleDependencyWarning：5 → 0（页面组件已正确 default 接线，见下）

# 3) Lint：0 error（26 warning 为 explicit-function-return-type，项目基线级别，非阻断）
pnpm exec eslint apps/client/src                      # 0 errors, 26 warnings, exit 0
```

产物 `apps/client/dist/`：`app.js`(96KB) / `vendors.js` / `taro.js` + 5 个页面（`.js/.wxml/.json`）+ `app.json`（pages 5、tabBar 4）。

## 三、⚠️ 关键修复（必读）

上一版五个页面用 **named export**（`export function HomePage()`），而 Taro `taro-loader` 从小程序页面的 **default export** 取组件。缺 default → `createPageConfig(undefined)` → **微信开发者工具打开白屏**。
本次已为 5 个页面补 `export default X;`，构建告警 5→0，产物层确认 `eU(<真实组件>)` 全部正确接线。

## 四、微信开发者工具验证步骤（M-Client-1 验收）

1. 打开微信开发者工具 → 导入项目 → 目录选 `apps/client/dist`（`miniprogramRoot` 已配 `dist/`）。
2. **AppID**：`project.config.json` 当前为 `"touristappid"`（游客号，可直接预览）。
   - 用测试号 AppID：把派发单 ①-1.1 拿到的测试号 AppID 填进 `project.config.json` 的 `appid`（该文件是配置、非源码；如需保密可 `git update-index --skip-worktree project.config.json` 后再改本地值）。
   - 真后端联调（A7）时勾选「详情 → 本地设置 → 不校验合法域名」。
3. 逐项打勾：
   - [ ] 首页 / 心愿池 / 行程 / 年度规划 **四页面均正常渲染**
   - [ ] 底部 4 个原生 tab 可切换、选中态变色
   - [ ] 行程列表点进「行程详情」（`navigateTo` 带 `id`），可返回
   - [ ] 心愿**投票**可交互、清单**勾选**可交互（Mock 数据）
   - [ ] 顶部徽标显示 **MOCK**（`process.env.API_BASE_URL` 为空 → 走 Mock，红线 #2）
   - [ ] 控制台 **0 error**
4. **截图 4 张**（首页 / 心愿池 / 行程 / 年度规划）随验收回传 —— ⚠️ 本环境无微信开发者工具，**截图需在开发者工具内人工截取**（待补项）。

## 五、红线自查

| 红线                                     | 状态                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| #1 `ApiClient` 接口不改                  | ✅ 仅换 `http.ts` 内部实现，方法签名未动                                                          |
| #2 全程 Mock，不发真实请求               | ✅ `API_BASE_URL` 为空走 Mock                                                                     |
| #3 组件不 fork                           | ✅ 5 页 + shared/Loading/Icon 统一 `View/Text`，无双份                                            |
| #4 `apps/server/**` 不动，单独 commit    | ✅ 提交仅含 `apps/client` + 根 `package.json`/`pnpm-lock.yaml`（client 使能），未含 `apps/server` |
| #5 AppID 走配置不写死                    | ✅ `project.config.json` 承载，默认 `touristappid`                                                |
| #6 TS strict / ESLint 0 error / Prettier | ✅ typecheck 0 错误、eslint 0 error                                                               |

## 六、后续依赖（不在本次范围）

- **A6 登录**：依赖派发单 ① 的测试号 AppID；`wx.login` 链路待排期。
- **A7 联调**：依赖派发单 ④ 后端就绪 + CORS 放行 + 「不校验合法域名」开关。
- **H5 二期**：`build:h5` 已可用（`dev:h5`/`build:h5` 脚本就绪），同构无需再改。
