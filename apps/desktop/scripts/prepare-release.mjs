import process from 'node:process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

async function requireFile(file) {
  const info = await stat(file)
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty artifact: ${file}`)
  return info
}

/** Validate builder output before exposing an architecture-specific update feed. */
export async function prepareRelease({ directory, version, arch, verifyOnly = false }) {
  if (!stableVersion.test(version))
    throw new Error('Release version must be stable semver (e.g. 1.0.0)')
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported release architecture: ${arch}`)
  const feed = `latest-${arch}-mac.yml`
  const metadataBytes = await readFile(join(directory, verifyOnly ? feed : 'latest-mac.yml'))
  const metadata = load(metadataBytes.toString())
  if (metadata?.version !== version)
    throw new Error(`Update metadata version must equal ${version}`)
  const archives = ['zip', 'dmg'].map((ext) => `Taut-${version}-mac-${arch}.${ext}`)
  if (
    !Array.isArray(metadata.files) ||
    metadata.files.length !== archives.length ||
    new Set(metadata.files.map((file) => file.url)).size !== archives.length
  ) {
    throw new Error('Update metadata must contain exactly one ZIP and one DMG')
  }
  for (const entry of metadata.files) {
    if (!archives.includes(entry.url)) throw new Error(`Unexpected update artifact: ${entry.url}`)
    const file = join(directory, entry.url)
    const info = await requireFile(file)
    if (entry.size !== undefined && entry.size !== info.size)
      throw new Error(`Size mismatch: ${entry.url}`)
    if (entry.sha512 !== (await digest(file, 'sha512', 'base64')))
      throw new Error(`SHA512 mismatch: ${entry.url}`)
    await requireFile(`${file}.blockmap`)
  }
  const zip = metadata.files.find((file) => file.url === archives[0])
  if (metadata.path !== zip.url || metadata.sha512 !== zip.sha512) {
    throw new Error('Legacy update path and SHA512 must reference the ZIP')
  }
  const alias = `Taut-mac-${arch}.dmg`
  if (verifyOnly) {
    if (
      (await digest(join(directory, alias), 'sha256', 'hex')) !==
      (await digest(join(directory, archives[1]), 'sha256', 'hex'))
    ) {
      throw new Error(`Download alias differs from versioned DMG: ${alias}`)
    }
  } else {
    await copyFile(join(directory, archives[1]), join(directory, alias))
    await writeFile(join(directory, feed), metadataBytes)
  }
  const assets = [...archives, ...archives.map((name) => `${name}.blockmap`), alias, feed].sort()
  const checksums = (
    await Promise.all(
      assets.map(
        async (name) => `${await digest(join(directory, name), 'sha256', 'hex')}  ${name}\n`
      )
    )
  ).join('')
  const checksumFile = join(directory, `SHA256SUMS-${arch}.txt`)
  if (verifyOnly) {
    if ((await readFile(checksumFile, 'utf8')) !== checksums)
      throw new Error(`Release checksums differ for ${arch}`)
  } else {
    await writeFile(checksumFile, checksums)
  }
  return [...assets, `SHA256SUMS-${arch}.txt`]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (
    args.some((arg) => !/^--(dir|version|arch)=.+$/.test(arg) && arg !== '--verify') ||
    !value('dir') ||
    !value('version') ||
    !value('arch')
  ) {
    console.error(
      'Usage: node prepare-release.mjs --dir=PATH --version=1.0.0 --arch=arm64|x64 [--verify]'
    )
    process.exit(1)
  }
  try {
    await prepareRelease({
      directory: value('dir'),
      version: value('version'),
      arch: value('arch'),
      verifyOnly: args.includes('--verify')
    })
    console.log(`Validated release ${value('version')} for ${value('arch')}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
