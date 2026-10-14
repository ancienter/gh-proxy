import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

interface MockCall {
    url: URL
    method: string
    headers?: Headers
    body: BodyInit | null | undefined
    signal: AbortSignal | null | undefined
}

type Responder = (call: MockCall) => Response | null

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers })

const calls: MockCall[] = []
let responder: Responder = () => null

/** Route a specific method + absolute URL to a canned response. */
const route = (method: string, href: string, make: (call: MockCall) => Response = () => text('ok')): Responder =>
    (call) => (call.method === method && call.url.href === href ? make(call) : null)

const anyRoute = (...routes: Responder[]): Responder =>
    (call) => {
        for (const r of routes) {
            const res = r(call)
            if (res) {
                return res
            }
        }
        return null
    }

const originalFetch = globalThis.fetch

beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = init?.method || (input instanceof Request ? input.method : 'GET')
        const call: MockCall = {
            url: new URL(url),
            method,
            headers: init?.headers ? new Headers(init.headers) : undefined,
            body: init?.body,
            signal: init?.signal,
        }
        calls.push(call)
        const res = responder(call)
        if (!res) {
            throw new Error(`unmocked fetch: ${method} ${call.url.href}`)
        }
        return res
    }) as typeof fetch
})

afterAll(() => {
    globalThis.fetch = originalFetch
})

beforeEach(() => {
    calls.length = 0
    responder = () => null
})

const baseEnv = (overrides: Record<string, unknown> = {}): Env => ({
    ASSETS: env.ASSETS,
    ASSET_URL: '',
    PREFIX: '/',
    JSDELIVR: '0',
    WHITE_LIST: '',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
} as unknown as Env)

const call = async (url: string, init?: RequestInit, overrides?: Record<string, unknown>): Promise<Response> => {
    const ctx = createExecutionContext()
    const res = await worker.fetch(new Request(url, init), baseEnv(overrides), ctx)
    await waitOnExecutionContext(ctx)
    return res
}

describe('routing', () => {
    it('redirects ?q= to the prefixed path', async () => {
        const res = await call('https://example.com/?q=github.com/a/b/archive/master.zip')
        expect(res.status).toBe(301)
        expect(res.headers.get('location')).toBe('https://example.com/github.com/a/b/archive/master.zip')
    })

    it('redirects ?q= with a custom PREFIX', async () => {
        const res = await call('https://example.com/gh/?q=github.com/a/b/archive/master.zip', undefined, { PREFIX: '/gh/' })
        expect(res.status).toBe(301)
        expect(res.headers.get('location')).toBe('https://example.com/gh/github.com/a/b/archive/master.zip')
    })

    it('returns 404 for paths outside PREFIX', async () => {
        const res = await call('https://example.com/whatever', undefined, { PREFIX: '/gh/' })
        expect(res.status).toBe(404)
    })

    it('answers CORS preflight without touching the origin', async () => {
        const res = await call('https://example.com/github.com/a/b/archive/x.zip', {
            method: 'OPTIONS',
            headers: { 'access-control-request-headers': 'x' },
        })
        expect(res.status).toBe(204)
        expect(calls).toHaveLength(0)
    })
})

