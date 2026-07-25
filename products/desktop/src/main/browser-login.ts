/**
 * Session sign-in: a real PostHog login inside an app window.
 *
 * The window loads {host}/login in its own persisted partition and behaves like
 * an ordinary browser, so password, Google, SAML and 2FA all work unchanged. Once
 * the login produces a session cookie that /api/users/@me/ accepts, the cookies
 * are handed to the caller and the proxy replays them upstream from then on.
 *
 * PostHog's login is a single-page flow — signing in does not navigate — so the
 * cookie jar is polled rather than watched for navigation events.
 */

import { BrowserWindow, session, type Session, type WebContents } from 'electron'

import { chromeLikeUserAgent, cookieHeader, type CookieJar, csrfTokenFrom, hasSessionCookie } from './cookies.ts'
import { identityFromMe, type SignedInIdentity } from './identity.ts'

/** Persisted so an SSO provider's "remember me" survives a restart. Cleared on sign-out. */
const LOGIN_PARTITION = 'persist:posthog-login'

const POLL_INTERVAL_MS = 1000
const FLOW_TIMEOUT_MS = 10 * 60 * 1000

export type SessionLoginResult =
    | { ok: true; cookies: CookieJar; userAgent: string; identity: SignedInIdentity }
    | { ok: false; error: string }

function loginSession(): Session {
    return session.fromPartition(LOGIN_PARTITION)
}

/** True only while a login window is open, so the exemption below cannot outlive the flow. */
let loginFlowActive = false

/**
 * Whether these web contents belong to an in-progress login (or a popup it opened —
 * popups inherit the opener's session). The app-wide navigation handlers must skip
 * them: they confine navigation to the local origin, which would break every
 * external identity provider. Gated on the flow being live rather than on the
 * partition alone, so the confinement is only lifted for as long as it has to be.
 */
export function isLoginWebContents(contents: WebContents): boolean {
    return loginFlowActive && contents.session === loginSession()
}

/** Drops the stored login cookies so the next sign-in asks for credentials again. */
export async function clearLoginSession(): Promise<void> {
    try {
        await loginSession().clearStorageData({ storages: ['cookies'] })
    } catch (error) {
        console.warn('Could not clear the stored login session', error)
    }
}

async function readCookies(apiHost: string): Promise<CookieJar> {
    const jar: CookieJar = {}
    for (const cookie of await loginSession().cookies.get({ url: apiHost })) {
        jar[cookie.name] = cookie.value
    }
    return jar
}

/**
 * Confirms the cookies authenticate a real user, and returns whose.
 *
 * `unreachable` is kept distinct from `rejected` so the caller can remember that
 * it already judged a given cookie without also remembering a verdict it never
 * actually got: a network blip must not permanently skip a valid session.
 */
type Identification =
    | { status: 'signed-in'; identity: SignedInIdentity }
    | { status: 'rejected' }
    | { status: 'unreachable' }

async function identify(apiHost: string, jar: CookieJar, userAgent: string): Promise<Identification> {
    let response: Response
    try {
        response = await fetch(`${apiHost}/api/users/@me/`, {
            headers: { cookie: cookieHeader(jar), 'user-agent': userAgent },
            // A session that is not signed in redirects to /login; following that would
            // land on HTML that only fails to parse by luck
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        })
    } catch {
        return { status: 'unreachable' }
    }
    if (!response.ok) {
        // Signed out, or signed in but not past 2FA yet
        return { status: 'rejected' }
    }
    try {
        return { status: 'signed-in', identity: identityFromMe(await response.json()) }
    } catch {
        return { status: 'unreachable' }
    }
}

/**
 * Opens the login window and resolves once the user is signed in, closes the
 * window, or the flow times out. Only one window is opened per call; the caller
 * is responsible for not running two at once.
 */
