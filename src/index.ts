/**
 * Cloudflare Workers reverse proxy for GitHub downloads.
 *
 * Clients call `https://<host>/<absolute upstream url>`; only GitHub-owned
 * https hosts are reachable (SSRF guard). GET/HEAD requests to cacheable
 * asset paths are served through the Workers Cache API: immutable release
 * assets get a long TTL, rolling assets (.db and friends) keep ETag /
 * Last-Modified revalidation via the client's conditional headers.
 *
 * Config via environment variables (wrangler.jsonc vars, dashboard, or .dev.vars):
 *   ASSET_URL   optional external homepage url; empty uses the bundled "public/"
 *               assets, falling back to DEFAULT_ASSET_URL when no assets binding
 *   PREFIX      path prefix, e.g. '/gh/' when routed as example.com/gh/*
 *   JSDELIVR    '1' to use jsDelivr mirror for blob/raw branch files, '0' off
 *   WHITE_LIST  comma separated path fragments; empty means allow all
 */

const DEFAULT_ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'
const DEFAULT_PREFIX = '/'
// 跟随上游跳转的最大次数，超出后把跳转原样交回客户端
const MAX_REDIRECTS = 5
const CACHE_NAME = 'gh-proxy'
// Cache API 单对象上限为 512MB，留出余量
const CACHE_MAX_BYTES = 400 * 1024 * 1024
// docker blob 缓存上限：CF 文档标称 512MB，但实测 237MB 的层在 Worker 与边缘缓存里都不保留
// （68MB 正常），故取保守阈值，超过的对象只流式转发不缓存
const DOCKER_BLOB_CACHE_MAX = 100 * 1024 * 1024
// 开区间 Range（bytes=N-）只有起点靠前时才全量拉取填充，避免大对象带宽放大
const SLICE_FILL_MAX_PREFIX = 8 * 1024 * 1024
// docker tag manifest 的 TTL（tag 可变，取短 TTL）
const DOCKER_TAG_TTL = 300
const IMMUTABLE_TTL = 31536000
const ROLLING_TTL = 300
const CACHE_STATUS_HEADER = 'x-proxy-cache'
const ROLLING_EXT_RE = /\.(?:db|mmdb|srs|dat)$/i
const HEALTHZ_PATH = '/healthz'

interface Config {
    assetUrl: string
    prefix: string
    jsdelivr: boolean
    docker: boolean
    dockerCache: string[]
    whiteList: string[]
    assets: Fetcher | null
    limiter?: RateLimit
}

interface CachePolicy {
    ttl: number
    immutable: boolean
}

function cacheControlFor(policy: CachePolicy): string {
    return `public, max-age=${policy.ttl}${policy.immutable ? ', immutable' : ''}`
}

/** @type {ResponseInit} */
const PREFLIGHT_INIT: ResponseInit = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}

const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
const expApi = /^(?:https?:\/\/)?api\.github\.com\//i

function makeRes(body: BodyInit | null, status = 200, headers: Record<string, string> = {}): Response {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, { status, headers })
}

function newUrl(urlStr: string, base?: string | URL): URL | null {
    try {
        return new URL(urlStr, base)
    } catch (err) {
        return null
    }
}

function normalizePrefix(prefix: string): string {
    if (!prefix.startsWith('/')) {
        prefix = '/' + prefix
    }
    if (!prefix.endsWith('/')) {
        prefix = prefix + '/'
    }
    return prefix
}

function normalizeAssetUrl(url: string): string {
    if (!url || url.endsWith('/')) {
        return url
    }
    return url + '/'
}

function joinAssetUrl(base: string, path: string): string {
    return base + path.replace(/^\/+/, '')
}

