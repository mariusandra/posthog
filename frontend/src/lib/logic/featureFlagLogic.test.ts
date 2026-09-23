import posthog from 'posthog-js'

import { FEATURE_FLAGS } from 'lib/constants'

import { initKeaTests } from '~/test/init'

import { areClientFeatureFlagsHonored, featureFlagLogic } from './featureFlagLogic'

describe('featureFlagLogic', () => {
    it.each([
        [FEATURE_FLAGS.SIMPLE_SIDEPANEL, undefined],
        [FEATURE_FLAGS.SIMPLE_SIDEPANEL, false],
        [FEATURE_FLAGS.POSTHOG_TERMINAL, undefined],
        [FEATURE_FLAGS.POSTHOG_TERMINAL, false],
    ] as const)('keeps %s enabled with a cached value of %s', (flag, cachedValue) => {
        initKeaTests(false)
        localStorage.setItem(
            'lib.logic.featureFlagLogic.featureFlags',
            JSON.stringify({ [flag]: cachedValue, [FEATURE_FLAGS.FLAT_NAV]: 'test' })
        )
        featureFlagLogic.mount()
        expect(featureFlagLogic.values.featureFlags[flag]).toBe(true)
        expect(featureFlagLogic.values.featureFlags[FEATURE_FLAGS.FLAT_NAV]).toBe('test')

        featureFlagLogic.actions.setFeatureFlags([], { [flag]: false })
        expect(featureFlagLogic.values.featureFlags[flag]).toBe(true)

        featureFlagLogic.actions.setFeatureFlags([], {})
        expect(featureFlagLogic.values.featureFlags[flag]).toBe(true)
    })

    describe('areClientFeatureFlagsHonored', () => {
        it.each([
            [null, false],
            [{ cloud: false, is_debug: false }, false],
            [{ cloud: true, is_debug: false }, true],
            [{ cloud: false, is_debug: true }, true],
            [{ cloud: true, is_debug: true }, true],
        ])('preflight %s returns %s', (preflight, expected) => {
            expect(areClientFeatureFlagsHonored(preflight)).toBe(expected)
        })
    })

    describe('receivedFeatureFlags', () => {
        afterEach(() => {
            delete (posthog as any).config
        })

        // The mocked onFeatureFlags never calls back, as posthog-js does not when flags are off.
        it.each([
            ['flags disabled', { advanced_disable_flags: true }, true],
            ['flags enabled', { advanced_disable_flags: false }, false],
        ])('with %s is %s before any flags arrive', (_name, config, expected) => {
            ;(posthog as any).config = config
            initKeaTests()

            const logic = featureFlagLogic()
            logic.mount()

            expect(logic.values.receivedFeatureFlags).toBe(expected)
        })
    })
})
