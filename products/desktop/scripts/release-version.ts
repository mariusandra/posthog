import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function nextReleaseVersion(releaseTags: readonly string[], date: Date = new Date()): string {
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const pattern = new RegExp(`^desktop-v${year}\\.${month}\\.(0|[1-9]\\d*)$`)
    let index = 0
    for (const tag of releaseTags) {
        const match = pattern.exec(tag)
        if (match) {
            index = Math.max(index, Number(match[1]) + 1)
        }
    }
    return `${year}.${month}.${index}`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const releaseTags = readFileSync(process.argv[2], 'utf8').split(/\r?\n/)
    const version = nextReleaseVersion(releaseTags)
    const packagePath = new URL('../package.json', import.meta.url)
    const packageJson: Record<string, unknown> = JSON.parse(readFileSync(packagePath, 'utf8'))
    packageJson.version = version
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 4)}\n`)
    process.stdout.write(`${version}\n`)
}
