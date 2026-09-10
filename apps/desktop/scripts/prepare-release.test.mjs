import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareRelease } from './prepare-release.mjs'

const version = '1.0.0'
const hash = (data, algorithm = 'sha512', encoding = 'base64') =>
  createHash(algorithm).update(data).digest(encoding)

async function fixture(t, arch = 'arm64') {
  const directory = await mkdtemp(join(tmpdir(), 'taut-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = []
  for (const ext of ['zip', 'dmg']) {
    const url = `Taut-${version}-mac-${arch}.${ext}`
    const data = Buffer.from(`fixture ${arch} ${ext} bytes`)
    await writeFile(join(directory, url), data)
    await writeFile(join(directory, `${url}.blockmap`), 'fixture blockmap')
    files.push({ url, sha512: hash(data), size: data.length })
  }
  const metadata = { version, files, path: files[0].url, sha512: files[0].sha512 }
  const metadataPath = join(directory, 'latest-mac.yml')
  // JSON is valid YAML, as emitted values still exercise the parser and actual hashes.
  await writeFile(metadataPath, JSON.stringify(metadata))
  return { directory, arch, version, metadata, metadataPath }
}

test('prepares independent feeds, aliases and checksums for both architectures', async (t) => {
  for (const arch of ['arm64', 'x64']) {
    const f = await fixture(t, arch)
    await prepareRelease(f)
    const name = `Taut-mac-${arch}.dmg`
    const alias = await readFile(join(f.directory, name))
    assert.deepEqual(alias, await readFile(join(f.directory, `Taut-${version}-mac-${arch}.dmg`)))
    assert.deepEqual(
      await readFile(join(f.directory, `latest-${arch}-mac.yml`)),
      await readFile(f.metadataPath)
    )
    const sums = await readFile(join(f.directory, `SHA256SUMS-${arch}.txt`), 'utf8')
    assert.ok(sums.includes(`${hash(alias, 'sha256', 'hex')}  ${name}\n`))
    assert.equal(sums.trim().split('\n').length, 6)
    await prepareRelease({ ...f, verifyOnly: true })
  }
})

test('rejects invalid versions and unsupported architecture', async (t) => {
  const f = await fixture(t)
  for (const bad of ['v1.0.0', '1.0.0-beta.1', '01.0.0', '1.0', '1.0.0+build']) {
    await assert.rejects(prepareRelease({ ...f, version: bad }), /stable semver/)
  }
  await assert.rejects(prepareRelease({ ...f, arch: 'universal' }), /architecture/)
})

test('rejects metadata version, architecture, hash, size and path mismatches', async (t) => {
  const f = await fixture(t)
  for (const change of [
    (m) => {
      m.version = '1.0.1'
    },
    (m) => {
      m.files[0].url = 'Taut-1.0.0-mac-x64.zip'
    },
    (m) => {
      m.files[0].sha512 = 'wrong'
    },
    (m) => {
      m.files[0].size += 1
    },
    (m) => {
      m.path = '../outside.zip'
    },
    (m) => {
      m.sha512 = 'wrong'
    },
    (m) => {
      m.files.pop()
    },
    (m) => {
      m.files.push(m.files[0])
    }
  ]) {
    const metadata = structuredClone(f.metadata)
    change(metadata)
    await writeFile(f.metadataPath, JSON.stringify(metadata))
    await assert.rejects(prepareRelease(f))
  }
})

test('requires actual archives and blockmaps', async (t) => {
  for (const suffix of ['zip', 'zip.blockmap', 'dmg', 'dmg.blockmap']) {
    const f = await fixture(t)
    await unlink(join(f.directory, `Taut-${version}-mac-arm64.${suffix}`))
    await assert.rejects(prepareRelease(f), /ENOENT/)
  }
})

test('verification rejects tampered downloaded release artifacts and checksums', async (t) => {
  for (const name of [
    'Taut-mac-arm64.dmg',
    'Taut-1.0.0-mac-arm64.zip.blockmap',
    'SHA256SUMS-arm64.txt'
  ]) {
    const f = await fixture(t)
    await prepareRelease(f)
    await writeFile(join(f.directory, name), 'tampered')
    await assert.rejects(prepareRelease({ ...f, verifyOnly: true }))
  }
})
