import console from 'node:console'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { URL } from 'node:url'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME

if (!tag) {
  throw new Error('Pass a release tag, for example: npm run release:check-version -- v0.2.0')
}

const expectedTag = `v${packageJson.version}`
if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}`)
}

console.log(`Release tag ${tag} matches package version ${packageJson.version}.`)