function getConfig(env: Env): Config {
    return {
        assetUrl: normalizeAssetUrl(env.ASSET_URL || ''),
        prefix: normalizePrefix(env.PREFIX || DEFAULT_PREFIX),
        jsdelivr: truthy(env.JSDELIVR),
        docker: truthy(env.DOCKER),
        dockerCache: String(env.DOCKER_CACHE || '').split(',').map(s => s.trim()).filter(Boolean),
        whiteList: String(env.WHITE_LIST || '').split(',').map(s => s.trim()).filter(Boolean),
        assets: env.ASSETS || null,
        limiter: env.RATE_LIMITER,
    }
}

function truthy(value: string | undefined): boolean {
    const normalized = String(value || '').toLowerCase()
    return normalized === '1' || normalized === 'true'
}

/** Docker Hub 及其 blob CDN；仅 DOCKER=1 时启用 */
const DOCKER_HOSTS = new Set([
    'registry-1.docker.io',
    'index.docker.io',
    'auth.docker.io',
    // Docker Hub 的 blob CDN（实际观测到的跳转目标）
    'production.cloudfront.docker.com',
    'production.cloudflare.docker.com',
    'docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com',
])

/** 上游白名单：GitHub 自有域名（+ DOCKER=1 时的 Docker 主机），且必须 https（防 SSRF） */
function isAllowedUpstream(url: URL, cfg: Config): boolean {
    if (url.protocol !== 'https:') {
        return false
    }
    const host = url.hostname
    if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')) {
        return true
    }
    return cfg.docker && DOCKER_HOSTS.has(host)
}

/** 只有明确的不可变/可重验证路径进缓存 */
function getCachePolicy(url: URL): CachePolicy | null {
    if (url.hostname === 'github.com') {
        const release = url.pathname.match(/^\/[^/]+\/[^/]+\/releases\/download\/.+$/)
        if (release) {
            return ROLLING_EXT_RE.test(url.pathname)
                ? { ttl: ROLLING_TTL, immutable: false }
                : { ttl: IMMUTABLE_TTL, immutable: true }
        }
        if (/^\/[^/]+\/[^/]+\/archive\/refs\/tags\//.test(url.pathname)) {
            return { ttl: IMMUTABLE_TTL, immutable: true }
        }
        return null
    }
    if (url.hostname === 'raw.githubusercontent.com') {
        // 只缓存按 commit SHA 固定的 raw 文件
        if (/^\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(url.pathname)) {
            return { ttl: IMMUTABLE_TTL, immutable: true }
        }
    }
    return null
}

async function checkRateLimit(req: Request, cfg: Config): Promise<Response | null> {
    if (!cfg.limiter || typeof cfg.limiter.limit !== 'function') {
        return null
    }
    // Rate Limiting binding 是尽力而为的近似限流：计数器按机器本地缓存、异步同步，
    // 突发流量可能被分散到多台机器而低于阈值；需要严格限流请用 WAF rate limiting rule。
    const key = req.headers.get('cf-connecting-ip') || 'unknown'
    const { success } = await cfg.limiter.limit({ key })
    if (success) {
        return null
    }
    return new Response('too many requests', {
        status: 429,
        headers: { 'retry-after': '60', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    })
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const start = Date.now()
        const cfg = getConfig(env)
        let res: Response
        try {
            res = await handle(request, cfg, ctx)
        } catch (err) {
            res = makeRes('cfworker error:\n' + (err as Error).stack, 502)
        }
        const cache = res.headers.get(CACHE_STATUS_HEADER)
        // 只记录代理请求与错误响应，静态资源流量不进日志
        if (cache !== null || res.status >= 400) {
            console.log(JSON.stringify({
                path: new URL(request.url).pathname.slice(0, 256),
                method: request.method,
                status: res.status,
                ms: Date.now() - start,
                cache: cache || 'none',
            }))
        }
        return res
    }
}

