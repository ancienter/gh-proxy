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
const IMMUTABLE_TTL = 31536000
const ROLLING_TTL = 60
const CACHE_STATUS_HEADER = 'x-proxy-cache'
const ROLLING_EXT_RE = /\.(?:db|mmdb|srs|dat)$/i
const HEALTHZ_PATH = '/healthz'

interface Config {
    assetUrl: string
    prefix: string
    jsdelivr: boolean
    whiteList: string[]
    assets: Fetcher | null
    limiter?: RateLimit
}

interface CachePolicy {
    ttl: number
    immutable: boolean
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
    const jsdelivr = String(env.JSDELIVR || '0').toLowerCase()
    return {
        assetUrl: normalizeAssetUrl(env.ASSET_URL || ''),
        prefix: normalizePrefix(env.PREFIX || DEFAULT_PREFIX),
        jsdelivr: jsdelivr === '1' || jsdelivr === 'true',
        whiteList: String(env.WHITE_LIST || '').split(',').map(s => s.trim()).filter(Boolean),
        assets: env.ASSETS || null,
        limiter: env.RATE_LIMITER,
    }
}

/** 上游白名单：仅 GitHub 自有域名，且必须 https（防 SSRF） */
function isAllowedUpstream(url: URL): boolean {
    if (url.protocol !== 'https:') {
        return false
    }
    const host = url.hostname
    return host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')
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
    const key = req.headers.get('cf-connecting-ip') || 'unknown'
    const { success } = await cfg.limiter.limit({ key })
    if (success) {
        return null
    }
    return new Response('too many requests', {
        status: 429,
        headers: { 'retry-after': '60', 'access-control-allow-origin': '*' },
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
        console.log(JSON.stringify({
            path: new URL(request.url).pathname.slice(0, 256),
            method: request.method,
            status: res.status,
            ms: Date.now() - start,
            cache: res.headers.get(CACHE_STATUS_HEADER) || 'none',
        }))
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

    const limited = await checkRateLimit(req, cfg)
    if (limited) {
        return limited
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
        if (!isAllowedUpstream(target)) {
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
 * 未知路径回退到主页静态资源
 */
function serveAsset(req: Request, path: string, cfg: Config): Promise<Response> {
    if (cfg.assetUrl) {
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

    let urlStr = pathname
    if (urlStr.search(/^https?:\/\//i) !== 0) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)
    if (!urlObj) {
        return new Response('bad url', { status: 400 })
    }
    if (!isAllowedUpstream(urlObj)) {
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
    const res = await proxy(urlObj, reqInit, cfg)

    if (cacheable && policy && req.method === 'GET' && res.status === 200 && isStorable(res)) {
        const cloned = res.clone()
        const stored = new Response(cloned.body, cloned)
        stored.headers.set('cache-control', `public, max-age=${policy.ttl}${policy.immutable ? ', immutable' : ''}`)
        ctx.waitUntil(cache.put(new Request(urlObj.href, { method: 'GET' }), stored).catch(() => { }))
    }

    return withCacheStatus(res, cacheable ? 'MISS' : 'BYPASS')
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

function isStorable(res: Response): boolean {
    const length = Number(res.headers.get('content-length') || '0')
    return (!length || length <= CACHE_MAX_BYTES) && res.headers.get('vary') !== '*'
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
        if (!nextUrl || !isAllowedUpstream(nextUrl)) {
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
        currentUrl = nextUrl
        reqInit = {
            method,
            headers: reqInit.headers,
            redirect: 'manual',
            signal: reqInit.signal,
        }
        res = await fetch(currentUrl.href, reqInit)
    }

    return proxyRes(res, new Headers(res.headers))
}
