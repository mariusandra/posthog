/**
 * Cookie-jar handling for session sign-in.
 *
 * The desktop app can authenticate upstream the same way a browser does, by
 * replaying the session cookies obtained from a real PostHog login. That is the
 * only way to reach the whole product: bearer tokens (personal API keys and
 * OAuth access tokens) are denied on every viewset marked `scope_object =
 * "INTERNAL"` and on every custom DRF action whose name is not listed in the
 * viewset's scope action lists, regardless of how broad the token's scopes are.
 *
 * This module must stay free of Electron imports so it can be unit tested with
 * plain Node.
 */

/** Cookie name to value. Deliberately flat: we only ever talk to one host. */
export type CookieJar = Record<string, string>

/** Django's SESSION_COOKIE_NAME. Configurable server-side, but never changed on Cloud. */
const SESSION_COOKIE_NAME = 'sessionid'

/** PostHog sets CSRF_COOKIE_NAME; the Django default is the fallback for other instances. */
const CSRF_COOKIE_NAMES = ['posthog_csrftoken', 'csrftoken']

/**
 * Cookies kept across restarts. Everything else the server re-sends on the next
 * response, and some of it churns on every single one — the known-device cookie
 * is a fresh TimestampSigner signature each time — so persisting the whole jar
 * would rewrite settings.json once per proxied request.
 */
const PERSISTED_COOKIE_NAMES = [SESSION_COOKIE_NAME, ...CSRF_COOKIE_NAMES]

/** Methods Django exempts from CSRF verification. */
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

export function cookieHeader(jar: CookieJar): string {
    return Object.entries(jar)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')
}

export function csrfTokenFrom(jar: CookieJar): string | null {
    for (const name of CSRF_COOKIE_NAMES) {
        if (jar[name]) {
            return jar[name]
        }
    }
    return null
}

export function hasSessionCookie(jar: CookieJar): boolean {
    return Boolean(jar[SESSION_COOKIE_NAME])
}

export function needsCsrfToken(method: string): boolean {
    return !CSRF_SAFE_METHODS.has(method.toUpperCase())
}

export function persistableCookies(jar: CookieJar): CookieJar {
    const persisted: CookieJar = {}
    for (const name of PERSISTED_COOKIE_NAMES) {
        if (jar[name]) {
            persisted[name] = jar[name]
        }
    }
    return persisted
}

export function parseCookieJar(raw: string): CookieJar | null {
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null
        }
        const jar: CookieJar = {}
        for (const [name, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
                jar[name] = value
            }
        }
        return jar
    } catch {
        return null
    }
}

interface ParsedSetCookie {
    name: string
    value: string
    /** The server is clearing this cookie (empty value, Max-Age=0, or a past Expires) */
    expired: boolean
}

/**
 * Parses one Set-Cookie header. Only the name, the value and whether the cookie
 * is being cleared matter — the proxy talks to exactly one host over one
 * connection, so Domain/Path/SameSite have nothing to decide.
 */
export function parseSetCookie(header: string): ParsedSetCookie | null {
    const [pair, ...attributes] = header.split(';')
    const separator = pair.indexOf('=')
    if (separator <= 0) {
        return null
    }
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!name) {
        return null
    }
    let expired = value === '' || value === '""'
    for (const attribute of attributes) {
        const [rawKey, ...rest] = attribute.split('=')
        const key = rawKey.trim().toLowerCase()
        const attributeValue = rest.join('=').trim()
        if (key === 'max-age' && Number(attributeValue) <= 0) {
            expired = true
        }
        if (key === 'expires') {
            const expiresAt = Date.parse(attributeValue)
            if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
                expired = true
            }
        }
    }
    return { name, value, expired }
}

/** Returns a new jar with the upstream's Set-Cookie headers applied. */
export function applySetCookies(jar: CookieJar, headers: readonly string[]): CookieJar {
    const next = { ...jar }
    for (const header of headers) {
        const cookie = parseSetCookie(header)
        if (!cookie) {
            continue
        }
        if (cookie.expired) {
            delete next[cookie.name]
        } else {
            next[cookie.name] = cookie.value
        }
    }
    return next
}

/**
 * Whether an upstream response means the session is gone. Django does not 401
 * an expired session: SessionAgeMiddleware and SessionRiskMiddleware both
 * redirect to /login, which the SPA would otherwise render as an empty page.
 */
export function isSignedOutRedirect(status: number, location: string | null): boolean {
    if (status < 300 || status >= 400 || !location) {
        return false
    }
    try {
        // Exactly /login, never a prefix: the SSO entry points are /login/<backend>,
        // and redirecting into one of those means a sign-in is starting, not ending
        return new URL(location, 'http://placeholder.invalid').pathname.replace(/\/$/, '') === '/login'
    } catch {
        return false
    }
}

/**
 * Strips the Electron and app-name tokens out of a user agent, leaving a plain
 * Chrome one. Google (and some SAML providers) refuse to complete a sign-in in
 * anything that self-identifies as an embedded browser, so the login window has
 * to look like Chrome. The same value is then sent on proxied API requests, so
 * the session's user agent stays consistent with the one it was created under
 * and does not read as device drift to PostHog's session-risk scoring.
 */
export function chromeLikeUserAgent(userAgent: string): string {
    const prefix = /^Mozilla\/5\.0 .*?\(KHTML, like Gecko\)/.exec(userAgent)
    const chrome = /Chrome\/[\d.]+/.exec(userAgent)
    if (!prefix || !chrome) {
        return userAgent
    }
    const safari = /Safari\/[\d.]+/.exec(userAgent)
    return [prefix[0], chrome[0], safari ? safari[0] : 'Safari/537.36'].join(' ')
}
