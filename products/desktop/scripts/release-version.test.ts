import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextReleaseVersion } from './release-version.ts'

for (const { name, tags, date, expected } of [
    {
        name: 'starts the calendar series after legacy releases',
        tags: ['desktop-v0.3.3', 'desktop-v0.3.2'],
        date: '2026-09-22T12:00:00Z',
        expected: '2026.9.0',
    },
    {
        name: 'increments the highest monthly index regardless of release order',
        tags: ['desktop-v2026.9.2', 'desktop-v2026.9.10', 'desktop-v2026.9.9', 'desktop-v2026.9.0'],
        date: '2026-09-22T12:00:00Z',
        expected: '2026.9.11',
    },
    {
        name: 'ignores releases outside the desktop calendar series',
        tags: ['v2026.9.20', 'desktop-v2026.9.4-beta.1', 'desktop-v2026.9.0', 'desktop-v2026.8.40'],
        date: '2026-09-22T12:00:00Z',
        expected: '2026.9.1',
    },
    {
        name: 'resets the index at the UTC month boundary',
        tags: ['desktop-v2026.9.11'],
        date: '2026-09-30T23:30:00-01:00',
        expected: '2026.10.0',
    },
    {
        name: 'resets the index in a new year',
        tags: ['desktop-v2026.12.8', 'desktop-v2026.1.3'],
        date: '2027-01-01T00:00:00Z',
        expected: '2027.1.0',
    },
]) {
    test(name, () => {
        assert.equal(nextReleaseVersion(tags, new Date(date)), expected)
    })
}
