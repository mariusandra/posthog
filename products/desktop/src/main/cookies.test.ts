import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
    applySetCookies,
    chromeLikeUserAgent,
    cookieHeader,
    csrfTokenFrom,
    hasSessionCookie,
    isSignedOutRedirect,
    needsCsrfToken,
    parseCookieJar,
    persistableCookies,
} from './cookies.ts'

describe('session cookies', () => {
    test('builds a cookie header and reads the session and CSRF values back', () => {
        const jar = { sessionid: 'abc123', posthog_csrftoken: 'tok', ph_device_1: 'signed' }
        assert.equal(cookieHeader(jar), 'sessionid=abc123; posthog_csrftoken=tok; ph_device_1=signed')
        assert.equal(csrfTokenFrom(jar), 'tok')
        assert.equal(hasSessionCookie(jar), true)
        assert.equal(hasSessionCookie({ posthog_csrftoken: 'tok' }), false)
    })

    test('falls back to the Django default CSRF cookie name', () => {
        assert.equal(csrfTokenFrom({ csrftoken: 'django' }), 'django')
        assert.equal(csrfTokenFrom({ sessionid: 'abc' }), null)
    })

    test('keeps values containing = intact', () => {
        // Django session values are base64 and routinely end in padding
        const jar = applySetCookies({}, ['sessionid=YWJjZA==; Path=/; HttpOnly; SameSite=Lax'])
        assert.equal(jar['sessionid'], 'YWJjZA==')
    })

    test('does not mistake an Expires date for the cookie value', () => {
        const jar = applySetCookies({}, ['sessionid=live; Expires=Wed, 09 Jun 2099 10:18:14 GMT; Path=/'])
        assert.deepEqual(jar, { sessionid: 'live' })
    })

    for (const [label, header] of [
        ['an empty value', 'sessionid=; Path=/'],
        ['Max-Age=0', 'sessionid=abc; Max-Age=0; Path=/'],
        ['a past Expires', 'sessionid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'],
    ] as const) {
        test(`drops a cookie the server clears with ${label}`, () => {
            // A cleared session that stayed in the jar would be replayed forever, leaving
            // the app looking signed in while every request fails
            assert.deepEqual(applySetCookies({ sessionid: 'abc', other: 'keep' }, [header]), { other: 'keep' })
        })
    }

    test('applies updates without mutating the original jar', () => {
        const original = { sessionid: 'old' }
        const next = applySetCookies(original, ['sessionid=new; Path=/'])
        assert.equal(original['sessionid'], 'old')
        assert.equal(next['sessionid'], 'new')
    })

    test('ignores malformed Set-Cookie headers', () => {
        assert.deepEqual(applySetCookies({ sessionid: 'abc' }, ['', 'nonsense', '=novalue']), { sessionid: 'abc' })
    })

    test('persists only the session and CSRF cookies', () => {
        // ph_device_* is a fresh TimestampSigner signature on every response, so
        // persisting it would rewrite the settings file once per proxied request
        assert.deepEqual(
            persistableCookies({ sessionid: 'abc', posthog_csrftoken: 'tok', ph_device_1: 'churns', other: 'x' }),
            { sessionid: 'abc', posthog_csrftoken: 'tok' }
        )
    })

    test('rejects stored cookie data that is not a string map', () => {
        assert.deepEqual(parseCookieJar('{"sessionid":"abc","n":1}'), { sessionid: 'abc' })
        assert.equal(parseCookieJar('not json'), null)
        assert.equal(parseCookieJar('["sessionid"]'), null)
    })

    test('requires a CSRF token only for unsafe methods', () => {
        for (const method of ['GET', 'head', 'OPTIONS']) {
            assert.equal(needsCsrfToken(method), false, method)
        }
        for (const method of ['POST', 'patch', 'DELETE', 'PUT']) {
            assert.equal(needsCsrfToken(method), true, method)
        }
    })

    for (const [label, status, location, expected] of [
        ['a relative login redirect', 302, '/login?message=expired', true],
        ['an absolute login redirect', 302, 'https://eu.posthog.com/login?reason=session_risk', true],
        ['a redirect elsewhere', 302, '/project/2/dashboard', false],
        // The SSO entry points live under /login/, so a prefix match would read the
        // start of a sign-in as the end of one
        ['a redirect into SSO', 302, '/login/google-oauth2', false],
        ['a redirect to SAML login', 302, 'https://eu.posthog.com/login/saml/?idp=x', false],
        ['a redirect with no location', 302, null, false],
        ['a successful response', 200, '/login', false],
    ] as const) {
        test(`treats ${label} as signed out: ${expected}`, () => {
            assert.equal(isSignedOutRedirect(status, location), expected)
        })
    }

    test('rewrites the user agent to look like plain Chrome', () => {
        // Google and some SAML providers refuse to complete a sign-in in anything
        // that identifies itself as an embedded browser
        const electron =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PostHog Dev/0.2.5 Chrome/130.0.6723.59 Electron/33.0.2 Safari/537.36'
        assert.equal(
            chromeLikeUserAgent(electron),
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.59 Safari/537.36'
        )
    })

    test('leaves an unrecognized user agent alone', () => {
        assert.equal(chromeLikeUserAgent('SomeOtherAgent/1.0'), 'SomeOtherAgent/1.0')
    })
})