async function handle(req: Request, cfg: Config, ctx: ExecutionContext): Promise<Response> {
    const urlObj = new URL(req.url)

    if (urlObj.pathname === HEALTHZ_PATH) {
        return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
    }

    if (cfg.docker) {
        const v2Path = cfg.prefix + 'v2'
        if (urlObj.pathname === v2Path || urlObj.pathname.startsWith(v2Path + '/')) {
            return dockerHandler(req, urlObj, cfg, ctx)
        }
        if (urlObj.pathname === cfg.prefix + 'token') {
            return tokenHandler(req, urlObj, cfg)
        }
    }

    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + cfg.prefix + path, 301)
    }
    if (!urlObj.pathname.startsWith(cfg.prefix)) {
        return new Response('not found', { status: 404 })
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.slice(urlObj.origin.length + cfg.prefix.length)
    // 显式 http:// 目标直接拒绝（合并后可能是 http:/）
    if (/^http:\/{1,2}/i.test(path)) {
        return new Response('forbidden scheme', { status: 403 })
    }
    path = path.replace(/^https?:\/+/, 'https://')

    // 绝对地址目标先过白名单，禁止 http:// 与外部域名
    if (/^https?:\/\//i.test(path)) {
        const target = newUrl(path)
        if (!target) {
            return new Response('bad url', { status: 400 })
        }
        if (!isAllowedUpstream(target, cfg)) {
            return new Response('forbidden host', { status: 403 })
        }
    }

    if (expApi.test(path) || path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0) {
        return httpHandler(req, path, cfg, ctx)
    } else if (path.search(exp2) === 0) {
        if (cfg.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path, cfg, ctx)
        }
    } else if (path.search(exp4) === 0) {
        if (cfg.jsdelivr) {
            const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        }
        else {
            return httpHandler(req, path, cfg, ctx)
        }
    } else {
        return serveAsset(req, path, cfg)
    }
}

/**
 * Docker Registry v2 只读透传（DOCKER=1）。
 *
 * 缓存：只有白名单公开命名空间（DOCKER_CACHE，默认 library）的 manifest 与 blob 进缓存；
 * 私有仓库、token、错误响应一律 `private, no-store`，绝不让私有内容进入共享缓存。
 * manifest 按 Accept 区分缓存键（内容协商）；blob 按 digest 寻址、不可变，可长期缓存。
 */
async function dockerHandler(req: Request, urlObj: URL, cfg: Config, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', {
            status: 405,
            headers: { 'allow': 'GET, HEAD', 'cache-control': 'no-store' },
        })
    }
    const limited = await checkRateLimit(req, cfg)
    if (limited) {
        return limited
    }

    const target = parseDockerPath(urlObj.pathname)
    const cacheable = req.method === 'GET' &&
        (target.kind === 'blobs' || target.kind === 'manifests') &&
        isPublicRepo(target.repo, cfg)
    const cacheKey = dockerCacheKey(target, urlObj, req)

    if (cacheable && cacheKey) {
        const cache = await caches.open(CACHE_NAME)
        const hit = await cache.match(dockerMatchRequest(cacheKey, req, target.kind === 'blobs'), { ignoreMethod: true })
        if (hit) {
            return dockerResponse(hit, 'HIT', target)
        }
        const registryUrl = dockerUpstreamUrl(urlObj, cfg)
        const res = await proxy(registryUrl, {
            method: req.method,
            headers: new Headers(req.headers),
            redirect: 'manual',
            signal: req.signal,
        }, cfg)
        if (res.status === 200 && isStorable(res, target.kind === 'blobs' ? DOCKER_BLOB_CACHE_MAX : CACHE_MAX_BYTES)) {
            const ttl = dockerTtl(target, urlObj.pathname)
            const cloned = res.clone()
            const stored = new Response(cloned.body, cloned)
            stored.headers.set('cache-control', `public, max-age=${ttl}${ttl === IMMUTABLE_TTL ? ', immutable' : ''}`)
            ctx.waitUntil(cache.put(cacheKey, stored).catch(() => { }))
        }
        return dockerResponse(res.status === 401 ? rewriteAuthRealm(res, urlObj, cfg) : res, 'MISS', target)
    }

    const registryUrl = dockerUpstreamUrl(urlObj, cfg)
    const res = await proxy(registryUrl, {
        method: req.method,
        headers: new Headers(req.headers),
        redirect: 'manual',
        signal: req.signal,
    }, cfg)
    return dockerResponse(res.status === 401 ? rewriteAuthRealm(res, urlObj, cfg) : res, 'BYPASS', target)
}