describe('proxying', () => {
    it('proxies archive requests and adds CORS headers', async () => {
        responder = route('GET', 'https://github.com/a/b/archive/master.zip', () => text('upstream'))

        const res = await call('https://example.com/github.com/a/b/archive/master.zip')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('upstream')
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
        expect(res.headers.get('access-control-expose-headers')).toBe('*')
    })

    it('rewrites /blob/ to /raw/ when jsDelivr is off', async () => {
        responder = route('GET', 'https://github.com/a/b/raw/master/f.js', () => text('raw-file'))

        const res = await call('https://example.com/github.com/a/b/blob/master/f.js')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('raw-file')
        // 非缓存策略路径不应被安上长 TTL
        expect(res.headers.get('cache-control')).toBeNull()
    })

    it('redirects blob and raw requests to jsDelivr when enabled', async () => {
        const blob = await call('https://example.com/github.com/a/b/blob/master/f.js', undefined, { JSDELIVR: '1' })
        expect(blob.status).toBe(302)
        expect(blob.headers.get('location')).toBe('https://cdn.jsdelivr.net/gh/a/b@master/f.js')

        const raw = await call('https://example.com/raw.githubusercontent.com/a/b/master/f.js', undefined, { JSDELIVR: 'true' })
        expect(raw.status).toBe(302)
        expect(raw.headers.get('location')).toBe('https://cdn.jsdelivr.net/gh/a/b@master/f.js')
    })

    it('passes HEAD requests through to the origin', async () => {
        responder = route('HEAD', 'https://github.com/a/b/archive/master.zip', () =>
            new Response(null, { status: 200, headers: { 'content-type': 'application/zip' } }))

        const res = await call('https://example.com/github.com/a/b/archive/master.zip', { method: 'HEAD' })
        expect(res.status).toBe(200)
        expect(calls[0].method).toBe('HEAD')
    })

    it('enforces WHITE_LIST', async () => {
        const blocked = await call('https://example.com/github.com/a/b/archive/x.zip', undefined, { WHITE_LIST: '/foo/,/bar/' })
        expect(blocked.status).toBe(403)

        responder = route('GET', 'https://github.com/foo/b/archive/x.zip', () => text('allowed'))
        const allowed = await call('https://example.com/github.com/foo/b/archive/x.zip', undefined, { WHITE_LIST: '/foo/,/bar/' })
        expect(allowed.status).toBe(200)
    })
})

describe('redirects', () => {
    it('rewrites proxy-aware redirect locations with PREFIX', async () => {
        responder = route('GET', 'https://github.com/a/b/archive/master.zip', () =>
            text('', 302, { location: 'https://github.com/a/b/releases/download/v1/x.zip' }))

        const res = await call('https://example.com/gh/github.com/a/b/archive/master.zip', undefined, { PREFIX: '/gh/' })
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('/gh/https://github.com/a/b/releases/download/v1/x.zip')
    })

    it('resolves relative locations against the current URL', async () => {
        responder = anyRoute(
            route('GET', 'https://github.com/a/b/archive/master.zip', () => text('', 302, { location: '/redirected' })),
            route('GET', 'https://github.com/redirected', () => text('final')),
        )

        const res = await call('https://example.com/github.com/a/b/archive/master.zip')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('final')
        expect(calls[1].url.href).toBe('https://github.com/redirected')
    })

    it('caps redirect following and hands the last one back', async () => {
        responder = anyRoute(
            route('GET', 'https://github.com/a/b/archive/master.zip', () => text('', 302, { location: 'https://codeload.github.com/x' })),
            route('GET', 'https://codeload.github.com/x', () => text('', 302, { location: 'https://codeload.github.com/x' })),
        )

        const res = await call('https://example.com/github.com/a/b/archive/master.zip')
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('https://codeload.github.com/x')
        expect(calls).toHaveLength(6)
    })

    it('re-issues a redirected POST as GET without the consumed body', async () => {
        responder = anyRoute(
            route('POST', 'https://github.com/a/b/git-upload-pack', () => text('', 302, { location: 'https://codeload.github.com/x' })),
            route('GET', 'https://codeload.github.com/x', () => text('posted-as-get')),
        )

        const res = await call('https://example.com/github.com/a/b/git-upload-pack', { method: 'POST', body: 'payload' })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('posted-as-get')
        expect(calls).toHaveLength(2)
        expect(calls[1].method).toBe('GET')
        expect(calls[1].body ?? null).toBeNull()
    })

    it('hands 307 back instead of replaying a consumed body', async () => {
        responder = route('POST', 'https://github.com/a/b/git-upload-pack', () =>
            text('', 307, { location: 'https://codeload.github.com/x' }))

        const res = await call('https://example.com/github.com/a/b/git-upload-pack', { method: 'POST', body: 'payload' })
        expect(res.status).toBe(307)
        expect(res.headers.get('location')).toBe('https://codeload.github.com/x')
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
        expect(calls).toHaveLength(1)
    })

    it('forwards the client abort signal to the upstream request', async () => {
        responder = route('GET', 'https://github.com/a/b/archive/master.zip', () => text('ok'))

        const res = await call('https://example.com/github.com/a/b/archive/master.zip')
        expect(res.status).toBe(200)
        expect(calls[0].signal).toBeInstanceOf(AbortSignal)
    })
})

