/**
 * IPC surface for the shell UI. Sign-in happens in the main process either by
 * verifying a pasted personal API key or by running the OAuth browser flow;
 * credentials never round-trip through the renderer once stored.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { type BrowserSignInPayload, IPC_CHANNELS, type SignInPayload, type SignInResult } from '../shared/ipc.ts'
import { clearLoginSession, revokeSession, runSessionLogin } from './browser-login.ts'
import { identityFromMe, type SignedInIdentity } from './identity.ts'
import { type OAuthBrowserFlow, oauthClientIdOverride, registerOAuthClient } from './oauth.ts'
import { resolveApiHost } from './regions.ts'
import type { AppState } from './state.ts'
import { isAllowedExternalUrl } from './window.ts'

export interface IpcActions {
    showShell: () => void
    showApp: () => void
    /** Drops the credentials, returns to the shell, and revokes a browser session upstream */
    signOutCompletely: () => Promise<void>
}

type VerifyResult = { ok: true; identity: SignedInIdentity } | { ok: false; error: string }

async function verifyBearerToken(apiHost: string, token: string, rejectedError: string): Promise<VerifyResult> {
    let response: Response
    try {
        response = await fetch(`${apiHost}/api/users/@me/`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
        })
    } catch {
        return { ok: false, error: `Could not reach ${apiHost}. Check your internet connection.` }
    }
    if (response.status === 401 || response.status === 403) {
        return { ok: false, error: rejectedError }
    }
    if (!response.ok) {
        return { ok: false, error: `Unexpected response from ${apiHost} (HTTP ${response.status}).` }
    }
    try {
        return { ok: true, identity: identityFromMe(await response.json()) }
    } catch {
        return { ok: false, error: `Unexpected response from ${apiHost}. Is this a PostHog instance?` }
    }
}

function resolveRegion(payload: { region?: unknown; customHost?: unknown }): {
    region: 'us' | 'eu' | 'custom'
    customHost: string
    apiHost: string | null
} {
    const region = payload.region === 'eu' || payload.region === 'custom' ? payload.region : 'us'
    const customHost = typeof payload.customHost === 'string' ? payload.customHost.trim() : ''
    return { region, customHost, apiHost: resolveApiHost(region, customHost) }
}

function focusMainWindow(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
        if (win.isMinimized()) {
            win.restore()
        }
        win.show()
    }
    app.focus({ steal: true })
}

/**
 * The OAuth client to run the consent flow as: an explicit override, the one this
 * install already registered with this host, or a fresh self-registration.
 */
async function resolveOAuthClientId(state: AppState, apiHost: string): Promise<string> {
    const override = oauthClientIdOverride()
    if (override) {
        return override
    }
    const existing = state.registeredClientId(apiHost)
    if (existing) {
        return existing
    }
    const clientId = await registerOAuthClient(apiHost)
    state.rememberRegisteredClientId(apiHost, clientId)
    return clientId
}

/** One login window at a time: a second would race the first over the same cookie jar. */
let sessionLoginInFlight = false

/**
 * Tears down a browser session everywhere it exists: upstream, in settings.json, and
 * in the Electron partition the login window persists it to. Clearing only the stored
 * copy would leave a live Django session (up to SESSION_COOKIE_AGE) plus cookies on
 * disk that silently sign the next person in without a credential prompt.
 *
 * Call before replacing the credentials, since the cookies are unreadable afterwards.
 */
export async function discardSession(state: AppState): Promise<void> {
    const credentials = state.cookieCredentials()
    const apiHost = state.apiHost()
    if (credentials && apiHost) {
        await revokeSession(apiHost, credentials.jar, credentials.userAgent)
    }
    await clearLoginSession()
}

