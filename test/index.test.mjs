import worker from '../index.js'

const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('ok -', msg) }

let calls = []
const mockFetch = (handler) => {
    calls = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body, signal: init?.signal })
        return handler(String(url), init, calls.length)
    }
}
const plain = (body = 'upstream', status = 200, headers = {}) =>
    new Response(body, { status, headers })

const env = {}

// 1. ?q= redirect
{
    mockFetch(() => plain())
    const res = await worker.fetch(new Request('https://example.com/?q=github.com/a/b/archive/master.zip'), env)
    assert(res.status === 301, 'q= redirect 301')
    assert(res.headers.get('location') === 'https://example.com/github.com/a/b/archive/master.zip', 'q= location')
}

// 2. preflight
{
    mockFetch(() => plain())
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/archive/x.zip', { method: 'OPTIONS', headers: { 'access-control-request-headers': 'x' } }), env)
    assert(res.status === 204, 'preflight 204')
}

// 3. archive proxied + CORS
{
    mockFetch((url) => plain('upstream:' + url))
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/archive/master.zip'), env)
    const body = await res.text()
    assert(res.status === 200 && body === 'upstream:https://github.com/a/b/archive/master.zip', 'archive proxied')
    assert(res.headers.get('access-control-allow-origin') === '*', 'CORS header set')
}

// 4. white list block / pass
{
    mockFetch(() => plain())
    const blocked = await worker.fetch(new Request('https://example.com/github.com/a/b/archive/x.zip'), { WHITE_LIST: '/foo/,/bar/' })
    assert(blocked.status === 403, 'white list blocks 403')
    const passed = await worker.fetch(new Request('https://example.com/github.com/foo/b/archive/x.zip'), { WHITE_LIST: '/foo/,/bar/' })
    assert(passed.status === 200, 'white list pass 200')
}

// 5. jsdelivr blob redirect + blob -> raw
{
    mockFetch(() => plain())
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/blob/master/f.js'), { JSDELIVR: '1' })
    assert(res.status === 302 && res.headers.get('location') === 'https://cdn.jsdelivr.net/gh/a/b@master/f.js', 'jsdelivr blob redirect')

    mockFetch(() => plain())
    await worker.fetch(new Request('https://example.com/github.com/a/b/blob/master/f.js'), env)
    assert(calls[0].url === 'https://github.com/a/b/raw/master/f.js', 'blob -> raw')
}

// 6. custom prefix + homepage fallthrough (no assets, no ASSET_URL)
{
    mockFetch(() => plain())
    await worker.fetch(new Request('https://example.com/gh/https://github.com/a/b/archive/master.zip'), { PREFIX: '/gh/' })
    assert(calls[0].url === 'https://github.com/a/b/archive/master.zip', 'custom prefix proxies')

    mockFetch(() => plain())
    await worker.fetch(new Request('https://example.com/gh/whatever'), { PREFIX: '/gh/' })
    assert(calls[0].url === 'https://hunshcn.github.io/gh-proxy/whatever', 'default homepage fallthrough: ' + calls[0].url)
}

// 7. location rewrite for proxy-aware redirects
{
    mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://github.com/a/b/releases/download/v1/x.zip' } }))
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/archive/master.zip'), env)
    assert(res.status === 302 && res.headers.get('location') === '/https://github.com/a/b/releases/download/v1/x.zip', 'location rewritten with PREFIX')
}

// 8. relative location resolved against current URL and followed
{
    mockFetch((url, init, n) => n === 1
        ? new Response(null, { status: 302, headers: { location: '/redirected' } })
        : plain('final'))
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/archive/master.zip'), env)
    assert(calls[1].url === 'https://github.com/redirected', 'relative location resolved: ' + calls[1].url)
    assert(res.status === 200 && await res.text() === 'final', 'relative redirect followed to 200')
}

// 9. redirect chain capped
{
    mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/x' } }))
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/archive/master.zip'), env)
    assert(calls.length === 6, 'redirect loop capped at MAX_REDIRECTS + 1 fetches, got ' + calls.length)
    assert(res.status === 302 && res.headers.get('location') === 'https://codeload.github.com/x', 'unfollowed redirect handed back')
}