describe('homepage', () => {
    it('serves the bundled index.html at the root', async () => {
        const res = await call('https://example.com/')
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        expect(await res.text()).toContain('gh-proxy')
    })

    it('serves the favicon and answers conditional requests', async () => {
        const first = await call('https://example.com/favicon.ico')
        expect(first.status).toBe(200)
        const etag = first.headers.get('etag')
        expect(etag).toBeTruthy()

        const second = await call('https://example.com/favicon.ico', { headers: { 'if-none-match': etag as string } })
        expect(second.status).toBe(304)
    })

    it('answers HEAD for bundled assets', async () => {
        const res = await call('https://example.com/', { method: 'HEAD' })
        expect(res.status).toBe(200)
    })

    it('strips PREFIX before looking up bundled assets', async () => {
        const res = await call('https://example.com/gh/', undefined, { PREFIX: '/gh/' })
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('gh-proxy')
    })

    it('uses ASSET_URL when set, normalizing the trailing slash', async () => {
        responder = route('GET', 'https://page.example/x', () => text('external-page'))

        const res = await call('https://example.com/x', undefined, { ASSET_URL: 'https://page.example' })
        expect(await res.text()).toBe('external-page')
    })

    it('joins asset urls without doubling slashes', async () => {
        responder = route('GET', 'https://page.example/foo', () => text('external-page'))

        const res = await call('https://example.com//foo', undefined, { ASSET_URL: 'https://page.example/' })
        expect(await res.text()).toBe('external-page')
    })

    it('falls back to the upstream page without an assets binding', async () => {
        responder = route('GET', 'https://hunshcn.github.io/gh-proxy/whatever', () => text('upstream-page'))

        const res = await call('https://example.com/whatever', undefined, { ASSETS: undefined })
        expect(await res.text()).toBe('upstream-page')
    })
})

describe('upstream allowlist', () => {
    it('rejects hosts outside GitHub', async () => {
        const res = await call('https://example.com/https://example.com/x')
        expect(res.status).toBe(403)
        expect(calls).toHaveLength(0)
    })

    it('rejects plain http upstreams', async () => {
        const res = await call('https://example.com/http://github.com/a/b/archive/x.zip')
        expect(res.status).toBe(403)
        expect(calls).toHaveLength(0)
    })

    it('rejects plain http upstreams after the edge collapses double slashes', async () => {
        const res = await call('https://example.com/http:/github.com/a/b/archive/x.zip')
        expect(res.status).toBe(403)
        expect(calls).toHaveLength(0)
    })

    it('does not follow redirects to hosts outside the allowlist', async () => {
        responder = route('GET', 'https://github.com/a/b/releases/download/v1/x.bin', () =>
            text('', 302, { location: 'https://example.com/evil' }))

        const res = await call('https://example.com/https://github.com/a/b/releases/download/v1/x.bin')
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('https://example.com/evil')
        expect(calls).toHaveLength(1)
    })

    it('proxies api.github.com without caching', async () => {
        responder = route('GET', 'https://api.github.com/repos/a/b/releases/latest', () => text('{"tag_name":"v1"}'))

        const res = await call('https://example.com/https://api.github.com/repos/a/b/releases/latest')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('{"tag_name":"v1"}')
        expect(res.headers.get('x-proxy-cache')).toBe('BYPASS')
    })
})

