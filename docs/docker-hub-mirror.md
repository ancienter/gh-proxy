# Docker Hub 只读镜像支持 — 实现计划

状态：进行中（P0 已确认，P1 起逐阶段推进）

## 目标 / 非目标

**目标**：`gh-proxy.7s.pub` 作为 Docker Hub 只读镜像。客户端（docker / containerd / podman）
只需要能访问本域名；`/token` 由本服务反代，客户端无需直连 `auth.docker.io`。

**非目标**：push（PUT/POST/PATCH 一律 405）；镜像层缓存（本期不做）；绕过 Docker 用量限额；
放行通配 R2 域名。

## P0 已确认的决策

1. **匿名放行**：`/token` 不带 `Authorization` 时允许换取匿名 token。理由：易用优先；代价是共享
   本 Worker 出口 IP 的匿名额度（Docker Hub 未认证 100 次 manifest / 6 小时 / IPv4 或 IPv6 /64 段）。
   P5 依据实测决定是否收紧为"必须带 Basic 认证"。
2. **PREFIX 必须为 `/`**：`registry-mirrors` 只接受 host（不能带路径）。当前部署即为 `/`。
3. **realm 改写**：registry 的 401 `WWW-Authenticate` 改写为指向本服务；兼容性以真实客户端在
   P3/P4 实测为准，若不兼容则回退为保留原 realm（客户端直连 auth.docker.io）。

## 路由与上游

| 客户端请求 | 上游 | 说明 |
|---|---|---|
| `GET/HEAD /v2`、`/v2/<path>` | `https://registry-1.docker.io` + 原路径与查询 | manifest、blob |
| `GET /token?service=..&scope=..` | `https://auth.docker.io/token` + 原查询 | 转发 Basic 认证，返回 token JSON |
| 其他方法 | — | 405（仅 GET/HEAD） |

**开关**：`wrangler.jsonc` 的 `DOCKER`（`"0"` 关闭，默认）。关闭时不注册路由，且 docker 相关主机
不进白名单 —— 现状零变化，可一键回滚。

## 上游白名单（仅 DOCKER=1 时生效）

- `registry-1.docker.io`
- `index.docker.io`（老客户端别名）
- `auth.docker.io`
- `production.cloudflare.docker.com`
- `docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com`（Docker Hub 的 R2 桶，精确主机）

**禁止** `*.r2.cloudflarestorage.com`：那等于开放代理到任意 R2 桶。出现新 CDN 主机时，按日志中的
跳转目标追加精确主机。

## 关键实现点

1. **跨主机跳转去掉 `Authorization`**：blob 307 到 CDN 时不把 registry token 带给第三方主机；
   同主机跳转保留。
2. **docker 路径强制 `cache-control: private, no-store`**：私有镜像的 blob 若被 zone 边缘缓存，
   匿名请求可直接命中，属数据泄漏。因此 docker 路径所有响应（含 401 与 token JSON）都加 no-store，
   `x-proxy-cache` 恒为 `BYPASS`。这不是优化项，是安全项。
3. **头透传**：`Accept`（manifest 内容协商）、`Range`、`Authorization`（Bearer / Basic）、
   `Docker-Content-Digest` 等全部保留，不解析 token 内容。
4. **限流**：现有 per-IP 限流器覆盖 `/v2/*` 与 `/token`；Docker 侧 429 与 `ratelimit-*` 响应头
   原样透传，客户端可读到剩余额度。
5. **不缓存**：本期不做任何 docker 内容缓存（私有内容无可靠公开性判据，manifest 还涉及 Accept
   内容协商）。

## 阶段与验收

- [x] **P0** 决策确认（见上）
- [x] **P1 骨架 + 开关**
  - Config 增 `docker`；`/v2/*` 路由；白名单；405；realm 改写；跨主机去 Authorization；no-store
  - 验收：CI 绿；`DOCKER=0` 时既有测试全部不变；新增单测覆盖 401 realm 改写、manifest 透传、
    blob 跨主机去 auth、非白名单跳转不跟随、405、HEAD
- [x] **P2 `/token` 反代**
  - 查询参数与 Basic 透传，JSON 原样返回，`no-store`
  - 验收：单测通过；生产 curl 能换到 token
- [x] **P3 预发验证（开关打开）**
  - 验收：`/v2/` 返回 401 且 realm 指向本服务；manifest 200 带 `Docker-Content-Digest`；
    blob 下载 SHA256 == digest；Range 206；日志 `cache: BYPASS`
  - 实测记录（2026-10-13）：token ✅、manifest index 与 amd64 manifest ✅（响应体 SHA256 ==
    `docker-content-digest`）、blob SHA256 ✅、Range 206 ✅。真实 CDN 主机为
    `production.cloudfront.docker.com`（已加入白名单），修正前 307 由客户端直连 CDN 完成，
    修正后由本服务跟随（实测客户端只见 200）