function dockerUpstreamUrl(urlObj: URL, cfg: Config): URL {
    const registryUrl = new URL('https://registry-1.docker.io/')
    registryUrl.pathname = urlObj.pathname.slice(cfg.prefix.length - 1)
    registryUrl.search = urlObj.search
    return registryUrl
}

interface DockerTarget {
    repo: string | null
    kind: 'manifests' | 'blobs' | 'other'
}

function parseDockerPath(pathname: string): DockerTarget {
    const match = /\/v2\/(.+?)\/(manifests|blobs)\//.exec(pathname)
    if (!match) {
        return { repo: null, kind: 'other' }
    }
    return { repo: match[1], kind: match[2] as 'manifests' | 'blobs' }
}

/** 只缓存明确公开的命名空间（library 为 Docker 官方命名空间，永远公开） */
function isPublicRepo(repo: string | null, cfg: Config): boolean {
    if (!repo) {
        return false
    }
    return cfg.dockerCache.some((prefix) => repo.startsWith(prefix + '/'))
}

function hashString(value: string): string {
    let hash = 2166136261
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16)
}

/** manifest 按 Accept 分桶，避免内容协商拿错变体；blob 不需要 */
function dockerCacheKey(target: DockerTarget, urlObj: URL, req: Request): Request | null {
    if (target.kind === 'other') {
        return null
    }
    const key = new URL(urlObj.href)
    if (target.kind === 'manifests') {
        key.searchParams.set('__accept', hashString(req.headers.get('accept') || ''))
    }
    return new Request(key.href, { method: 'GET' })
}

function dockerMatchRequest(key: Request, req: Request, withRange: boolean): Request {
    const headers = new Headers()
    if (withRange) {
        const range = req.headers.get('range')
        if (range) {
            headers.set('range', range)
        }
    }
    return new Request(key.url, { method: 'GET', headers })
}

function dockerTtl(target: DockerTarget, pathname: string): number {
    if (target.kind === 'blobs' || pathname.includes('/manifests/sha256:')) {
        return IMMUTABLE_TTL
    }
    return DOCKER_TAG_TTL
}

/** 把 401 的 realm 指向本服务 */
function rewriteAuthRealm(res: Response, urlObj: URL, cfg: Config): Response {
    const challenge = res.headers.get('www-authenticate')
    if (!challenge || !challenge.includes('realm=')) {
        return res
    }
    const realm = `https://${urlObj.host}${cfg.prefix}token`
    const headers = new Headers(res.headers)
    headers.set('www-authenticate', challenge.replace(/realm="[^"]*"/, `realm="${realm}"`))
    return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
    })
}

/**
 * docker 路径响应：
 * - 只有公开命名空间的 blob（200）允许公共缓存（含 zone 边缘），重复拉取可直接命中
 * - manifest 有内容协商，客户端侧仍 no-store，缓存由 Worker 的 Cache API 承担
 * - 私有仓库、token、错误、部分响应一律 private, no-store
 */
function dockerResponse(res: Response, cacheStatus: 'HIT' | 'MISS' | 'BYPASS', target: DockerTarget): Response {
    const headers = new Headers(res.headers)
    headers.set(CACHE_STATUS_HEADER, cacheStatus)
    // 去掉上游 CDN 的缓存痕迹（CloudFront 常驻几十天的 age 会让人误判缓存状态）
    for (const name of ['age', 'via', 'x-cache', 'x-cache-hits', 'x-served-by', 'x-timer']) {
        headers.delete(name)
    }
    const publicBlob = target.kind === 'blobs' && res.status === 200 && cacheStatus !== 'BYPASS'
    if (publicBlob) {
        headers.set('cache-control', `public, max-age=${IMMUTABLE_TTL}, immutable`)
    } else {
        headers.set('cache-control', 'private, no-store')
    }
    return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
    })
}

