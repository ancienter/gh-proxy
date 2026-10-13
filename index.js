/**
 * Cloudflare Workers ES-module version
 *
 * Config via environment variables (wrangler.toml [vars], dashboard, or .dev.vars):
 *   ASSET_URL  optional external homepage url; empty uses the bundled "public/"
 *              assets, falling back to DEFAULT_ASSET_URL when no assets binding
 *   PREFIX     path prefix, e.g. '/gh/' when routed as example.com/gh/*
 *   JSDELIVR   '1' to use jsDelivr mirror for blob/raw branch files, '0' off
 *   WHITE_LIST comma separated path fragments; empty means allow all
 */

const DEFAULT_ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'
const DEFAULT_PREFIX = '/'
// 跟随上游跳转的最大次数，超出后把跳转原样交回客户端
const MAX_REDIRECTS = 5

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
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

/**
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, { status, headers })
}


/**
 * @param {string} urlStr
 * @param {string | URL} [base]
 */
function newUrl(urlStr, base) {
    try {
        return new URL(urlStr, base)
    } catch (err) {
        return null
    }
}

/**
 * @param {string} prefix
 */
function normalizePrefix(prefix) {
    if (!prefix.startsWith('/')) {
        prefix = '/' + prefix
    }
    if (!prefix.endsWith('/')) {
        prefix = prefix + '/'
    }
    return prefix
}

/**
 * @param {string} url
 */
function normalizeAssetUrl(url) {
    if (!url || url.endsWith('/')) {
        return url
    }
    return url + '/'
}

/**
 * @param {Record<string, any>} env
 */
function getConfig(env) {
    const jsdelivr = String(env.JSDELIVR || '0').toLowerCase()
    return {
        assetUrl: normalizeAssetUrl(env.ASSET_URL || ''),
        prefix: normalizePrefix(env.PREFIX || DEFAULT_PREFIX),
        jsdelivr: jsdelivr === '1' || jsdelivr === 'true',
        whiteList: String(env.WHITE_LIST || '').split(',').map(s => s.trim()).filter(Boolean),
        assets: env.ASSETS || null,
    }
}

export default {
    /**
     * @param {Request} request
     * @param {Record<string, any>} env
     * @param {ExecutionContext} ctx
     */
    async fetch(request, env, ctx) {
        return fetchHandler(request, getConfig(env))
            .catch(err => makeRes('cfworker error:\n' + err.stack, 502))
    }
}

function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * @param {Request} req
 * @param {ReturnType<typeof getConfig>} cfg
 */
async function fetchHandler(req, cfg) {
    const urlStr = req.url
    const urlObj = new URL(urlStr)
    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + cfg.prefix + path, 301)
    }
    if (!urlObj.pathname.startsWith(cfg.prefix)) {
        return new Response('not found', { status: 404 })
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.slice(urlObj.origin.length + cfg.prefix.length).replace(/^https?:\/+/, 'https://')
    if (path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0) {
        return httpHandler(req, path, cfg)
    } else if (path.search(exp2) === 0) {
        if (cfg.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path, cfg)
        }
    } else if (path.search(exp4) === 0) {
        if (cfg.jsdelivr) {
            const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        }
        else {
            return httpHandler(req, path, cfg)
        }
    } else {
        return serveAsset(req, path, cfg)
    }
}

/**
 * 未知路径回退到主页静态资源
 *
 * @param {Request} req
 * @param {string} path
 * @param {ReturnType<typeof getConfig>} cfg
 */
function serveAsset(req, path, cfg) {
    if (cfg.assetUrl) {
        return fetch(cfg.assetUrl + path)
    }
    if (cfg.assets) {
        // 资源绑定按完整路径匹配，需去掉 PREFIX 后再查询
        const assetUrl = new URL(req.url)
        const rest = assetUrl.pathname.slice(cfg.prefix.length)
        assetUrl.pathname = rest === '' ? '/' : '/' + rest
        return cfg.assets.fetch(assetUrl)
    }
    return fetch(DEFAULT_ASSET_URL + path)
}


/**
 * @param {Request} req
 * @param {string} pathname
 * @param {ReturnType<typeof getConfig>} cfg
 */
function httpHandler(req, pathname, cfg) {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname
    let flag = !Boolean(cfg.whiteList.length)
    for (let i of cfg.whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response("blocked", { status: 403 })
    }
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body,
        // 客户端断开时同步中止上游请求
        signal: req.signal,
    }
    return proxy(urlObj, reqInit, cfg)
}


/**
 * @param {Response} res
 * @param {Headers} headers
 */
function proxyRes(res, headers) {
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


/**
 * 请求上游，最多跟随 MAX_REDIRECTS 次跳转；
 * 命中代理范围的 location 改写前缀后交回客户端。
 *
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 * @param {ReturnType<typeof getConfig>} cfg
 */
async function proxy(urlObj, reqInit, cfg) {
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
        if (!nextUrl) {
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
