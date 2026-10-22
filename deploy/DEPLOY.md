# FamilyTrip 生产部署 Runbook

**目标机器**：腾讯云轻量 lhins-lhvlecwc（82.156.30.50，2C/2G/50G/4Mbps，Ubuntu）
**共机注意**：机器上跑着 XLFamily（pm2 family-space，root 管理，占用 **:3000**）与 food-api（nginx :80 → :5050）
——所有步骤以「不碰它们」为前提。FamilyTrip 用 **:3010** 与独立 `server_name` 站点。
**本目录文件**：`ecosystem.config.js.example`（pm2 模板）/ `mysql-lightsail.cnf`（MySQL 降配）/ `nginx-family-trip.conf`（站点模板）

---

## 0. 前置检查（缺任何一项就停，不要带着缺口往下走）

| #   | 项                                                       | 状态 | 卡点后果                                                               |
| --- | -------------------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| 1   | 云硬盘**自动快照**已开                                   | ☐    | 盘坏 = XLFamily + FamilyTrip 数据全没                                  |
| 2   | `WECHAT_SECRET` 已从 mp.weixin.qq.com 拿到               | ☐    | 生产拒绝启动（半配置也拒绝）                                           |
| 3   | `JWT_SECRET` 已生成（`openssl rand -base64 48`）         | ☐    | 生产拒绝启动                                                           |
| 4   | 域名已备案 + 已解析到 82.156.30.50                       | ☐    | 无 HTTPS = 小程序无法连接（备案 7-20 个工作日，最迟启动）              |
| 5   | `FX_AUTHORIZED_SOURCES` 已定（默认 `MANUAL_RATE_ENTRY`） | ☐    | 白名单为空 = 生产拒绝启动（M3 守卫，有意设计，勿删守卫勿填未采购的源） |

> 第 5 项已从产品决策降为配置项。生产默认填 `MANUAL_RATE_ENTRY`（银行牌价人工录入，0 采购成本、口径正确），代码已实现该源：未录入的汇率返回 5006 并提示去 `POST /fx/rates` 补录，不会静默造假。
> 规模化后再切签约 API 源：采购签约源 → 源适配器实现 `FxRateSource` → 白名单追加源名即可，无需再改部署流程。

**登录服务器**：腾讯云轻量控制台 → 实例 → 登录（OrcaTerm 浏览器登录最稳，不依赖本机 SSH 密钥）。

---

## 1. 服务器基线（约 5 分钟）

```bash
# swap 兜底：2G 内存 + MySQL，OOM 一次就全挂
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # 验证 Swap 出现 2G

# 确认共机现状（应看到 family-space 在跑，别动它）
pm2 list
```

## 2. MySQL（✅ 2026-10-22 已完成安装与降配）

实测状态：MySQL **8.0.46** 已安装并 active；降配文件 `/etc/mysql/mysql.conf.d/99-family-trip.cnf` 已生效，
运行期核验：`innodb_buffer_pool_size=134217728`(128M)、`max_connections=50`、`performance_schema=OFF`、
`bind_address=127.0.0.1`、`character_set_server=utf8mb4`。常驻内存约 80MB（预热后 ~200MB）。

剩余一步：建库 + 最小权限账号（密码已在服务器端生成并存于 `~/.ft-db-url`，全程无需手输）：

```bash
PW=$(sed -n 's|^DATABASE_URL=mysql://family_trip:\([^@]*\)@.*|\1|p' ~/.ft-db-url)
sudo mysql -e "CREATE DATABASE IF NOT EXISTS family_trip CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
sudo mysql -e "CREATE USER IF NOT EXISTS 'family_trip'@'127.0.0.1' IDENTIFIED BY '$PW'; GRANT ALL PRIVILEGES ON family_trip.* TO 'family_trip'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

> `~/.ft-db-url`（600，ubuntu 属主）里是完整的一行 `DATABASE_URL=mysql://family_trip:<密码>@127.0.0.1:3306/family_trip`，
> 第 4 步直接整行取用，密码不进聊天窗、不进 bash history。

## 3. 代码上服务器 + 构建（约 10 分钟）

实测约束（2026-10-22）：

- GitHub 仓库是**私有**的 → 服务器已生成只读部署密钥 `/home/ubuntu/.ssh/ft_deploy`；
  需在 GitHub 仓库 Settings → Deploy keys 添加对应公钥（只读勾选即可）。
- 服务器系统 Node 是 **v20.20.2**（XLFamily 在用，勿动），而项目 `packageManager: pnpm@11.0.1`
  要求 Node ≥ 22.13 → 已另装 **Node 22.23.4** 于 `/home/ubuntu/.local/node22`。
  **构建用它，运行仍用系统 Node 20**（`engines` 要求 ≥20.11，运行侧无问题）。

