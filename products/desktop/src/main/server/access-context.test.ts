import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { accessLevelFor, appContextScript, isAdminMembership } from './access-context.ts'

/** Runs the emitted browser source against a stand-in window and hands back the context. */
function installContext(isAdmin: boolean): Record<string, any> {
    const window: Record<string, any> = {}
    new Function('window', appContextScript(isAdmin))(window)
    return window['POSTHOG_APP_CONTEXT']
}

describe('access-control app context', () => {
    for (const [level, admin] of [
        [1, false],
        [8, true],
        [15, true],
        [null, false],
    ] as const) {
        test(`membership level ${level} is admin: ${admin}`, () => {
            assert.equal(isAdminMembership(level), admin)
        })
    }

    // The levels must sit inside each resource's own ladder: accessLevelSatisfied compares
    // by index, so an off-ladder value indexes to -1 and denies instead of allowing
    for (const [resource, adminLevel, memberLevel] of [
        ['warehouse_objects', 'manager', 'editor'],
        ['dashboard', 'manager', 'editor'],
        ['insight', 'manager', 'editor'],
        // Ladders that stop short
        ['activity_log', 'viewer', 'viewer'],
        ['toolbar', 'viewer', 'viewer'],
        ['project', 'admin', 'admin'],
        ['organization', 'admin', 'member'],
    ] as const) {
        test(`${resource} resolves to ${adminLevel} for an admin and ${memberLevel} for a member`, () => {
            assert.equal(accessLevelFor(resource, true), adminLevel)
            assert.equal(accessLevelFor(resource, false), memberLevel)
        })
    }

    test('the emitted script agrees with accessLevelFor', () => {
        // Two copies of the rule exist: the TypeScript one and the JS the browser runs.
        // This is what stops them drifting apart.
        for (const isAdmin of [true, false]) {
            const context = installContext(isAdmin)
            for (const resource of ['warehouse_objects', 'dashboard', 'activity_log', 'toolbar', 'organization']) {
                assert.equal(
                    context['resource_access_control'][resource],
                    accessLevelFor(resource, isAdmin),
                    `${resource} (admin: ${isAdmin})`
                )
                assert.equal(context['effective_resource_access_control'][resource], accessLevelFor(resource, isAdmin))
            }
        }
    })

    test('answers for a resource it has never heard of', () => {
        // A resource added upstream must not silently become "denied" until the desktop
        // app ships a matching release
        assert.equal(installContext(true)['resource_access_control']['some_future_product'], 'manager')
    })

    test('does not answer for keys that are not resources', () => {
        const context = installContext(true)
        // `then` in particular: an object that answers it looks like a promise and would
        // hang anything that awaits the context
        for (const key of ['then', 'toJSON', 'constructor', 'hasOwnProperty', 'Symbol(x)', 'CamelCase']) {
            assert.equal(context['resource_access_control'][key], undefined, key)
        }
    })

    test('leaves the API-bootstrapped fields absent', () => {
        const context = installContext(true)
        // These have to stay missing or the app stops fetching them: getAppContext.ts
        // falls back to the desktop's remote ids for team/user, and an absent `anonymous`
        // is what reads as signed in
        for (const key of ['current_team', 'current_user', 'anonymous', 'preflight']) {
            assert.equal(key in context, false, key)
        }
        // Pinned because a present-but-fieldless context flips the default to all events
        assert.equal(context['default_event_name'], '$pageview')
    })
})
