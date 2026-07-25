/**
 * The access-control half of `window.POSTHOG_APP_CONTEXT`.
 *
 * PostHog's frontend gates scenes, buttons and panels on `resource_access_control`
 * and `effective_resource_access_control`, and it fails *closed*: with no level for a
 * resource, `getAccessControlDisabledReason` treats the user as having no access
 * (frontend/src/lib/utils/accessControlUtils.ts). Both maps are only ever produced by
 * Django's server-rendered app context (posthog/utils.py), and no API endpoint serves
 * them, so the desktop app -- which deliberately ships no app context and bootstraps
 * from /_preflight/ and /api/users/@me/ instead -- denied everything gated this way,
 * regardless of how the user signed in.
 *
 * We synthesize the two maps from the organization membership level the app already
 * learns at sign-in. It is UI-only: every one of these checks is enforced again
 * server-side, so the worst case is offering a control whose request is then refused.
 * That is the right way round -- the alternative was refusing everything up front.
 *
 * The levels mirror `highest_access_level` / `default_access_level` in
 * posthog/rbac/user_access_control.py. Getting them wrong is not safe-by-default:
 * `accessLevelSatisfied` compares by index within the resource's own ladder, so a
 * level outside that ladder (e.g. "manager" for activity_log, whose ladder stops at
 * "viewer") indexes to -1 and denies.
 *
 * Caveat: for a plain member we return the no-rules default rather than their real
 * RBAC grants, which we cannot know client-side. A member restricted by RBAC sees
 * controls the server then refuses.
 *
 * This module must stay free of Electron imports so it can be unit tested with plain Node.
 */

/** OrganizationMembershipLevel.Admin. Owner (15) is above it. */
export const ADMIN_MEMBERSHIP_LEVEL = 8

/** Resources whose ladder stops at viewer. */
const VIEWER_ONLY_RESOURCES = ['activity_log', 'toolbar']

export function accessLevelFor(resource: string, isAdmin: boolean): string {
    if (resource === 'project') {
        return 'admin'
    }
    if (resource === 'organization') {
        return isAdmin ? 'admin' : 'member'
    }
    if (VIEWER_ONLY_RESOURCES.includes(resource)) {
        return 'viewer'
    }
    return isAdmin ? 'manager' : 'editor'
}

export function isAdminMembership(membershipLevel: number | null): boolean {
    return membershipLevel !== null && membershipLevel >= ADMIN_MEMBERSHIP_LEVEL
}

/**
 * Keys that are not resource names but that JS runtimes probe for on any object
 * (promise unwrapping, serialization, React internals). Answering those with an
 * access level would make the map look like a thenable or stringify oddly.
 */
const NON_RESOURCE_KEYS = [
    'then',
    'toJSON',
    'toString',
    'valueOf',
    'constructor',
    'hasOwnProperty',
    'inspect',
    'nodeType',
]

/**
 * Browser source installing the context. A Proxy rather than an enumerated map so a
 * resource added upstream keeps working without a desktop release; the rule is
 * "this user's level for any resource", which is exactly what a Proxy expresses.
 *
 * Only the three fields are set. `current_team`, `current_user`, `anonymous` and
 * `preflight` are deliberately left absent so the app still bootstraps from the API
 * (getAppContext.ts falls back to the desktop's remote context ids for the first two,
 * and an absent `anonymous` reads as signed in). `default_event_name` is pinned to
 * $pageview because `getDefaultEventName` only defaults to it when the whole context
 * is missing -- with a context present but the field absent it would flip to "all
 * events", silently changing what paths and funnels default to.
 */
export function appContextScript(isAdmin: boolean): string {
    return `
(function () {
    var isAdmin = ${isAdmin ? 'true' : 'false'}
    var viewerOnly = ${JSON.stringify(VIEWER_ONLY_RESOURCES)}
    var notResources = ${JSON.stringify(NON_RESOURCE_KEYS)}
    function levelFor(resource) {
        if (resource === 'project') { return 'admin' }
        if (resource === 'organization') { return isAdmin ? 'admin' : 'member' }
        if (viewerOnly.indexOf(resource) !== -1) { return 'viewer' }
        return isAdmin ? 'manager' : 'editor'
    }
    var handler = {
        get: function (_target, prop) {
            if (typeof prop !== 'string' || notResources.indexOf(prop) !== -1) { return undefined }
            if (!/^[a-z][a-z0-9_]*$/.test(prop)) { return undefined }
            return levelFor(prop)
        },
    }
    window.POSTHOG_APP_CONTEXT = {
        resource_access_control: new Proxy({}, handler),
        effective_resource_access_control: new Proxy({}, handler),
        default_event_name: '$pageview',
    }
})()
`.trim()
}
