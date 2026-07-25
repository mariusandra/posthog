import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { isProxyPath, type LocalBackend, rewriteBearerPath, startLocalBackend, type UpstreamAuth } from './backend.ts'

const COOKIE_AUTH = {
    mode: 'cookie',
    cookieHeader: 'sessionid=abc123; posthog_csrftoken=tok',
    csrfToken: 'tok',
    userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
} as const

interface UpstreamRequest {
    method: string
    url: string
    headers: http.IncomingHttpHeaders
    body: string
}

describe('local backend', () => {
    let tmpDir: string
    let distDir: string
    let cacheDir: string
    let upstream: http.Server
    let upstreamOrigin: string
    let upstreamRequests: UpstreamRequest[]
    let backend: LocalBackend
    let auth: UpstreamAuth | null
    let signOutRequests: number
    let authRejections: number
    let capturedCookies: string[][]

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-desktop-test-'))
        distDir = path.join(tmpDir, 'dist')
        cacheDir = path.join(tmpDir, 'cache')
        fs.mkdirSync(distDir, { recursive: true })
        fs.writeFileSync(
            path.join(distDir, 'preload-manifest.json'),
            JSON.stringify({
                css: 'static/index-AAAA1111.css',
                font: 'static/assets/Inter-BBBB2222.woff2',
                js: ['static/index-CCCC3333.js'],
                authenticatedJs: ['static/AuthenticatedShell-DDDD4444.js'],
            })
        )
        fs.writeFileSync(path.join(distDir, 'index-CCCC3333.js'), 'console.log("entry")')

        upstreamRequests = []
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
                upstreamRequests.push({
                    method: req.method || '',
                    url: req.url || '',
                    headers: req.headers,
                    body: Buffer.concat(chunks).toString(),
                })
                const status = Number(req.headers['x-test-response-status']) || 200
                const location = req.headers['x-test-location']
                res.writeHead(status, {
                    'content-type': 'application/json',
                    'set-cookie': 'session=abc',
                    ...(typeof location === 'string' ? { location } : {}),
                })
                res.end(JSON.stringify({ ok: status === 200, path: req.url }))
            })
        })
        upstreamOrigin = await new Promise<string>((resolve) => {
            upstream.listen(0, '127.0.0.1', () => {
                const address = upstream.address() as { port: number }
                resolve(`http://127.0.0.1:${address.port}`)
            })
        })

        auth = { apiHost: upstreamOrigin, mode: 'bearer', accessToken: 'phx_test_key' }
        signOutRequests = 0
        authRejections = 0
        capturedCookies = []
        backend = await startLocalBackend(
            {
                distDir,
                cacheDir,
                getAuth: () => auth,
                onOAuthCallback: async (query) => ({
                    ok: query.get('code') === 'good',
                    message: `handled:${query.get('state')}`,
                }),
                onSignOutRequested: () => {
                    signOutRequests += 1
                },
                onAuthRejected: () => {
                    authRejections += 1
                },
                onUpstreamCookies: (headers) => {
                    capturedCookies.push(headers)
                },
                upstreamHeaders: { 'user-agent': 'PostHog-Desktop/test' },
            },
            0
        )
    })

    after(async () => {
        await backend.close()
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    beforeEach(() => {
        auth = { apiHost: upstreamOrigin, mode: 'bearer', accessToken: 'phx_test_key' }
        upstreamRequests.length = 0
        capturedCookies.length = 0
    })

    test('serves the generated index.html for SPA routes', async () => {
        for (const route of ['/', '/insights', '/project/2/dashboard/1']) {
            const response = await fetch(backend.origin + route)
            assert.equal(response.status, 200)
            const body = await response.text()
            assert.match(body, /static\/index-CCCC3333\.js/)
            assert.doesNotMatch(body, /POSTHOG_APP_CONTEXT/)
        }
    })

    test('serves static assets with immutable caching for hashed files', async () => {
        const response = await fetch(`${backend.origin}/static/index-CCCC3333.js`)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('content-type'), 'application/javascript')
        assert.match(response.headers.get('cache-control') || '', /immutable/)
        assert.equal(await response.text(), 'console.log("entry")')
    })

    test('blocks path traversal out of the dist directory', async () => {
        const response = await fetch(`${backend.origin}/static/..%2f..%2fetc%2fpasswd`)
        assert.equal(response.status, 404)
    })

    test('proxies API requests upstream with a bearer token and without cookies', async () => {
        const response = await fetch(`${backend.origin}/api/users/@me/extra?q=1`, {
            headers: { cookie: 'local=1', 'x-custom': 'kept' },
        })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('set-cookie'), null)
        const seen = upstreamRequests[0]
        assert.equal(seen.url, '/api/users/@me/extra?q=1')
        assert.equal(seen.headers['authorization'], 'Bearer phx_test_key')
        assert.equal(seen.headers['cookie'], undefined)
        assert.equal(seen.headers['x-custom'], 'kept')
        assert.equal(seen.headers['user-agent'], 'PostHog-Desktop/test')
    })

    test('forwards request bodies for mutating methods', async () => {
        const response = await fetch(`${backend.origin}/api/projects/1/insights/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'test' }),
        })
        assert.equal(response.status, 200)
        assert.equal(upstreamRequests[0].method, 'POST')
        assert.equal(upstreamRequests[0].body, JSON.stringify({ name: 'test' }))
    })

    test('returns 401 for proxy paths when signed out', async () => {
        auth = null
        const response = await fetch(`${backend.origin}/api/users/@me/`)
        assert.equal(response.status, 401)
        const body = (await response.json()) as { code: string }
        assert.equal(body.code, 'desktop_not_signed_in')
        assert.equal(upstreamRequests.length, 0)
    })

    test('serves cached bootstrap responses when the upstream is unreachable', async () => {
        const warm = await fetch(`${backend.origin}/api/users/@me/`)
        assert.equal(warm.status, 200)

        auth = { apiHost: 'http://127.0.0.1:1', mode: 'bearer', accessToken: 'phx_test_key' }
        const offline = await fetch(`${backend.origin}/api/users/@me/`)
        assert.equal(offline.status, 200)
        assert.equal(offline.headers.get('x-posthog-desktop-cache'), 'stale')
        const body = (await offline.json()) as { ok: boolean }
        assert.equal(body.ok, true)

        const uncached = await fetch(`${backend.origin}/api/projects/1/`)
        assert.equal(uncached.status, 503)
    })

    test('reports rejected credentials only when the upstream 401s the identity check', async () => {
        const rejected = await fetch(`${backend.origin}/api/users/@me/`, {
            headers: { 'x-test-response-status': '401' },
        })
        assert.equal(rejected.status, 401)
        assert.equal(authRejections, 1)

        const otherPath = await fetch(`${backend.origin}/api/projects/1/`, {
            headers: { 'x-test-response-status': '401' },
        })
        assert.equal(otherPath.status, 401)
        assert.equal(authRejections, 1)
    })

    test('/logout notifies the host and never reaches the upstream', async () => {
        const response = await fetch(`${backend.origin}/logout`)
        assert.equal(response.status, 200)
        assert.equal(signOutRequests, 1)
        assert.equal(upstreamRequests.length, 0)
    })

    test('/callback is routed to the OAuth handler instead of the SPA', async () => {
        const response = await fetch(`${backend.origin}/callback?code=good&state=xyz`)
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.match(body, /handled:xyz/)
        assert.equal(upstreamRequests.length, 0)
    })

    test('authenticates with session cookies instead of a bearer token', async () => {
        auth = { apiHost: upstreamOrigin, ...COOKIE_AUTH }
        const response = await fetch(`${backend.origin}/api/environments/2/insights/`, {
            method: 'POST',
            headers: { cookie: 'local=1', 'content-type': 'application/json' },
            body: '{}',
        })
        assert.equal(response.status, 200)
        const seen = upstreamRequests[0]
        // The renderer's own loopback cookie must never reach the upstream
        assert.equal(seen.headers['cookie'], 'sessionid=abc123; posthog_csrftoken=tok')
        assert.equal(seen.headers['authorization'], undefined)
        // Django rejects an unsafe request whose Origin does not match the host, and
        // the renderer's real origin is the loopback server
        assert.equal(seen.headers['origin'], upstreamOrigin)
        assert.equal(seen.headers['x-csrftoken'], 'tok')
        // The session's own user agent wins over the desktop one, so the request does
        // not read as a different device than the one that signed in
        assert.equal(seen.headers['user-agent'], COOKIE_AUTH.userAgent)
    })

    test('omits the CSRF header on safe methods', async () => {
        auth = { apiHost: upstreamOrigin, ...COOKIE_AUTH }
        await fetch(`${backend.origin}/api/environments/2/insights/`)
        assert.equal(upstreamRequests[0].headers['x-csrftoken'], undefined)
    })

    test('captures rotated session cookies without forwarding them to the renderer', async () => {
        auth = { apiHost: upstreamOrigin, ...COOKIE_AUTH }
        const response = await fetch(`${backend.origin}/api/environments/2/insights/`)
        // Losing these would sign the app out the first time Django rotates the session key
        assert.deepEqual(capturedCookies, [['session=abc']])
        assert.equal(response.headers.get('set-cookie'), null)
    })

    test('reports a redirect to the login page as rejected credentials', async () => {
        auth = { apiHost: upstreamOrigin, ...COOKIE_AUTH }
        const before = authRejections
        await fetch(`${backend.origin}/api/environments/2/insights/`, {
            headers: { 'x-test-response-status': '302', 'x-test-location': '/login?message=expired' },
        })
        // An expired or risk-flushed session redirects rather than 401ing, so without
        // this the app would sit on a blank scene instead of asking for a sign-in
        assert.equal(authRejections, before + 1)

        await fetch(`${backend.origin}/api/environments/2/insights/`, {
            headers: { 'x-test-response-status': '302', 'x-test-location': '/project/2/dashboard' },
        })
        assert.equal(authRejections, before + 1)
    })

    test('strips the query kind segment for bearer auth but not for session auth', async () => {
        // The kind segment routes to an action no token can be granted a scope for,
        // so a bearer-authenticated app gets 403 on every insight, replay and query
        await fetch(`${backend.origin}/api/environments/2/query/HogQLQuery/?refresh=1`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"query":{"kind":"HogQLQuery"}}',
        })
        assert.equal(upstreamRequests[0].url, '/api/environments/2/query/?refresh=1')

        auth = { apiHost: upstreamOrigin, ...COOKIE_AUTH }
        await fetch(`${backend.origin}/api/environments/2/query/HogQLQuery/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"query":{"kind":"HogQLQuery"}}',
        })
        assert.equal(upstreamRequests[1].url, '/api/environments/2/query/HogQLQuery/')
    })

    for (const [method, input, expected] of [
        ['POST', '/api/environments/2/query/HogQLQuery/', '/api/environments/2/query/'],
        ['POST', '/api/environments/2/query/ActorsQuery', '/api/environments/2/query/'],
        ['POST', '/api/projects/@current/query/EventsQuery/?x=1', '/api/projects/@current/query/?x=1'],
        // Not a kind segment: leave the path alone
        ['POST', '/api/environments/2/query/', '/api/environments/2/query/'],
        ['POST', '/api/environments/2/query/abc123/', '/api/environments/2/query/abc123/'],
        ['POST', '/api/environments/2/query/abc123/log', '/api/environments/2/query/abc123/log'],
        ['POST', '/api/environments/2/insights/', '/api/environments/2/insights/'],
        // create_with_kind is POST-only, so a client_query_id that happens to look like
        // a kind must not turn a cancel into a call on the collection
        ['DELETE', '/api/environments/2/query/AbcQuery/', '/api/environments/2/query/AbcQuery/'],
        ['GET', '/api/environments/2/query/AbcQuery/', '/api/environments/2/query/AbcQuery/'],
    ] as const) {
        test(`rewriteBearerPath leaves ${method} ${input} as ${expected}`, () => {
            assert.equal(rewriteBearerPath(method, input), expected)
        })
    }

    test('rejects cross-origin requests to the proxy', async () => {
        // The proxy manufactures a first-party request upstream (Origin plus a valid
        // CSRF token), so without this any page in the user's browser could POST
        // form-encoded data here and have the write run as the signed-in user
        const foreign = await fetch(`${backend.origin}/api/environments/2/insights/`, {
            method: 'POST',
            headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
            body: 'name=x',
        })
        assert.equal(foreign.status, 403)
        assert.equal(upstreamRequests.length, 0)

        const simple = await fetch(`${backend.origin}/api/environments/2/insights/`, {
            method: 'POST',
            headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
            body: 'name=x',
        })
        assert.equal(simple.status, 403)
        assert.equal(upstreamRequests.length, 0)

        // The app's own requests still go through
        const own = await fetch(`${backend.origin}/api/environments/2/insights/`, {
            headers: { origin: backend.origin, 'sec-fetch-site': 'same-origin' },
        })
        assert.equal(own.status, 200)
    })

    test('keeps credentials off the capture and static paths', async () => {
        auth = { apiHost: upstreamOrigin, ...COOKIE_AUTH }
        await fetch(`${backend.origin}/decide?v=2`, { method: 'POST', body: '{}' })
        // /decide, /e/, /i/ and the rest authenticate with the project token in the
        // payload; sending the session cookie there would spread it far wider than needed
        assert.equal(upstreamRequests[0].headers['cookie'], undefined)
        assert.equal(upstreamRequests[0].headers['authorization'], undefined)

        await fetch(`${backend.origin}/api/environments/2/insights/`)
        assert.equal(upstreamRequests[1].headers['cookie'], 'sessionid=abc123; posthog_csrftoken=tok')
    })

    test('isProxyPath separates backend paths from SPA routes', () => {
        for (const proxied of ['/api/users/@me/', '/_preflight/', '/uploaded_media/x.png', '/decide', '/flags?v=2']) {
            assert.equal(isProxyPath(proxied), true, proxied)
        }
        for (const spa of ['/', '/insights', '/settings/user-api-keys', '/apiary', '/events']) {
            assert.equal(isProxyPath(spa), false, spa)
        }
    })
})