```bash
export PATH=/home/ubuntu/.local/node22/bin:$PATH   # 仅构建期生效，不改系统默认
cd /home/ubuntu
GIT_SSH_COMMAND='ssh -i ~/.ssh/ft_deploy -o IdentitiesOnly=yes' \
  git clone git@github.com:KiraLee96/FamilyTrip.git family-trip
cd family-trip
node -v && pnpm -v                 # 期望 v22.23.4 / 11.0.1
pnpm install --frozen-lockfile
pnpm --filter @family-trip/server build

# Prisma：生成 client + 建表（migrate deploy 不创建库，库在第 2 步建好）
cd apps/server && npx prisma migrate deploy
```

> ⚠️ 若 `migrate deploy` 报「no migration found」：migrations 目录没进仓库——本地先提交迁移文件再上服务器。

## 4. pm2 起服务（约 5 分钟）

```bash
cd /home/ubuntu/family-trip/apps/server
cp <本目录>/ecosystem.config.js.example ecosystem.config.js
vim ecosystem.config.js   # 填第 0 节全部占位符；DATABASE_URL 取 ~/.ft-db-url 整行
chmod 600 ecosystem.config.js

# 预期行为（不是 bug！）：占位符没填全 → 启动即退出并打印原因
pm2 start ecosystem.config.js
pm2 logs family-trip --lines 50
```

看到 `family-trip server listening on :3010` 才算成（**端口是 3010 不是 3000**——3000 被 XLFamily 占用）。常见退出原因对照：

| 日志关键字                       | 含义                                        | 处理                                                                                 |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `WECHAT_APPID` / `WECHAT_SECRET` | 缺配置或半配置                              | 补齐                                                                                 |
| `JWT_SECRET`                     | 缺签名密钥                                  | 补齐                                                                                 |
| `FxSourceMisconfigured`          | FX 授权源白名单为空，或汇率尚未录入（5006） | 填 `FX_AUTHORIZED_SOURCES=MANUAL_RATE_ENTRY`；已填则按日志提示 `POST /fx/rates` 补录 |
| `data driver`                    | 驱动类型（memory/prisma）                   | 出现 `prisma` 才对                                                                   |

```bash
curl -s http://127.0.0.1:3000/health   # 本机自测：{"code":0,"data":{"status":"up"},...}

# 开机自启：startup + save 两步都要，缺一不可
# 🔴 pm2 save 单独不救命——没有 systemd 单元，重启后 pm2 daemon 不起，进程全丢
#    （2026-10-19 实测确认：该机 XLFamily 由 root 的 pm2 管理，ubuntu 侧无任何单元）
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save
```

## 5. nginx + 证书（约 15 分钟，依赖域名备案）

🔴 共机红线（2026-10-22 实测）：`sites-enabled/default -> sites-available/food-api`，
`listen 80; server_name 82.156.30.50;`，`/api/` 反代 `127.0.0.1:5050`，`/` 走 `/var/www/html`。
**那是另一个在跑的服务**——本步只新增 `family-trip` 站点，靠 `server_name` 分流共存，
不改不删 food-api、不加 `default_server`。

```bash
sudo cp <本目录>/nginx-family-trip.conf /etc/nginx/sites-available/family-trip
sudo ln -s /etc/nginx/sites-available/family-trip /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 证书：先确保 80 段可达（备案解析生效后）
sudo certbot --nginx -d api.<你的域名>
```

> certbot 自动续期已装 timer（`systemctl list-timers | grep certbot` 确认）。

## 6. 小程序后台配合法域名

mp.weixin.qq.com → 开发管理 → 服务器域名 → request 合法域名添加 `https://api.<你的域名>`
（合法域名有月修改次数限制，一次填对）。

## 7. 端到端验证

```bash
# 1. 链路：外网 → nginx → NestJS
curl -s https://api.<你的域名>/health

# 2. 真实登录（需要小程序端发起 wx.login，本步在开发者工具里点登录看「我的」页）
#    验收点：昵称不再每次变；改名后刷新仍在

# 3. 内存复盘（跑 24h 后看，目标：total 稳定在 75% 以下）
free -h && pm2 monit
```

## 8. 回滚（任一环节翻车）

```bash
pm2 stop family-trip && pm2 delete family-trip   # 摘服务（数据不动）
sudo rm /etc/nginx/sites-enabled/family-trip && sudo systemctl reload nginx  # 摘流量
sudo systemctl stop mysql                        # 仅当 MySQL 本身出问题
# XLFamily 全程不受以上操作影响（独立 pm2 进程 + 独立目录）
```

---

## 附：本 runbook 不覆盖的事

- **FX 签约源采购**：生产初期走人工录入（`MANUAL_RATE_ENTRY`，已实现，0 成本）；规模化后采购签约 API，在 `common/fx/sources/index.ts` 的 `resolveFxSource` 加一个分支 + `FX_AUTHORIZED_SOURCES` 追加源名即可，域代码零改动
- **数据库备份策略**：依赖第 0 节自动快照；数据重要度升级后再考虑 mysqldump 定时任务
- **升级路径**：日活 5000+ 时 MySQL 拆 RDS、机器升 4G——扩容命令届时按新环境重写
