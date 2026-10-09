# @family-trip/client

家庭出行计划客户端。**首发编译微信小程序，H5 预留**。

## 技术栈（派发单 §2.1）

- **Taro 4.x** + **React** + **TypeScript**（`strict: true`）
- 状态/请求层与后端 `common/` 公共层对齐（统一信封 `responseEnvelope`、错误码、幂等 `requestId`）

## 本批状态（DISPATCH-M1-CODE-2026-10-09）

本目录**仅占位**。派发单明确：业务域（auth / family / trip / itinerary / expense / checklist / wish / item+sync / outfit / notify / media / holiday / fx / memory）的实现，以及 Taro 工程依赖、页面与组件，**全部待技术方案 v1.4 关系型栈收口后接入**。

首次提交的可运行范围集中在后端 `apps/server`：工程骨架 + `common/` 公共层 + 统一中间件链 + M2/M3/M4（M5/M6 同步交付）。客户端不纳入本批 `verify` 门禁。

## 待办（v1.4 后）

- [ ] Taro 4.x 工程初始化（project.config.json / tsconfig / babel）
- [ ] 入口 `app.config.ts` / `app.tsx` / `src/pages/**`
- [ ] 接入后端统一中间件链与错误码信封
- [ ] 微信小程序编译（`dev:weapp`）验证