describe('cache', () => {
    const upstream = 'https://github.com/cachetest/repo/releases/download/v1.0.0/file.bin'
    const viaProxy = 'https://example.com/https://github.com/cachetest/repo/releases/download/v1.0.0/file.bin'

    it('caches immutable assets and serves conditional, range and HEAD requests from cache', async () => {
        let upstreamCalls = 0
        responder = route('GET', upstream, () => {
            upstreamCalls++
            return new Response('0123456789', {
                status: 200,
                headers: {
                    'content-length': '10',
                    'etag': '"v1"',
                    'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
                    'accept-ranges': 'bytes',
                },
            })
        })

        const first = await call(viaProxy)
        expect(first.headers.get('x-proxy-cache')).toBe('MISS')
        expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect(await first.text()).toBe('0123456789')

        const second = await call(viaProxy)
        expect(second.headers.get('x-proxy-cache')).toBe('HIT')
        expect(await second.text()).toBe('0123456789')
        expect(upstreamCalls).toBe(1)

        const conditional = await call(viaProxy, { headers: { 'if-none-match': '"v1"' } })
        expect(conditional.status).toBe(304)
        expect(conditional.headers.get('x-proxy-cache')).toBe('HIT')

        const ranged = await call(viaProxy, { headers: { range: 'bytes=2-5' } })
        expect(ranged.status).toBe(206)
        expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
        expect(await ranged.text()).toBe('2345')

        const head = await call(viaProxy, { method: 'HEAD' })
        expect(head.status).toBe(200)
        expect(head.headers.get('content-length')).toBe('10')
        expect(await head.text()).toBe('')
    })

    it('serves a cold open-ended range from a full fetch and fills the cache', async () => {
        const upstream = 'https://github.com/cachetest/range/releases/download/v1/file.bin'
        const viaProxy = 'https://example.com/https://github.com/cachetest/range/releases/download/v1/file.bin'
        const upstreamRanges: string[] = []
        responder = (call) => {
            if (call.url.href !== upstream) {
                return null
            }
            upstreamRanges.push(call.headers?.get('range') || 'full')
            return new Response('0123456789', {
                status: 200,
                headers: { 'content-length': '10', 'accept-ranges': 'bytes', 'etag': '"v1"' },
            })
        }

        const ranged = await call(viaProxy, { headers: { range: 'bytes=2-' } })
        expect(ranged.status).toBe(206)
        expect(ranged.headers.get('content-range')).toBe('bytes 2-9/10')
        expect(ranged.headers.get('content-length')).toBe('8')
        expect(await ranged.text()).toBe('23456789')
        expect(upstreamRanges).toEqual(['full'])

        const full = await call(viaProxy)
        expect(full.headers.get('x-proxy-cache')).toBe('HIT')
        expect(await full.text()).toBe('0123456789')
        expect(upstreamRanges).toEqual(['full'])
    })

    it('forwards bounded ranges without fetching the whole object', async () => {
        const upstream = 'https://github.com/cachetest/bounded/releases/download/v1/file.bin'
        const viaProxy = 'https://example.com/https://github.com/cachetest/bounded/releases/download/v1/file.bin'
        const upstreamRanges: string[] = []
        responder = (call) => {
            if (call.url.href !== upstream) {
                return null
            }
            upstreamRanges.push(call.headers?.get('range') || 'full')
            return new Response('0123', {
                status: 206,
                headers: { 'content-length': '4', 'content-range': 'bytes 0-3/300000000', 'accept-ranges': 'bytes' },
            })
        }

        const res = await call(viaProxy, { headers: { range: 'bytes=0-1023' } })
        expect(res.status).toBe(206)
        expect(res.headers.get('content-range')).toBe('bytes 0-3/300000000')
        expect(await res.text()).toBe('0123')
        expect(upstreamRanges).toEqual(['bytes=0-1023'])
    })

    it('skips slice filling for conditional requests', async () => {
        const upstream = 'https://github.com/cachetest/conditional/releases/download/v1/file.bin'
        const viaProxy = 'https://example.com/https://github.com/cachetest/conditional/releases/download/v1/file.bin'
        const upstreamRanges: string[] = []
        responder = (call) => {
            if (call.url.href !== upstream) {
                return null
            }
            upstreamRanges.push(call.headers?.get('range') || 'full')
            return new Response('ab', {
                status: 206,
                headers: { 'content-length': '2', 'content-range': 'bytes 0-1/10', 'accept-ranges': 'bytes' },
            })
        }

        const res = await call(viaProxy, {
            headers: { range: 'bytes=0-', 'if-none-match': '"v1"' },
        })
        expect(res.status).toBe(206)
        expect(upstreamRanges).toEqual(['bytes=0-'])
    })

    it('falls back when the upstream response is content-encoded', async () => {
        const upstream = 'https://github.com/cachetest/encoded/releases/download/v1/file.txt'
        const viaProxy = 'https://example.com/https://github.com/cachetest/encoded/releases/download/v1/file.txt'
        const upstreamRanges: string[] = []
        responder = (call) => {
            if (call.url.href !== upstream) {
                return null
            }
            const range = call.headers?.get('range')
            upstreamRanges.push(range || 'full')
            if (range) {
                return new Response('zip', {
                    status: 206,
                    headers: { 'content-length': '3', 'content-range': 'bytes 0-2/100', 'accept-ranges': 'bytes' },
                })
            }
            return new Response('encoded', {
                status: 200,
                headers: { 'content-length': '100', 'content-encoding': 'gzip', 'accept-ranges': 'bytes' },
            })
        }

        const res = await call(viaProxy, { headers: { range: 'bytes=0-' } })
        expect(res.status).toBe(206)
        expect(upstreamRanges).toEqual(['full', 'bytes=0-'])
    })

    it('falls back to forwarding Range for objects above the cache limit', async () => {
        const upstream = 'https://github.com/cachetest/rangebig/releases/download/v1/big.bin'
        const viaProxy = 'https://example.com/https://github.com/cachetest/rangebig/releases/download/v1/big.bin'
        responder = (call) => {
            if (call.url.href !== upstream) {
                return null
            }
            if (call.headers?.get('range')) {
                return new Response('ab', {
                    status: 206,
                    headers: { 'content-length': '2', 'content-range': 'bytes 0-1/500000000', 'accept-ranges': 'bytes' },
                })
            }
            return new Response('x', {
                status: 200,
                headers: { 'content-length': String(500 * 1024 * 1024), 'accept-ranges': 'bytes' },
            })
        }

        const res = await call(viaProxy, { headers: { range: 'bytes=0-' } })
        expect(res.status).toBe(206)
        expect(res.headers.get('content-range')).toBe('bytes 0-1/500000000')
        expect(await res.text()).toBe('ab')
    })

    it('revalidates rolling assets with a short TTL', async () => {
        const dbUpstream = 'https://github.com/cachetest/geo/releases/download/v2/geoip.db'
        const dbViaProxy = 'https://example.com/https://github.com/cachetest/geo/releases/download/v2/geoip.db'
        responder = route('GET', dbUpstream, () =>
            new Response('db', { status: 200, headers: { 'content-length': '2', 'etag': '"db1"' } }))

        const first = await call(dbViaProxy)
        expect(first.headers.get('x-proxy-cache')).toBe('MISS')
        expect(first.headers.get('cache-control')).toBe('public, max-age=300')

        const conditional = await call(dbViaProxy, { headers: { 'if-none-match': '"db1"' } })
        expect(conditional.status).toBe(304)
        expect(conditional.headers.get('x-proxy-cache')).toBe('HIT')
    })

    it('does not cache error responses', async () => {
        const upstream404 = 'https://github.com/cachetest/missing/releases/download/v1/none.zip'
        const viaProxy404 = 'https://example.com/https://github.com/cachetest/missing/releases/download/v1/none.zip'
        let upstreamCalls = 0
        responder = route('GET', upstream404, () => {
            upstreamCalls++
            return text('missing', 404)
        })

        const first = await call(viaProxy404)
        expect(first.status).toBe(404)
        expect(first.headers.get('cache-control')).toBe('no-store')
        const second = await call(viaProxy404)
        expect(second.status).toBe(404)
        expect(upstreamCalls).toBe(2)
    })

    it('does not cache responses above the size limit', async () => {
        const bigUpstream = 'https://github.com/cachetest/big/releases/download/v1/big.bin'
        const bigViaProxy = 'https://example.com/https://github.com/cachetest/big/releases/download/v1/big.bin'
        let upstreamCalls = 0
        responder = route('GET', bigUpstream, () => {
            upstreamCalls++
            return new Response('x', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } })
        })

        expect((await call(bigViaProxy)).headers.get('x-proxy-cache')).toBe('MISS')
        expect((await call(bigViaProxy)).headers.get('x-proxy-cache')).toBe('MISS')
        expect(upstreamCalls).toBe(2)
    })

    it('caches chunked responses that have no content-length', async () => {
        const chunkedUpstream = 'https://github.com/cachetest/chunked/releases/download/v1/file.bin'
        const chunkedViaProxy = 'https://example.com/https://github.com/cachetest/chunked/releases/download/v1/file.bin'
        responder = route('GET', chunkedUpstream, () => new Response('chunked-body'))

        expect((await call(chunkedViaProxy)).headers.get('x-proxy-cache')).toBe('MISS')
        expect((await call(chunkedViaProxy)).headers.get('x-proxy-cache')).toBe('HIT')
    })

    it('bypasses the cache for authorized requests', async () => {
        const authUpstream = 'https://github.com/cachetest/private/releases/download/v1/secret.bin'
        const authViaProxy = 'https://example.com/https://github.com/cachetest/private/releases/download/v1/secret.bin'
        responder = route('GET', authUpstream, () => text('secret'))

        const authorized = await call(authViaProxy, { headers: { authorization: 'Bearer token' } })
        expect(authorized.headers.get('x-proxy-cache')).toBe('BYPASS')
        expect(authorized.headers.get('cache-control')).toBe('no-store')
        expect(await authorized.text()).toBe('secret')

        const anonymous = await call(authViaProxy)
        expect(anonymous.headers.get('x-proxy-cache')).toBe('MISS')
    })
})