/** 反代 auth.docker.io/token，客户端无需直连该域名 */
async function tokenHandler(req: Request, urlObj: URL, cfg: Config): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', {
            status: 405,
            headers: { 'allow': 'GET, HEAD', 'cache-control': 'no-store' },
        })
    }
    const limited = await checkRateLimit(req, cfg)
    if (limited) {
        return limited
    }
    const tokenUrl = new URL('https://auth.docker.io/token')
    tokenUrl.search = urlObj.search
    // Basic 凭据（docker login）随请求头透传；匿名请求不带该头
    // token 与调用方凭据绑定，绝不进任何缓存
    const res = await proxy(tokenUrl, {
        method: 'GET',
        headers: new Headers(req.headers),
        redirect: 'manual',
        signal: req.signal,
    }, cfg)
    return dockerResponse(res, 'BYPASS', { repo: null, kind: 'other' })
}

/**
 * 未知路径回退到主页静态资源
 */
function serveAsset(req: Request, path: string, cfg: Config): Promise<Response> {    if (cfg.assetUrl) {
        return fetch(joinAssetUrl(cfg.assetUrl, path))
    }
    if (cfg.assets) {
        // 资源绑定按完整路径匹配，需去掉 PREFIX 后再查询
        const assetUrl = new URL(req.url)
        const rest = assetUrl.pathname.slice(cfg.prefix.length)
        assetUrl.pathname = rest === '' ? '/' : '/' + rest
        // 转发条件请求与压缩相关头，其余（host、cookie 等）对静态资源无意义
        const headers = new Headers()
        for (const name of ['accept-encoding', 'if-modified-since', 'if-none-match', 'range']) {
            const value = req.headers.get(name)
            if (value) {
                headers.set(name, value)
            }
        }
        // 静态资源只支持 GET/HEAD
        return cfg.assets.fetch(new Request(assetUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers,
        }))
    }
    return fetch(joinAssetUrl(DEFAULT_ASSET_URL, path))
}