// 10. POST + 302 -> followed as GET without body
{
    mockFetch((url, init, n) => n === 1
        ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/x' } })
        : plain('posted-as-get'))
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/git-upload-pack', { method: 'POST', body: 'payload' }), env)
    assert(calls[1].method === 'GET' && calls[1].body === undefined, '302 after POST re-issued as GET without body')
    assert(res.status === 200, 'POST redirect followed')
}

// 11. POST + 307 -> not replayed, handed back
{
    mockFetch(() => new Response(null, { status: 307, headers: { location: 'https://codeload.github.com/x' } }))
    const res = await worker.fetch(new Request('https://example.com/github.com/a/b/git-upload-pack', { method: 'POST', body: 'payload' }), env)
    assert(calls.length === 1 && res.status === 307, '307 with body not replayed')
    assert(res.headers.get('location') === 'https://codeload.github.com/x' && res.headers.get('access-control-allow-origin') === '*', '307 handed back with CORS')
}

// 12. assets binding fallback
{
    mockFetch(() => plain())
    const fakeAssets = { fetch: () => new Response('asset') }
    const res = await worker.fetch(new Request('https://example.com/'), { ASSETS: fakeAssets })
    assert(await res.text() === 'asset' && calls.length === 0, 'assets binding serves unknown paths')
}

// 13. explicit ASSET_URL overrides assets binding
{
    mockFetch((url) => plain('ext:' + url))
    const fakeAssets = { fetch: () => new Response('asset') }
    const res = await worker.fetch(new Request('https://example.com/x'), { ASSETS: fakeAssets, ASSET_URL: 'https://page.example/' })
    assert(await res.text() === 'ext:https://page.example/x', 'ASSET_URL overrides assets binding')
}

// 14. path outside PREFIX -> 404
{
    mockFetch(() => plain())
    const res = await worker.fetch(new Request('https://example.com/whatever'), { PREFIX: '/gh/' })
    assert(res.status === 404 && calls.length === 0, 'path outside prefix returns 404')
}

// 15. client signal forwarded to upstream fetch
{
    mockFetch(() => plain())
    const req = new Request('https://example.com/github.com/a/b/archive/master.zip')
    await worker.fetch(req, env)
    assert(calls[0].signal instanceof AbortSignal, 'client signal forwarded')
}

// 16. ASSET_URL without trailing slash gets normalized
{
    mockFetch((url) => plain('ext:' + url))
    const res = await worker.fetch(new Request('https://example.com/x'), { ASSET_URL: 'https://page.example' })
    assert(await res.text() === 'ext:https://page.example/x', 'asset url trailing slash normalized')
}

// 17. leading slashes in the asset path do not double up
{
    mockFetch((url) => plain('ext:' + url))
    const res = await worker.fetch(new Request('https://example.com//foo'), { PREFIX: '/', ASSET_URL: 'https://page.example/' })
    assert(await res.text() === 'ext:https://page.example/foo', 'asset path joined without double slash')
}

// 18. assets lookup strips PREFIX, forwards conditional headers, keeps method
{
    const looked = []
    const fakeAssets = { fetch: (req) => { looked.push(req); return new Response('asset') } }
    await worker.fetch(new Request('https://example.com/gh/'), { PREFIX: '/gh/', ASSETS: fakeAssets })
    await worker.fetch(new Request('https://example.com/gh/favicon.ico?v=1', { headers: { 'if-none-match': 'W/"abc"' } }), { PREFIX: '/gh/', ASSETS: fakeAssets })
    await worker.fetch(new Request('https://example.com/gh/index.html', { method: 'POST' }), { PREFIX: '/gh/', ASSETS: fakeAssets })
    await worker.fetch(new Request('https://example.com/gh/index.html', { method: 'HEAD' }), { PREFIX: '/gh/', ASSETS: fakeAssets })
    const [root, favicon, post, head] = looked.map((req) => new URL(req.url))
    assert(root.pathname === '/' && root.search === '', 'prefix stripped for asset root: ' + root.pathname)
    assert(favicon.pathname === '/favicon.ico' && favicon.search === '?v=1', 'prefix stripped, query kept: ' + favicon.pathname + favicon.search)
    assert(looked[1].headers.get('if-none-match') === 'W/"abc"', 'conditional header forwarded')
    assert(looked[2].method === 'GET', 'POST downgraded to GET for assets')
    assert(looked[3].method === 'HEAD' && head.pathname === '/index.html', 'HEAD preserved for assets: ' + head.pathname)
}

console.log('\nall tests passed')
