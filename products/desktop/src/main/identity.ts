/**
 * Reads who is signed in out of an /api/users/@me/ response.
 *
 * The membership level matters beyond display: it drives the synthesized
 * access-control app context (server/access-context.ts), so losing it silently
 * downgrades the whole UI to a plain member's view.
 *
 * This module must stay free of Electron imports so it can be unit tested with
 * plain Node.
 */

export interface SignedInIdentity {
    email: string
    /** organization.membership_level: 1 member, 8 admin, 15 owner. Null when unknown. */
    membershipLevel: number | null
}

export function identityFromMe(payload: unknown): SignedInIdentity {
    const user = (payload ?? {}) as { email?: unknown; organization?: { membership_level?: unknown } | null }
    const level = user.organization?.membership_level
    return {
        email: typeof user.email === 'string' && user.email ? user.email : 'unknown',
        membershipLevel: typeof level === 'number' ? level : null,
    }
}