export async function runSessionLogin(apiHost: string): Promise<SessionLoginResult> {
    const ses = loginSession()
    const userAgent = chromeLikeUserAgent(ses.getUserAgent())
    // Applied to the session, not just the window, so popups (Google's SSO flow
    // opens one) inherit it
    ses.setUserAgent(userAgent)

    // Set before the window exists, not after: `web-contents-created` fires from
    // inside the BrowserWindow constructor, and the app-wide navigation confinement
    // installed there attaches a `will-navigate` listener that cannot be removed
    // afterwards. With the flag still false, that listener captured this window and
    // pushed every SSO redirect out to the system browser, where the session it
    // produces is somewhere the app can never read.
    loginFlowActive = true
    let win: BrowserWindow
    try {
        win = new BrowserWindow({
            width: 1040,
            height: 800,
            title: 'Sign in to PostHog',
            autoHideMenuBar: true,
            webPreferences: {
                partition: LOGIN_PARTITION,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        })
    } catch (error) {
        loginFlowActive = false
        throw error
    }
    // SSO providers open a popup, so these have to be allowed, but only for real web
    // pages: a file: or custom-scheme popup in an app-chrome window has no business here
    win.webContents.setWindowOpenHandler(({ url }) =>
        url.startsWith('https://') ? { action: 'allow' } : { action: 'deny' }
    )

    return await new Promise<SessionLoginResult>((resolve) => {
        let settled = false
        let checking = false
        let lastRejectedSession: string | null = null
        // Destroying the opener does not close what it opened, and a surviving popup
        // would be an unconfined window with no flow left to justify it
        const popups = new Set<BrowserWindow>()

        const finish = (result: SessionLoginResult): void => {
            if (settled) {
                return
            }
            settled = true
            loginFlowActive = false
            clearInterval(poll)
            clearTimeout(timer)
            for (const popup of popups) {
                if (!popup.isDestroyed()) {
                    popup.destroy()
                }
            }
            if (!win.isDestroyed()) {
                win.destroy()
            }
            resolve(result)
        }

        const check = async (): Promise<void> => {
            if (settled || checking) {
                return
            }
            checking = true
            try {
                const jar = await readCookies(apiHost)
                // Django hands out a session cookie before the login too, so without
                // this the check would hit /@me every second while the user types
                if (!hasSessionCookie(jar) || jar['sessionid'] === lastRejectedSession) {
                    return
                }
                const result = await identify(apiHost, jar, userAgent)
                if (result.status === 'signed-in') {
                    finish({ ok: true, cookies: jar, userAgent, identity: result.identity })
                } else if (result.status === 'rejected') {
                    lastRejectedSession = jar['sessionid']
                }
            } catch (error) {
                console.warn('Could not read the login session cookies', error)
            } finally {
                checking = false
            }
        }

        const poll = setInterval(() => void check(), POLL_INTERVAL_MS)
        const timer = setTimeout(
            () => finish({ ok: false, error: 'The sign-in timed out. Try again.' }),
            FLOW_TIMEOUT_MS
        )
        timer.unref?.()

        win.webContents.on('did-create-window', (child) => popups.add(child))
        win.on('closed', () => finish({ ok: false, error: 'The sign-in window was closed.' }))
        // A session cookie can already exist from a previous sign-in, so check
        // as soon as the first page lands rather than waiting a full interval
        win.webContents.on('did-finish-load', () => void check())

        win.loadURL(`${apiHost}/login`).catch(() =>
            finish({ ok: false, error: `Could not reach ${apiHost}. Check your internet connection.` })
        )
    })
}

/**
 * Best-effort server-side session revocation, so signing out is not local-only.
 * The view is POST-only and CSRF-protected, hence the token and the Origin header.
 */
export async function revokeSession(apiHost: string, jar: CookieJar, userAgent: string | null): Promise<void> {
    const csrfToken = csrfTokenFrom(jar)
    try {
        await fetch(`${apiHost}/logout`, {
            method: 'POST',
            headers: {
                cookie: cookieHeader(jar),
                origin: apiHost,
                ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
                ...(userAgent ? { 'user-agent': userAgent } : {}),
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
        })
    } catch {
        // The local credentials are dropped either way
    }
}
