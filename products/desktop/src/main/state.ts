/**
 * Holds the app's runtime state: settings plus the decrypted credentials,
 * which live only in main-process memory and are handed to the local backend's
 * proxy on demand. They are never exposed over IPC.
 *
 * Three auth methods coexist, and exactly one is active at a time: the cookies of
 * a real PostHog login (the only one that reaches the whole product), a pasted
 * personal API key (phx_...), or an OAuth session from the browser sign-in (pha_
 * access + phr_ refresh token). The proxy calls getFreshAuth() per request, which
 * transparently refreshes the OAuth access token shortly before it expires.
 */

import type { AuthMethod, CloudRegion, DesktopState, DesktopStateSettings } from '../shared/ipc.ts'
import {
    applySetCookies,
    cookieHeader,
    type CookieJar,
    csrfTokenFrom,
    hasSessionCookie,
    parseCookieJar,
    persistableCookies,
} from './cookies.ts'
import type { SignedInIdentity } from './identity.ts'
import { REFRESH_MARGIN_MS, refreshAccessToken, type TokenSet } from './oauth.ts'
import { resolveApiHost } from './regions.ts'
import { decryptSecret, encryptSecret } from './secrets.ts'
import type { UpstreamAuth } from './server/backend.ts'
import { type DesktopSettings, JsonStore } from './settings.ts'

export interface AppStateContext {
    version: string
    frontendBuilt: () => boolean
}

interface OAuthSession {
    accessToken: string
    refreshToken: string
    expiresAt: number
    clientId: string
}

interface CookieSession {
    jar: CookieJar
    userAgent: string | null
}

/** Every stored credential, blanked. Signing in one way must not leave another way behind. */
const CLEARED_CREDENTIALS = {
    encryptedApiKey: null,
    encryptedOauthRefreshToken: null,
    encryptedOauthAccessToken: null,
    oauthExpiresAt: null,
    oauthClientId: null,
    encryptedSessionCookies: null,
    sessionUserAgent: null,
    membershipLevel: null,
} satisfies Partial<DesktopSettings>

export class AppState {
    private readonly store: JsonStore<DesktopSettings>
    private readonly context: AppStateContext
    private apiKey: string | null = null
    private oauth: OAuthSession | null = null
    private cookieSession: CookieSession | null = null
    /** Serialized form of what is on disk, so cookie churn does not rewrite settings.json per request */
    private persistedCookies: string | null = null
    private authLoaded = false
    private appOrigin: string | null = null
    private refreshInFlight: Promise<UpstreamAuth | null> | null = null

    constructor(store: JsonStore<DesktopSettings>, context: AppStateContext) {
        this.store = store
        this.context = context
    }

    /**
     * Decrypts stored credentials lazily, on first getAuth(). AppState is constructed before
     * app.whenReady(), and Electron's safeStorage throws when used before the app is ready —
     * eager decryption in the constructor silently signed the user out on every launch.
     */
    private loadAuth(): void {
        if (this.authLoaded) {
            return
        }
        this.authLoaded = true
        const encryptedCookies = this.store.get('encryptedSessionCookies')
        if (encryptedCookies) {
            const raw = decryptSecret(encryptedCookies)
            const jar = raw ? parseCookieJar(raw) : null
            if (jar && hasSessionCookie(jar)) {
                this.cookieSession = { jar, userAgent: this.store.get('sessionUserAgent') }
                this.persistedCookies = JSON.stringify(persistableCookies(jar))
                return
            }
        }
        const encryptedApiKey = this.store.get('encryptedApiKey')
        if (encryptedApiKey) {
            this.apiKey = decryptSecret(encryptedApiKey)
            return
        }
        const encryptedRefresh = this.store.get('encryptedOauthRefreshToken')
        const clientId = this.store.get('oauthClientId')
        if (encryptedRefresh && clientId) {
            const refreshToken = decryptSecret(encryptedRefresh)
            const encryptedAccess = this.store.get('encryptedOauthAccessToken')
            const accessToken = encryptedAccess ? decryptSecret(encryptedAccess) : null
            if (refreshToken) {
                this.oauth = {
                    refreshToken,
                    accessToken: accessToken || '',
                    expiresAt: this.store.get('oauthExpiresAt') || 0,
                    clientId,
                }
            }
        }
    }

    setAppOrigin(origin: string): void {
        this.appOrigin = origin
    }

    apiHost(): string | null {
        return resolveApiHost(this.store.get('region'), this.store.get('customHost'))
    }

