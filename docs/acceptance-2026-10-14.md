# 验收报告：gh-proxy.7s.pub 加固

- 日期：2026-10-14（UTC）
- 被测版本：`master @ e8e90fb`（Workers Builds 自动部署）
- 执行：`scripts/acceptance.sh`，curl 8.22.0（aarch64）
- 完整原始日志：`acceptance-out-*/` 由脚本落盘；本文所有引用均为该次运行的原始输出（run3），run2 用于交叉核对

## 环境与限制（影响结果的解读）

1. 执行机经本地 `socks5h://127.0.0.1:1080` 出网，Cloudflare 响应中的 `cf-ray` 出现 AMS / LHR / HKG 轮换，说明出口 POP 不稳定。
2. 直连上游被本网络阻断：`curl --noproxy '*'` 30 秒只收到 663 KB（见下文 1.b），因此无法从本机做"代理 vs 直连"的字节对照。已改用 GitHub Releases API 的资产 `digest` 字段作为权威对照（见 1.c）。
3. 吞吐数字受上面两点影响，仅代表本机链路上的观测值，不代表最终用户网络表现。

## 结果总览

| # | 要求 | 结果 | 关键证据 |
|---|---|---|---|
| 0 | `/healthz` 200 且 <500ms | ✅ 功能通过；耗时受链路影响 1.2–1.9s | 见 0 |
| 1 | 字节透明（SHA256 与上游一致） | ✅ | 下载哈希 == GitHub API `digest`：`87db5c…78cf` |
| 2 | HEAD 头一致、无 body；Range 206；断点续传 | ✅ | 见 2；`resume.bin` 与全量文件 `cmp` 一致 |
| 3 | 条件请求 304，保留 ETag / Last-Modified | ✅ | If-None-Match 与 If-Modified-Since 均 304 |
| 4 | `releases/latest` 跟随到 tag | ✅ | `url_effective=…/releases/tag/v1.14.3` |
| 5 | 滚动资产（geoip.db）条件请求 | ✅ | `If-Modified-Since` → 304（HIT），ETag/Last-Modified 保留 |
| 6 | 并发：4 并发代理、50 并发总量 | ✅（50 并发仅对 /healthz 验证） | 4×206；50×200 |
| 7 | 白名单与协议拒绝 | ✅ | 外部域 / http / 后缀伪装全部 403 |
| 8 | 缓存命中率（样本） | ✅ 11 HIT / 2 MISS / 0 BYPASS（13 次观测） | 见 8 |

未独立验证（见"未测项"）：≥15 分钟长连接、≥2GB 单文件、代理路径的 50 并发突发（会吃掉 60/min 限流预算）。

## 原始输出（run3）

### 0. healthz

```
$ curl -sS -m 20 -D healthz.h -w '\nhttp=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s\n' https://gh-proxy.7s.pub/healthz
{"status":"ok","time":"2026-10-14T08:19:45.240Z"}
http=200 ttfb=1.891807s total=1.892001s
HTTP/2 200
content-type: application/json
content-length: 49
cache-control: no-store
cf-placement: remote-HKG
cf-ray: a4a5292ef88d95ab-AMS
```

### 1. 字节一致性

1.a 代理冷/热两次下载（均为缓存命中）：

```
$ curl -fsSL -m 900 -D cold.h -o cold.tar.gz -w 'cold http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer} total=%{time_total}\n' "$U"
cold http=200 bytes=29691063 speed=1829308 ttfb=0.810178 total=16.230794
content-length: 29691063
cf-cache-status: HIT
cache-control: public, max-age=31536000, immutable
etag: "0x8DF1A310D856A41"
x-proxy-cache: HIT
$ sha256sum cold.tar.gz
87db5c3a96ebad1c44c0be1fe7955db2f76b8c97bbc0ed62173063d675e078cf  cold.tar.gz

$ curl -fsSL -m 900 -D warm.h -o warm.tar.gz -w 'warm …' "$U"
warm http=200 bytes=29691063 speed=815909 ttfb=1.167903 total=36.390151
x-proxy-cache: HIT
$ sha256sum warm.tar.gz
87db5c3a96ebad1c44c0be1fe7955db2f76b8c97bbc0ed62173063d675e078cf  warm.tar.gz
```

