import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildIndexHtml } from './html.ts'

describe('buildIndexHtml', () => {
    const manifest = {
        css: 'static/index-AAAA1111.css',
        font: 'static/assets/Inter-BBBB2222.woff2',
        js: ['static/index-CCCC3333.js', 'static/chunk-EEEE5555.js'],
        authenticatedJs: ['static/AuthenticatedShell-DDDD4444.js'],
    }

    test('references the hashed entry chunk and stylesheet', () => {
        const html = buildIndexHtml(manifest)
        assert.match(html, /ESBUILD_LOAD_SCRIPT\("index-CCCC3333\.js"\)/)
        assert.match(html, /index-AAAA1111\.css/)
        assert.match(html, /<link rel="modulepreload" href="\/static\/chunk-EEEE5555\.js">/)
        assert.match(html, /<link rel="modulepreload" href="\/static\/AuthenticatedShell-DDDD4444\.js">/)
        assert.match(html, /as="font"/)
    })

    test('keeps the app-context global unset while signed out', () => {
        const html = buildIndexHtml(manifest)
        assert.doesNotMatch(html, /POSTHOG_APP_CONTEXT/)
        assert.match(html, /window\.JS_URL = ''/)
        assert.match(html, /<div id="root"><\/div>/)
    })

    test('injects the access-control context once a membership level is known', () => {
        // Without it every scene and control gated by userHasAccess denies, because the
        // frontend treats an unknown access level as no access
        const admin = buildIndexHtml(manifest, { membershipLevel: 15 })
        assert.match(admin, /window\.POSTHOG_APP_CONTEXT/)
        assert.match(admin, /var isAdmin = true/)

        const member = buildIndexHtml(manifest, { membershipLevel: 1 })
        assert.match(member, /var isAdmin = false/)

        // Null is the signed-out/unknown case and must stay indistinguishable from before
        assert.doesNotMatch(buildIndexHtml(manifest, { membershipLevel: null }), /POSTHOG_APP_CONTEXT/)
    })

    test('exposes the desktop version and platform to the frontend', () => {
        const html = buildIndexHtml(manifest, { desktopVersion: '1.2.3', desktopPlatform: 'darwin' })
        assert.match(html, /window\.__POSTHOG_DESKTOP__ = \{ version: "1\.2\.3", platform: "darwin" \}/)
    })

    test('falls back to hashless entrypoints when the manifest is sparse', () => {
        const html = buildIndexHtml({ css: '', font: '', js: [], authenticatedJs: [] })
        assert.match(html, /ESBUILD_LOAD_SCRIPT\("index\.js"\)/)
        assert.match(html, /index\.css/)
    })
})
