# 业务域目录

按域组织（技术方案 §1.1），每个域自带 `controller` / `service` / `schema`。
所有域统一经 **8 段中间件链**（`common/middleware/chain.ts`），出口一律走
`responseEnvelope`。

> 项目总览、请求链路与需求完成度评估见仓库根目录
> [`README.md`](../../../../README.md)。本文件只做域索引。

## 16 个域

| #   | 域          | 职责                                           | 关键点                                   |
| --- | ----------- | ---------------------------------------------- | ---------------------------------------- |
| 1   | `auth`      | 登录鉴权、openid/token、本人资料               | 微信 jscode2session；生产缺凭证拒绝启动  |
| 2   | `family`    | 家庭、成员、邀请码、转让户主                   | 软删复合唯一键；户主展示名取昵称         |
| 3   | `trip`      | 出行容器、成员、主导者、邀请码、自动完结       | CAS；归档后信息只读                      |
| 4   | `itinerary` | 安排 / 正文块 / 排序                           | 只读行程拒写；图片块 URL 由服务端解析    |
| 5   | `expense`   | 花销、多币种、批量导入、汇总                   | 金额最小单位整数；缺汇率不按 1:1 兜底    |
| 6   | `checklist` | 行程清单、长期模板、模板同步、批量勾选         | 双语义 SHARED/PERSONAL；TODO/PACK 分类   |
| 7   | `wish`      | 心愿、投票、转行程草稿                         | 状态机 WANT/PLANNED/DONE/DROPPED         |
| 8   | `item-sync` | 增量游标、变更拉取、合并报告                   | change_log 游标；仍有全表扫描待优化      |
| 9   | `outfit`    | 穿搭 CRUD                                      | PRIVATE 域；校验 item 归属               |
| 10  | `notify`    | 提醒任务、订阅授权                             | 提醒时间按接收人时区；发送调度器未实现   |
| 11  | `media`     | 媒体资产、presign/confirm、EXIF 剥离、回忆照片 | 上传走 `/media-files`；归档行程照片可写  |
| 12  | `holiday`   | 节假日 / 调休字典                              | 全国字典无 HTTP 写入口；家庭自定义需户主 |
| 13  | `fx`        | 汇率查询 / 录入 / 快照 / 批量换算              | 档位唯一 SPOT_SELL；生产人工录入源       |
| 14  | `memory`    | 回忆归档、按行程/年度生成                      | `snap_key` 唯一键；生成幂等              |
| 15  | `booking`   | 预订、订单号 / 联系人加密                      | 解密写审计；响应不返密文列               |
| 16  | `item`      | 个人物品库                                     | PRIVATE 短路；被 outfit 外键引用         |

## 约定

- 每个域按需放 `<domain>.controller.ts` / `<domain>.service.ts` / `<domain>.schema.ts`（Zod）。
- 域只依赖 `DomainContext`（读 / 事务 / 软删）与 `TableDriver` 接口，不直接构造数据库连接。
- 写路径统一走 `ctx.tx()` → `commitWrite()`：业务写 + `change_log` + `audit_log` 同事务。
- 公共能力（鉴权 / 加密 / 幂等 / 错误码 / 分页 / 汇率精度 / 事务 / 媒体）一律复用
  `common/`，域内不重复造。
- 新增路由必须在组合根汇总，且不能与既有 `(method, path)` 重复（启动期断言）。

历史交付背景见 [`docs/OVERVIEW.md`](../../../../docs/OVERVIEW.md)（M1 早期快照）。
