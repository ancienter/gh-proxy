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
- [ ] **P1 骨架 + 开关**
  - Config 增 `docker`；`/v2/*` 路由；白名单；405；realm 改写；跨主机去 Authorization；no-store
  - 验收：CI 绿；`DOCKER=0` 时既有测试全部不变；新增单测覆盖 401 realm 改写、manifest 透传、
    blob 跨主机去 auth、非白名单跳转不跟随、405、HEAD
- [ ] **P2 `/token` 反代**
  - 查询参数与 Basic 透传，JSON 原样返回，`no-store`
  - 验收：单测通过；生产 curl 能换到 token
- [ ] **P3 预发验证（开关打开）**
  - 验收：`/v2/` 返回 401 且 realm 指向本服务；manifest 200 带 `Docker-Content-Digest`；
    blob 下载 SHA256 == digest；Range 206；日志 `cache: BYPASS`
- [ ] **P4 真实客户端验证**
  - `docker pull gh-proxy.7s.pub/library/alpine:latest`；失败时以 containerd/podman 或 curl 仿真
    为准并记录原因（宿主机网络限制不算阻塞）
- [ ] **P5 观测与收尾**
  - 看日志与 429 比例；决定是否强制登录（拒绝无 Basic 的 `/token`）；README 补配置片段
    （daemon.json / containerd mirrors / podman registries.conf）与"强烈建议 docker login"说明
- [ ] **P6 回滚**：`DOCKER=0` 重新部署，`/v2/*` 恢复 404

## 风险

- `auth.docker.io` 可达性（P2 验证；不可达则保留原 realm）
- Docker 对数据中心/共享 IP 的 abuse limit 可能误伤（P3 观察 429 与 `ratelimit-*`）
- 公平使用/ToS：私人加速可以，公开大规模镜像不建议
- 私有镜像：支持透传但不缓存，`no-store` 保证不泄漏

## 工作量

P1 0.5d + P2 0.5d + P3 0.5d + P4 0.5d + P5 0.25d ≈ 2–2.5 天（含测试，不含后续缓存项）