- [x] **P4 真实客户端验证**
  - `docker pull gh-proxy.7s.pub/library/alpine:latest` 成功，拉取后 digest 为
    `sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6`，与源站一致
- [ ] **P5 观测与收尾**
  - 观察日志与 429 比例（目前未出现 Docker 侧限流）；决定是否强制登录（拒绝无 Basic 的 `/token`）
  - README 已补配置片段（daemon.json / containerd / podman）与"强烈建议 docker login"说明；首页已加 Docker 使用说明
  - 认证链路验证（2026-10-13）：伪造 Basic 凭据请求 `/token` 时 Docker 返回 `401 incorrect username or password`
    → 凭据确实透传到 auth.docker.io
  - 真实账号实测（2026-10-13，用户侧）：协议级 `/token` + Basic 换到账号 token（`sub` = 账号 UUID，
    source=账号名）；显式拉取与加速模式（`registry-mirrors`）均有账号配额扣减。上游 `ratelimit-*`
    计数存在噪声（缓存回放旧值、不同 POP 填充不一致），不能作为唯一证据
  - 为此已实现两项服务端支持：
    - `DEBUG_AUTH=1`（默认 0）：日志附加 `auth: basic|bearer sub=<UUID>`，只在日志、不进响应；
      待执行：开启后做一次加速模式 pull，在 Workers Logs 核对 `/token` 的 `auth: basic` 与
      manifest 的 `auth: bearer sub=<账号 UUID>`
    - 缓存命中（HIT）响应不再回放上游 `ratelimit-*` 头，避免展示前后矛盾的数字
  - 文档已明确登录命令为 `docker login gh-proxy.7s.pub`（登录镜像，不是登录 Hub）
- [x] **P7 registry 内容缓存（2026-10-13 追加，源自运营反馈）**
  - 问题：全程 `BYPASS` 导致重复拉取无提速，且 manifest 请求持续消耗共享出口 IP 的匿名额度
  - 方案：新增 `DOCKER_CACHE`（默认 `library`）白名单，只缓存**公开命名空间**的 manifest 与 blob
    - manifest：缓存键加入 `Accept` 哈希（内容协商不能串味）；tag 引用 `max-age=300`，digest 引用一年
    - blob：按 digest 不可变，`max-age=31536000, immutable`，允许 zone 边缘缓存；Range 命中缓存直接切片
    - 私有仓库、token、401、错误响应、非 200 一律 `private, no-store`
  - **明确不做 token 缓存**：token 与调用方凭据绑定，缓存等于凭据泄露
  - 验收：单测覆盖 Accept 分桶、白名单外绕过、blob 命中与 Range；生产实测 manifest/blob HIT
  - 补充实测（2026-10-13）：3.8MB 与 68MB 层 MISS→HIT 正常；**237MB 层在 Worker 与边缘缓存都不被保留**
    （`cf-cache-status: DYNAMIC` + `MISS`），故设 `DOCKER_BLOB_CACHE_MAX = 100MB`，超限只流式转发
  - 响应去掉上游 CDN 的 `age`/`via`/`x-cache` 等痕迹（CloudFront 的 `age: 2258081` 曾与 `MISS` 同现，
    误导缓存判断）
  - Range 与整段 GET 同键：已缓存 68MB 层连续 4 次 Range 实测 4/4 HIT（0.13–0.66s）；未整段缓存过或
    超过 100MB 的层每次回源，这正是"Range 有时 HIT 有时 MISS"的来源
  - HEAD 探测在缓存命中时直接由缓存返回头部（不再回源）；`x-proxy-cache` 是写入时刻快照，
    判断边缘缓存看 `cf-cache-status`
- [ ] **P8 多 registry（待定，需先定产品范围）**
  - 现状：`/v2/ghcr.io/...` 等不代理。扩展需要按 registry 设计路由（路径前缀或独立域名）+ 各自 realm
    与 token 流程 + 各自的匿名限额策略
  - 同时评估 ghcr / quay / registry.k8s.io 的必要性与维护成本
- [ ] **P6 回滚**：`DOCKER=0` 重新部署，`/v2/*` 恢复 404

## 风险

- `auth.docker.io` 可达性（P2 验证；不可达则保留原 realm）
- Docker 对数据中心/共享 IP 的 abuse limit 可能误伤（P3 观察 429 与 `ratelimit-*`）
- 公平使用/ToS：私人加速可以，公开大规模镜像不建议
- 私有镜像：支持透传但不缓存，`no-store` 保证不泄漏

## 工作量

P1 0.5d + P2 0.5d + P3 0.5d + P4 0.5d + P5 0.25d ≈ 2–2.5 天（含测试，不含后续缓存项）