1.b 直连对照（本网络阻断，仅作说明）：

```
$ curl --noproxy "*" (direct upstream, 30s cap)
curl: (28) Operation timed out after 30006 milliseconds with 663385 out of 29691063 bytes received
direct http=200 bytes=663385
direct download unavailable from this network (no-proxy path blocked)…
```

1.c 权威对照（GitHub Releases API 的资产 digest）：

```
sing-box-1.14.2-linux-arm64-glibc.tar.gz -> sha256:87db5c3a96ebad1c44c0be1fe7955db2f76b8c97bbc0ed62173063d675e078cf
```

下载长度 29,691,063 字节与 API 元数据 `size` 完全一致，哈希与 GitHub 自己计算的 digest 逐位相等。若消费方 `scripts/sing-box.sha256` 尚未固定该值，建议直接采用上面的 digest。

### 2. HEAD 与 Range

```
$ curl -sS -m 60 -I -o /dev/null -D head.h "$U"
head http=200
content-type: application/octet-stream
content-length: 29691063
accept-ranges: bytes
content-disposition: attachment; filename=sing-box-1.14.2-linux-arm64-glibc.tar.gz
etag: "0x8DF1A310D856A41"
last-modified: Thu, 24 Sep 2026 11:43:29 GMT
x-proxy-cache: HIT
cf-placement: local-LHR

$ curl -sS -m 120 -L -o /dev/null -r 0-1048575 -w 'range http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer}\n' "$U"
range http=206 bytes=1048576 speed=148092 ttfb=1.445983
content-length: 1048576
content-range: bytes 0-1048575/29691063
x-proxy-cache: HIT

$ head -c 1048576 cold.tar.gz > partial.bin; cp partial.bin resume.bin
$ curl -sS -m 900 -C - -o resume.bin -w 'resume http=%{http_code} bytes=%{size_download} speed=%{speed_download}\n' "$U"
resume http=206 bytes=28642487 speed=448900
content-range: bytes 1048576-29691062/29691063
x-proxy-cache: HIT
$ cmp resume.bin cold.tar.gz
resume bytes: identical
```

HEAD 无 body、`Content-Length` 准确；Range 与续传都是 206，续传重建出的文件与全量文件逐字节一致。

### 3. 条件请求

```
etag="0x8DF1A310D856A41"
last-modified=Thu, 24 Sep 2026 11:43:29 GMT
$ curl -sS -m 60 -o /dev/null -H "If-None-Match: $ET" -w 'if-none-match http=%{http_code}\n' "$U"
if-none-match http=304
etag: "0x8DF1A310D856A41"
last-modified: Thu, 24 Sep 2026 11:43:29 GMT
x-proxy-cache: HIT
$ curl -sS -m 60 -o /dev/null -H "If-Modified-Since: $LM" -w 'if-modified-since http=%{http_code}\n' "$U"
if-modified-since http=304
```

### 4. releases/latest

```
$ curl -sS -m 60 -o /dev/null -L -w 'latest url_effective=%{url_effective}\nhttp=%{http_code}\n' "$BASE/https://github.com/SagerNet/sing-box/releases/latest"
latest url_effective=https://gh-proxy.7s.pub/https://github.com/SagerNet/sing-box/releases/tag/v1.14.3
http=200
```

### 5. geoip.db（滚动资产）

