import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

interface MockCall {
    url: URL
    method: string
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
        const call: MockCall = { url: new URL(url), method, body: init?.body, signal: init?.signal }
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
    ...overrides,
} as Env)

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
    })

    it('redirects blob and raw requests to jsDelivr when enabled', async () => {
        const blob = await call('https://example.com/github.com/a/b/blob/master/f.js', undefined, { JSDELIVR: '1' })
        expect(blob.status).toBe(302)
        expect(blob.headers.get('location')).toBe('https://cdn.jsdelivr.net/gh/a/b@master/f.js')

        const raw = await call('https://example.com/raw.githubusercontent.com/a/b/master/f.js', undefined, { JSDELIVR: 'true' })
        expect(raw.status).toBe(302)
        expect(raw.headers.get('location')).toBe('https://cdn.jsdelivr.net/gh/a/b@master/f.js')
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

        const res = await call('https://example.com/github.com/a/b/archive/master.zip', undefined, { PREFIX: '/gh/' })
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

afterEach(() => {
    responder = () => null
})
