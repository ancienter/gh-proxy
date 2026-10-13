/**
 * Cloudflare Workers ES-module version
 *
 * Config via environment variables (wrangler.toml [vars], dashboard, or .dev.vars):
 *   ASSET_URL  static assets (homepage) url
 *   PREFIX     path prefix, e.g. '/gh/' when routed as example.com/gh/*
 *   JSDELIVR   '1' to use jsDelivr mirror for blob/raw branch files, '0' off
 *   WHITE_LIST comma separated path fragments; empty means allow all
 */

const DEFAULT_ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'
const DEFAULT_PREFIX = '/'

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
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
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
 * @param {Record<string, string>} env
 */
function getConfig(env) {
    const jsdelivr = String(env.JSDELIVR || '0').toLowerCase()
    return {
        assetUrl: env.ASSET_URL || DEFAULT_ASSET_URL,
        prefix: normalizePrefix(env.PREFIX || DEFAULT_PREFIX),
        jsdelivr: jsdelivr === '1' || jsdelivr === 'true',
        whiteList: String(env.WHITE_LIST || '').split(',').map(s => s.trim()).filter(Boolean),
    }
}

export default {
    /**
     * @param {Request} request
     * @param {Record<string, string>} env
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
        return fetch(cfg.assetUrl + path)
    }
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
        body: req.body
    }
    return proxy(urlObj, reqInit, cfg)
}


/**
 *
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 * @param {ReturnType<typeof getConfig>} cfg
 */
async function proxy(urlObj, reqInit, cfg) {
    const res = await fetch(urlObj.href, reqInit)
    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    if (resHdrNew.has('location')) {
        let _location = resHdrNew.get('location')
        if (checkUrl(_location))
            resHdrNew.set('location', cfg.prefix + _location)
        else {
            reqInit.redirect = 'follow'
            return proxy(newUrl(_location), reqInit, cfg)
        }
    }
    resHdrNew.set('access-control-expose-headers', '*')
    resHdrNew.set('access-control-allow-origin', '*')

    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    return new Response(res.body, {
        status,
        headers: resHdrNew,
    })
}