```
geoip latest redirect_url=…/sing-geoip/releases/download/20261012/geoip.db
$ curl -sS -m 120 -I "$G2"
HTTP/2 200
content-length: 3695733
accept-ranges: bytes
cache-control: public, max-age=300
etag: "0x8DF2886720C64FB"
last-modified: Mon, 12 Oct 2026 17:30:01 GMT
x-proxy-cache: MISS

$ curl -sS -m 300 -L -o geoip.db -w 'geoip http=%{http_code} bytes=%{size_download} speed=%{speed_download} ttfb=%{time_starttransfer}\n' "$G2"
geoip http=200 bytes=3695733 speed=290718 ttfb=1.393557

$ curl -sS -m 60 -o /dev/null -H "If-Modified-Since: Mon, 12 Oct 2026 17:30:01 GMT" -w 'geoip if-modified-since http=%{http_code}\n' "$G2"
geoip if-modified-since http=304
etag: "0x8DF2886720C64FB"
last-modified: Mon, 12 Oct 2026 17:30:01 GMT
x-proxy-cache: HIT
```

滚动资产按 300s TTL 走，客户端带 `If-Modified-Since` 时未变化直接 304，不需要重新传输 3.7MB。

### 6. 并发

```
########## 6. concurrency ceiling (50 parallel healthz, no rate limit) ##########
     50 200

########## 9. concurrency (4 parallel ranges) ##########
par2 http=206 bytes=1048577 speed=351518
par3 http=206 bytes=1048577 speed=342059
par1 http=206 bytes=1048577 speed=241614
par0 http=206 bytes=1048577 speed=122242
```

### 7. 白名单与协议拒绝

```
example.com                http=403
http://github.com          http=403
github.com.evil.example    http=403
```

### 8. 缓存命中样本（同一 29.7MB 资产）

```
########## 8. cache behaviour sample (same asset, 3 HEADs) ##########
head1 http=200 ttfb=0.896996   cf-cache-status: HIT   x-proxy-cache: HIT
head2 http=200 ttfb=1.020961   cf-cache-status: HIT   x-proxy-cache: HIT
head3 http=200 ttfb=0.775991   cf-cache-status: HIT   x-proxy-cache: HIT
```

本次运行 13 次带缓存状态的响应：**HIT 11、MISS 2（geoip.db 首次回源）、BYPASS 0**，命中率 84.6%。注意缓存是 **按 POP 独立** 的：run2 中 AMS 命中、LHR 未命中（同一 URL），这也是本机出口轮换时会出现 MISS 的原因；真实用户固定线路时命中率应更高。

## 发现与建议

1. **Range 吞吐仍待复测（中）**。1MB Range 平均 148 KB/s（TTFB 1.45s 占掉一半时间），全量下载 1.83 MB/s。两者都是缓存命中，差异不来自回源，更像"小对象被逐请求开销主导"。建议：用 8MB Range 复测（`-r 0-8388607`），并在真实客户端网络测一次；若 8MB Range 仍显著低于全量，再查 Cache API 切片路径。
2. **上游头泄漏（低）**。GitHub 路径把 `via`、`x-cache`、`x-served-by`、`x-timer`、`x-ms-*`、`age` 以及 `set-cookie` 原样透传；docker 路径已有清理（`age/via/x-cache/...`）。建议统一清理，避免误导缓存判断与无谓 cookie 透传。
3. **`DEBUG_AUTH=1` 仍开着（低，需人工收尾）**。`wrangler.jsonc` 当前为 `1`，生产日志会带 `auth: bearer sub=<UUID>`。按 `docs/docker-hub-mirror.md` 的计划，加速模式 pull 核对完成后应改回 `0`。
4. **限流预算提醒（信息）**。per-IP 60 请求/60 秒对当前消费脚本（每次运行约 20 次请求）足够；若首页出现 ≥50 并发代理请求，会在一分钟内耗尽预算，第 51 个起 429。需要更高并发时调整 `ratelimits.simple.limit` 或改用 WAF 规则。
5. **未测项**：≥15 分钟长连接、≥2GB 单文件（本轮最大 29.7MB）、代理路径 50 并发突发。前两项建议用一个 100MB+ 资产或 docker 层配合 `--max-time 900` 复测；第三项建议低峰期执行。

## 复现

```
bash scripts/acceptance.sh https://gh-proxy.7s.pub [输出目录]
```

脚本逐条打印命令与原始输出；产物（响应头、下载文件、哈希）落盘到输出目录。注意脚本本身会消耗约 20 次/分钟的 per-IP 限流预算。