export function registerIpcHandlers(state: AppState, oauthFlow: OAuthBrowserFlow, actions: IpcActions): void {
    ipcMain.handle(IPC_CHANNELS.getState, () => state.snapshot())

    ipcMain.handle(IPC_CHANNELS.signIn, async (_event, payload: SignInPayload): Promise<SignInResult> => {
        if (!payload || typeof payload.apiKey !== 'string' || !payload.apiKey.trim()) {
            return { ok: false, error: 'Enter a personal API key.' }
        }
        const { region, customHost, apiHost } = resolveRegion(payload)
        if (!apiHost) {
            return { ok: false, error: 'Enter a valid host URL, like https://posthog.example.com.' }
        }
        const result = await verifyBearerToken(
            apiHost,
            payload.apiKey.trim(),
            'That API key was rejected. Check the key and its scopes, then try again.'
        )
        if (!result.ok) {
            return result
        }
        await discardSession(state)
        state.signIn(region, customHost, payload.apiKey.trim(), result.identity)
        return { ok: true, email: result.identity.email }
    })

    ipcMain.handle(
        IPC_CHANNELS.signInWithBrowser,
        async (_event, payload: BrowserSignInPayload): Promise<SignInResult> => {
            const { region, customHost, apiHost } = resolveRegion(payload ?? {})
            if (!apiHost) {
                return { ok: false, error: 'Enter a valid host URL, like https://posthog.example.com.' }
            }
            let clientId: string
            try {
                clientId = await resolveOAuthClientId(state, apiHost)
            } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : 'Could not register the app.' }
            }
            const appOrigin = state.snapshot().appOrigin
            if (!appOrigin) {
                return { ok: false, error: 'The local server is not running yet. Try again in a moment.' }
            }
            // `localhost` (not 127.0.0.1) and path `/callback` so the port-stripped
            // URI matches the registered http://localhost/callback under RFC 8252
            // port flexibility
            const redirectUri = `http://localhost:${new URL(appOrigin).port}/callback`
            const { url, completion } = oauthFlow.begin({ apiHost, clientId, redirectUri })
            void shell.openExternal(url)
            const result = await completion
            if (!result.ok) {
                return result
            }
            const verified = await verifyBearerToken(
                apiHost,
                result.tokens.accessToken,
                'PostHog rejected the new session. Try signing in again.'
            )
            if (!verified.ok) {
                return verified
            }
            await discardSession(state)
            state.signInOAuth(region, customHost, result.tokens, clientId, verified.identity)
            focusMainWindow()
            return { ok: true, email: verified.identity.email }
        }
    )

    ipcMain.handle(
        IPC_CHANNELS.signInWithSession,
        async (_event, payload: BrowserSignInPayload): Promise<SignInResult> => {
            const { region, customHost, apiHost } = resolveRegion(payload ?? {})
            if (!apiHost) {
                return { ok: false, error: 'Enter a valid host URL, like https://posthog.example.com.' }
            }
            if (sessionLoginInFlight) {
                return { ok: false, error: 'A sign-in window is already open.' }
            }
            sessionLoginInFlight = true
            try {
                const result = await runSessionLogin(apiHost)
                if (!result.ok) {
                    return result
                }
                state.signInWithSession(region, customHost, result.cookies, result.userAgent, result.identity)
                focusMainWindow()
                return { ok: true, email: result.identity.email }
            } finally {
                sessionLoginInFlight = false
            }
        }
    )

    ipcMain.handle(IPC_CHANNELS.signOut, async () => {
        oauthFlow.cancel('Signed out.')
        await actions.signOutCompletely()
    })

    // Closes the caller's own window, not the focused one: the renderer asks for this when
    // it closes its last tab, which can race the user focusing something else
    ipcMain.handle(IPC_CHANNELS.closeWindow, (event) => {
        BrowserWindow.fromWebContents(event.sender)?.close()
    })

    ipcMain.handle(IPC_CHANNELS.openApp, () => {
        if (state.getAuth()) {
            actions.showApp()
        }
    })

    ipcMain.handle(IPC_CHANNELS.openExternal, (_event, url: unknown) => {
        if (typeof url === 'string' && isAllowedExternalUrl(url)) {
            void shell.openExternal(url)
        }
    })

    ipcMain.handle(IPC_CHANNELS.updateSettings, (_event, update: unknown) => {
        if (update && typeof update === 'object') {
            state.updateSettings(update)
        }
        return state.snapshot()
    })
}
