import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./restore-fork-paths.sh', import.meta.url))

test('restores fork-owned trees after modify/delete and add/add conflicts without resolving shared code', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'desktop-sync-'))
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
    const write = (path: string, content: string): void => {
        mkdirSync(dirname(join(cwd, path)), { recursive: true })
        writeFileSync(join(cwd, path), content)
    }
    try {
        git('init', '-b', 'desktop')
        git('config', 'user.name', 'Sync test')
        git('config', 'user.email', 'sync@example.com')
        git('config', 'core.hooksPath', '/dev/null')
        write('.github/workflows/deleted.yml', 'original\n')
        write('shared.txt', 'original\n')
        git('add', '.')
        git('commit', '-m', 'base')
        git('branch', 'upstream')
        git('rm', '.github/workflows/deleted.yml')
        write('.github/workflows/desktop-sync.yml', 'fork workflow\n')
        write('products/desktop/package.json', 'fork desktop\n')
        write('shared.txt', 'fork\n')
        git('add', '.')
        git('commit', '-m', 'fork')
        const base = git('rev-parse', 'HEAD')
        git('checkout', 'upstream')
        write('.github/workflows/deleted.yml', 'upstream change\n')
        write('.github/workflows/new.yml', 'upstream workflow\n')
        write('products/desktop/package.json', 'unrelated upstream desktop\n')
        write('products/desktop/new.txt', 'upstream desktop file\n')
        write('shared.txt', 'upstream\n')
        write('upstream.txt', 'keep this\n')
        git('add', '.')
        git('commit', '-m', 'upstream')
        git('checkout', 'desktop')
        assert.equal(spawnSync('git', ['merge', '--no-commit', '--no-ff', 'upstream'], { cwd, env }).status, 1)
        execFileSync('bash', [script, base], { cwd, env })
        assert.equal(git('diff', '--name-only', '--diff-filter=U'), 'shared.txt')
        assert.equal(git('diff', '--cached', '--name-only', base, '--', '.github/workflows', 'products/desktop'), '')
        assert.equal(readFileSync(join(cwd, 'upstream.txt'), 'utf8'), 'keep this\n')
        execFileSync('bash', [script, base], { cwd, env })
        assert.equal(git('diff', '--cached', '--name-only', base, '--', '.github/workflows', 'products/desktop'), '')
    } finally {
        rmSync(cwd, { recursive: true, force: true })
    }
})