    registeredClientId(apiHost: string): string | null {
        return this.store.get('oauthRegisteredClients')[apiHost] || null
    }

    rememberRegisteredClientId(apiHost: string, clientId: string): void {
        this.store.set({
            oauthRegisteredClients: { ...this.store.get('oauthRegisteredClients'), [apiHost]: clientId },
        })
    }

    /** Drives the synthesized access-control app context; null when signed out or unknown. */
    membershipLevel(): number | null {
        return this.getAuth() ? this.store.get('membershipLevel') : null
    }

    /**
     * Records who the current credentials belong to, re-read from the API rather than
     * captured at sign-in. Needed because a session stored by an older build has no
     * membership level, and without one the access-control context is never injected
     * and the app denies everything gated on it until the user signs in again.
     */
    rememberIdentity(identity: SignedInIdentity): void {
        this.store.set({ signedInEmail: identity.email, membershipLevel: identity.membershipLevel })
    }

    authMethod(): AuthMethod | null {
        this.loadAuth()
        if (this.cookieSession) {
            return 'session'
        }
        if (this.apiKey) {
            return 'api-key'
        }
        if (this.oauth) {
            return 'oauth'
        }
        return null
    }

    /** Last-known auth, without refreshing. The OAuth access token may be expired. */
    getAuth(): UpstreamAuth | null {
        this.loadAuth()
        const host = this.apiHost()
        if (!host) {
            return null
        }
        if (this.cookieSession) {
            return {
                apiHost: host,
                mode: 'cookie',
                cookieHeader: cookieHeader(this.cookieSession.jar),
                csrfToken: csrfTokenFrom(this.cookieSession.jar),
                userAgent: this.cookieSession.userAgent,
            }
        }
        if (this.apiKey) {
            return { apiHost: host, mode: 'bearer', accessToken: this.apiKey }
        }
        if (this.oauth?.accessToken) {
            return { apiHost: host, mode: 'bearer', accessToken: this.oauth.accessToken }
        }
        return null
    }

    /** The session cookies as they stand, for a server-side logout on sign-out. */
    cookieCredentials(): { jar: CookieJar; userAgent: string | null } | null {
        this.loadAuth()
        return this.cookieSession ? { ...this.cookieSession } : null
    }

    /**
     * Merges the upstream's Set-Cookie headers into the session. Django rotates the
     * session key on privilege changes and re-issues the CSRF token, so dropping
     * these would sign the app out mid-use. Returns true when the upstream cleared
     * the session and the app should drop back to the sign-in shell.
     */
    updateCookies(setCookieHeaders: string[]): boolean {
        if (!this.cookieSession) {
            return false
        }
        const jar = applySetCookies(this.cookieSession.jar, setCookieHeaders)
        if (!hasSessionCookie(jar)) {
            this.signOut()
            return true
        }
        this.cookieSession = { ...this.cookieSession, jar }
        const persistable = JSON.stringify(persistableCookies(jar))
        if (persistable !== this.persistedCookies) {
            this.persistedCookies = persistable
            this.store.set({ encryptedSessionCookies: encryptSecret(persistable) })
        }
        return false
    }

    /** Auth for an upstream request, refreshing the OAuth access token when it is about to expire. */
    async getFreshAuth(): Promise<UpstreamAuth | null> {
        this.loadAuth()
        if (!this.oauth || this.oauth.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
            return this.getAuth()
        }
        this.refreshInFlight ??= this.refreshOAuth().finally(() => {
            this.refreshInFlight = null
        })
        return await this.refreshInFlight
    }

    /**
     * Called when the upstream rejects the current credentials (401 on @me).
     * For OAuth this forces one refresh attempt first — an expired access token
     * is recoverable, only a rejected refresh token means the session is dead.
     * Returns true when the app should sign out.
     */
    async handleAuthRejected(): Promise<boolean> {
        this.loadAuth()
        if (this.cookieSession) {
            // Nothing to refresh: an expired or revoked session can only be replaced
            // by signing in again
            this.signOut()
            return true
        }
        if (this.oauth) {
            this.oauth.expiresAt = 0
            const auth = await this.getFreshAuth()
            if (auth) {
                return false
            }
            // A transient refresh failure right after an upstream 401 still strands the
            // user, so treat any failed forced refresh as terminal
            this.signOut()
            return true
        }
        this.signOut()
        return true
    }

