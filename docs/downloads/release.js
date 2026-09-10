const repository = 'https://github.com/Thiagoxp95/taut'
const status = document.getElementById('release-status')
try {
  const response = await fetch('https://api.github.com/repos/Thiagoxp95/taut/releases/latest', {
    signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/vnd.github+json' }
  })
  if (response.status === 404) {
    status.textContent = 'The first signed release is being prepared. Downloads will appear here when it is published.'
  } else {
    if (!response.ok) throw new Error('Release lookup failed')
    const release = await response.json()
    if (release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error('No stable release')
    let available = 0
    for (const arch of ['arm64', 'x64']) {
      const name = `Taut-mac-${arch}.dmg`
      if (!release.assets.some(asset => asset.name === name && asset.size > 0)) continue
      const link = document.getElementById(`download-${arch}`)
      link.href = `${repository}/releases/latest/download/${name}`
      link.removeAttribute('aria-disabled')
      available++
    }
    status.textContent = available === 2 ? `${release.tag_name} · Available for Apple Silicon and Intel` : 'Release downloads are being prepared. Check GitHub Releases for availability.'
  }
} catch {
  status.textContent = 'Could not check download availability. Visit GitHub Releases for the latest builds.'
}
