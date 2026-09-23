import { FEATURE_FLAGS } from 'lib/constants'

import { initKeaTests } from '~/test/init'

import { areClientFeatureFlagsHonored, featureFlagLogic } from './featureFlagLogic'

describe('featureFlagLogic', () => {
    it.each([
        [null, false],
        [{ cloud: false, is_debug: false }, false],
        [{ cloud: true, is_debug: false }, true],
        [{ cloud: false, is_debug: true }, true],
        [{ cloud: true, is_debug: true }, true],
    ])('preflight %s returns %s', (preflight, expected) => {
        expect(areClientFeatureFlagsHonored(preflight)).toBe(expected)
    })

    it.each([undefined, false])('keeps the simple sidebar enabled with a cached value of %s', (cachedValue) => {
        initKeaTests(false)
        localStorage.setItem(
            'lib.logic.featureFlagLogic.featureFlags',
            JSON.stringify({ [FEATURE_FLAGS.SIMPLE_SIDEPANEL]: cachedValue, [FEATURE_FLAGS.FLAT_NAV]: 'test' })
        )
        featureFlagLogic.mount()
        expect(featureFlagLogic.values.featureFlags[FEATURE_FLAGS.SIMPLE_SIDEPANEL]).toBe(true)
        expect(featureFlagLogic.values.featureFlags[FEATURE_FLAGS.FLAT_NAV]).toBe('test')

        featureFlagLogic.actions.setFeatureFlags([], { [FEATURE_FLAGS.SIMPLE_SIDEPANEL]: false })
        expect(featureFlagLogic.values.featureFlags[FEATURE_FLAGS.SIMPLE_SIDEPANEL]).toBe(true)

        featureFlagLogic.actions.setFeatureFlags([], {})
        expect(featureFlagLogic.values.featureFlags[FEATURE_FLAGS.SIMPLE_SIDEPANEL]).toBe(true)
    })
})