describe('abuse protection', () => {
    it('returns 429 when the rate limiter rejects proxy requests', async () => {
        const res = await call('https://example.com/https://github.com/a/b/archive/x.zip', undefined, {
            RATE_LIMITER: { limit: async () => ({ success: false }) },
        })
        expect(res.status).toBe(429)
        expect(res.headers.get('retry-after')).toBe('60')
        expect(calls).toHaveLength(0)
    })

    it('does not rate limit the bundled homepage', async () => {
        const res = await call('https://example.com/', undefined, {
            RATE_LIMITER: { limit: async () => ({ success: false }) },
        })
        expect(res.status).toBe(200)
    })
})

describe('health', () => {
    it('answers /healthz without touching upstreams', async () => {
        const res = await call('https://example.com/healthz')
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(JSON.parse(await res.text()).status).toBe('ok')
        expect(calls).toHaveLength(0)
    })
})

describe('observability', () => {
    it('logs proxy requests but not static asset requests', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => { })
        try {
            await call('https://example.com/')
            responder = route('GET', 'https://github.com/logtest/repo/releases/download/v1/f.bin', () => text('x'))
            await call('https://example.com/https://github.com/logtest/repo/releases/download/v1/f.bin')

            expect(spy).toHaveBeenCalledTimes(1)
            const logged = JSON.parse(String(spy.mock.calls[0][0]))
            expect(logged.status).toBe(200)
            expect(logged.cache).toBe('MISS')
        } finally {
            spy.mockRestore()
        }
    })
})
