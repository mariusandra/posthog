import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { identityFromMe } from './identity.ts'

describe('identity from /api/users/@me/', () => {
    test('reads the email and organization membership level', () => {
        assert.deepEqual(identityFromMe({ email: 'someone@example.com', organization: { membership_level: 15 } }), {
            email: 'someone@example.com',
            membershipLevel: 15,
        })
    })

    // Losing the level silently downgrades the whole UI to a member's view, so the
    // shapes that could plausibly come back all have to resolve to null rather than throw
    for (const [label, payload] of [
        ['no organization', { email: 'a@b.co' }],
        ['null organization', { email: 'a@b.co', organization: null }],
        ['level missing', { email: 'a@b.co', organization: {} }],
        ['level not a number', { email: 'a@b.co', organization: { membership_level: 'owner' } }],
    ] as const) {
        test(`resolves the level to null when ${label}`, () => {
            assert.equal(identityFromMe(payload).membershipLevel, null)
            assert.equal(identityFromMe(payload).email, 'a@b.co')
        })
    }

    for (const [label, payload] of [
        ['a missing email', { organization: { membership_level: 8 } }],
        ['a null body', null],
        ['a non-object body', 'nope'],
    ] as const) {
        test(`falls back to "unknown" for ${label}`, () => {
            assert.equal(identityFromMe(payload).email, 'unknown')
        })
    }
})