async function httpHandler(req: Request, pathname: string, cfg: Config, ctx: ExecutionContext): Promise<Response> {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    // 限流只作用于上游代理路径，页面静态资源与 /healthz 不受影响
    const limited = await checkRateLimit(req, cfg)
    if (limited) {
        return limited
    }

    let urlStr = pathname
    if (urlStr.search(/^https?:\/\//i) !== 0) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)
    if (!urlObj) {
        return new Response('bad url', { status: 400 })
    }
    if (!isAllowedUpstream(urlObj, cfg)) {
        return new Response('forbidden host', { status: 403 })
    }

    let flag = !Boolean(cfg.whiteList.length)
    for (let i of cfg.whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response('blocked', { status: 403 })
    }

    // 带 Authorization 的请求（私有仓库）不经过缓存
    const policy = getCachePolicy(urlObj)
    const cacheable = policy !== null &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        !reqHdrRaw.has('authorization')
    const cache = await caches.open(CACHE_NAME)

    if (cacheable) {
        const hit = await cache.match(cacheKeyRequest(urlObj, req), { ignoreMethod: true })
        if (hit) {
            return withCacheStatus(req.method === 'HEAD' ? headResponse(hit) : hit, 'HIT')
        }
    }

    /** @type {RequestInit} */
    const reqInit: RequestInit = {
        method: req.method,
        headers: new Headers(reqHdrRaw),
        redirect: 'manual',
        body: req.body,
        // 客户端断开时同步中止上游请求
        signal: req.signal,
    }
    const rangeHeader = reqHdrRaw.get('range')
    // 只对"下载剩余部分"的开区间 Range 做拉全量切片填充；
    // 条件请求由上游语义决定，不做切片
    const openRange = cacheable && policy && req.method === 'GET' && rangeHeader
        ? parseOpenRange(rangeHeader)
        : null
    const res = openRange &&
        policy &&
        openRange.start <= SLICE_FILL_MAX_PREFIX &&
        !reqHdrRaw.has('if-none-match') &&
        !reqHdrRaw.has('if-modified-since')
        ? await serveOpenRangeFromOrigin(reqInit, urlObj, cfg, cache, policy, ctx, openRange.start)
        : await proxy(urlObj, reqInit, cfg)

    if (cacheable && policy && req.method === 'GET' && res.status === 200 && isStorable(res)) {
        // 缓存副本必须保留原始 response（含 content-length），
        // 包一层流会丢掉 content-length，导致缓存命中时 Range/HEAD 头部缺失
        const cloned = res.clone()
        const stored = new Response(cloned.body, cloned)
        stored.headers.set('cache-control', cacheControlFor(policy))
        ctx.waitUntil(cache.put(new Request(urlObj.href, { method: 'GET' }), stored).catch(() => { }))
    }

    // 成功响应带上与缓存一致的 Cache-Control，让 zone 边缘缓存也能直接命中；
    // 上游 release 资产默认不带 cache-control，缺了这行边缘会一直回源
    if (policy && res.status === 200 &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        !reqHdrRaw.has('authorization')) {
        res.headers.set('cache-control', cacheControlFor(policy))
    }

    // 错误响应与私有仓库响应禁止任何共享缓存（含 zone 级 Cache Rule）
    if (res.status >= 400 || reqHdrRaw.has('authorization')) {
        res.headers.set('cache-control', 'no-store')
    }

    return withCacheStatus(res, cacheable ? 'MISS' : 'BYPASS')
}

interface ByteRange {
    start: number
    end: number
}

/** 仅接受开区间单段 Range：bytes=N- */
function parseOpenRange(header: string): { start: number } | null {
    const match = /^bytes=(\d+)-$/.exec(header.trim())
    if (!match) {
        return null
    }
    const start = Number(match[1])
    return Number.isFinite(start) ? { start } : null
}

/** 跳过前缀并截断到指定长度；客户端读完后取消上游，缓存分支继续填充 */
function sliceStream(body: ReadableStream<Uint8Array> | null, start: number, length: number): ReadableStream<Uint8Array> | null {
    if (!body) {
        return null
    }
    let skipped = 0
    let sent = 0
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            let offset = 0
            if (skipped < start) {
                const need = start - skipped
                if (chunk.byteLength <= need) {
                    skipped += chunk.byteLength
                    return
                }
                offset = need
                skipped = start
            }
            const part = chunk.subarray(offset, offset + (length - sent))
            sent += part.byteLength
            controller.enqueue(part)
            if (sent >= length) {
                controller.terminate()
            }
        },
    }))
}

function sliceResponse(res: Response, range: ByteRange, total: number): Response {
    const headers = new Headers(res.headers)
    headers.set('content-range', `bytes ${range.start}-${range.end}/${total}`)
    headers.set('content-length', String(range.end - range.start + 1))
    headers.set('accept-ranges', 'bytes')
    return new Response(sliceStream(res.body, range.start, range.end - range.start + 1), {
        status: 206,
        statusText: res.statusText,
        headers,
    })
}

/**
 * 冷缓存的开区间 Range（bytes=N-）：拉全量后在本地切片并填充缓存，
 * 后续 Range/全量下载即可命中。对象超过缓存上限、无长度、带 content-encoding
 * 或起点超出对象时退回透传 Range。
 */
async function serveOpenRangeFromOrigin(
    reqInit: RequestInit,
    urlObj: URL,
    cfg: Config,
    cache: Cache,
    policy: CachePolicy,
    ctx: ExecutionContext,
    start: number,
): Promise<Response> {
    const headers = new Headers(reqInit.headers)
    headers.delete('range')
    const full = await proxy(urlObj, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: reqInit.signal,
    }, cfg)
    const total = Number(full.headers.get('content-length') || '0')
    const usable = full.status === 200 &&
        total > start &&
        total <= CACHE_MAX_BYTES &&
        !full.headers.get('content-encoding')
    if (!usable) {
        await full.body?.cancel()
        return proxy(urlObj, reqInit, cfg)
    }
    const cloned = full.clone()
    const stored = new Response(cloned.body, cloned)
    stored.headers.set('cache-control', cacheControlFor(policy))
    ctx.waitUntil(cache.put(new Request(urlObj.href, { method: 'GET' }), stored).catch(() => { }))
    return sliceResponse(full, { start, end: total - 1 }, total)
}