    private async refreshOAuth(): Promise<UpstreamAuth | null> {
        const host = this.apiHost()
        if (!host || !this.oauth) {
            return null
        }
        const result = await refreshAccessToken({
            apiHost: host,
            clientId: this.oauth.clientId,
            refreshToken: this.oauth.refreshToken,
        })
        if (result.ok) {
            this.oauth = { ...this.oauth, ...result.tokens }
            this.store.set({
                encryptedOauthRefreshToken: encryptSecret(result.tokens.refreshToken),
                encryptedOauthAccessToken: encryptSecret(result.tokens.accessToken),
                oauthExpiresAt: result.tokens.expiresAt,
            })
            return { apiHost: host, mode: 'bearer', accessToken: result.tokens.accessToken }
        }
        if (result.terminal) {
            this.signOut()
            return null
        }
        // Transient failure (offline, 5xx): hand back the stale token so offline
        // cache serving keeps working; the next request retries the refresh
        return this.getAuth()
    }

    signIn(region: CloudRegion, customHost: string, apiKey: string, identity: SignedInIdentity): void {
        this.apiKey = apiKey
        this.oauth = null
        this.cookieSession = null
        this.persistedCookies = null
        this.authLoaded = true
        this.store.set({
            region,
            customHost,
            ...CLEARED_CREDENTIALS,
            encryptedApiKey: encryptSecret(apiKey),
            signedInEmail: identity.email,
            membershipLevel: identity.membershipLevel,
        })
    }

    signInOAuth(
        region: CloudRegion,
        customHost: string,
        tokens: TokenSet,
        clientId: string,
        identity: SignedInIdentity
    ): void {
        this.apiKey = null
        this.oauth = { ...tokens, clientId }
        this.cookieSession = null
        this.persistedCookies = null
        this.authLoaded = true
        this.store.set({
            region,
            customHost,
            ...CLEARED_CREDENTIALS,
            encryptedOauthRefreshToken: encryptSecret(tokens.refreshToken),
            encryptedOauthAccessToken: encryptSecret(tokens.accessToken),
            oauthExpiresAt: tokens.expiresAt,
            oauthClientId: clientId,
            signedInEmail: identity.email,
            membershipLevel: identity.membershipLevel,
        })
    }

    signInWithSession(
        region: CloudRegion,
        customHost: string,
        jar: CookieJar,
        userAgent: string,
        identity: SignedInIdentity
    ): void {
        this.apiKey = null
        this.oauth = null
        this.cookieSession = { jar, userAgent }
        this.persistedCookies = JSON.stringify(persistableCookies(jar))
        this.authLoaded = true
        this.store.set({
            region,
            customHost,
            ...CLEARED_CREDENTIALS,
            encryptedSessionCookies: encryptSecret(this.persistedCookies),
            sessionUserAgent: userAgent,
            signedInEmail: identity.email,
            membershipLevel: identity.membershipLevel,
        })
    }

    signOut(): void {
        this.apiKey = null
        this.oauth = null
        this.cookieSession = null
        this.persistedCookies = null
        this.authLoaded = true
        this.store.set({ ...CLEARED_CREDENTIALS, signedInEmail: null })
    }

    updateSettings(update: Partial<DesktopStateSettings>): void {
        // Retargeting the host while signed in would send the stored credentials to a
        // different server on the next request: with a session that is the user's whole
        // account. The preload that exposes this over IPC is attached to the window
        // running the proxied PostHog app, so anything executing in that page can call
        // it. Refused here rather than trusted to the shell, which only offers the
        // region picker when signed out anyway.
        if (this.authMethod() !== null) {
            return
        }
        const patch: Partial<DesktopSettings> = {}
        if (update.region) {
            patch.region = update.region
        }
        if (update.customHost !== undefined) {
            patch.customHost = update.customHost
        }
        this.store.set(patch)
    }

    snapshot(): DesktopState {
        return {
            version: this.context.version,
            platform: process.platform,
            settings: {
                region: this.store.get('region'),
                customHost: this.store.get('customHost'),
            },
            signedIn: this.getAuth() !== null,
            signedInEmail: this.store.get('signedInEmail'),
            authMethod: this.authMethod(),
            // Self-registration (RFC 7591) works against any instance, so every region qualifies
            browserSignIn: { us: true, eu: true, custom: true },
            apiHost: this.apiHost(),
            appOrigin: this.appOrigin,
            frontendBuilt: this.context.frontendBuilt(),
        }
    }
}