function cacheKeyRequest(urlObj: URL, req: Request): Request {
    const headers = new Headers()
    for (const name of ['if-none-match', 'if-modified-since']) {
        const value = req.headers.get(name)
        if (value) {
            headers.set(name, value)
        }
    }
    if (req.method === 'GET') {
        const range = req.headers.get('range')
        if (range) {
            headers.set('range', range)
        }
    }
    return new Request(urlObj.href, { method: 'GET', headers })
}

function withCacheStatus(res: Response, status: 'HIT' | 'MISS' | 'BYPASS'): Response {
    const headers = new Headers(res.headers)
    headers.set(CACHE_STATUS_HEADER, status)
    return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
    })
}

function headResponse(res: Response): Response {
    return new Response(null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
    })
}

function isStorable(res: Response, maxBytes = CACHE_MAX_BYTES): boolean {
    // 没有 content-length 的响应（codeload 动态生成的 tag archive 是 chunked）也允许入缓存；
    // 超出平台缓存上限时由 cache.put 自行拒绝，调用处已 catch
    const length = Number(res.headers.get('content-length') || '0')
    return (!length || length <= maxBytes) && res.headers.get('vary') !== '*'
}

function proxyRes(res: Response, headers: Headers): Response {
    headers.set('access-control-expose-headers', '*')
    headers.set('access-control-allow-origin', '*')

    headers.delete('content-security-policy')
    headers.delete('content-security-policy-report-only')
    headers.delete('clear-site-data')

    return new Response(res.body, {
        status: res.status,
        headers,
    })
}

function withoutAuthorization(headers: HeadersInit | undefined): Headers {
    const copy = new Headers(headers)
    copy.delete('authorization')
    return copy
}

function checkUrl(u: string): boolean {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * 请求上游，最多跟随 MAX_REDIRECTS 次跳转；
 * 命中代理范围的 location 改写前缀后交回客户端。
 * 跳转目标同样受白名单限制。
 */
async function proxy(urlObj: URL, reqInit: RequestInit, cfg: Config): Promise<Response> {
    let currentUrl = urlObj
    let res = await fetch(currentUrl.href, reqInit)

    for (let i = 0; i < MAX_REDIRECTS; i++) {
        const location = res.headers.get('location')
        if (res.status < 300 || res.status >= 400 || !location) {
            break
        }
        if (checkUrl(location)) {
            const headers = new Headers(res.headers)
            headers.set('location', cfg.prefix + location)
            return proxyRes(res, headers)
        }
        const nextUrl = newUrl(location, currentUrl)
        if (!nextUrl || !isAllowedUpstream(nextUrl, cfg)) {
            break
        }
        let method = reqInit.method || 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
            if (res.status === 303) {
                method = 'GET'
            } else if ((res.status === 301 || res.status === 302) && method === 'POST') {
                method = 'GET'
            } else {
                // 307/308 等需要重放请求体，而 body 已随上一个请求消费，交回客户端处理
                break
            }
        }
        // 跨主机跳转不携带 Authorization（registry token 不外泄给 CDN 等第三方主机）
        const headers = nextUrl.hostname === currentUrl.hostname
            ? reqInit.headers
            : withoutAuthorization(reqInit.headers)
        currentUrl = nextUrl
        reqInit = {
            method,
            headers,
            redirect: 'manual',
            signal: reqInit.signal,
        }
        res = await fetch(currentUrl.href, reqInit)
    }

    return proxyRes(res, new Headers(res.headers))
}
