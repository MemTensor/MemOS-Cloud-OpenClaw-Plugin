import semver from 'semver'

const definitions = {
  openclaw: {
    key: 'openclaw',
    packageDirectory: 'packages/openclaw',
    packageName: '@memtensor/memos-cloud-openclaw-plugin',
    tagPrefix: 'v',
    versionFiles: [
      'packages/openclaw/package.json',
      'packages/openclaw/openclaw.plugin.json',
      'packages/openclaw/moltbot.plugin.json',
      'packages/openclaw/clawdbot.plugin.json',
    ],
    requiredBuildOutputs: ['packages/openclaw/lib/memos-core/index.js'],
    requiredPackFiles: ['package/index.js', 'package/openclaw.plugin.json', 'package/lib/memos-core/index.js'],
  },
  dsh: {
    key: 'dsh',
    packageDirectory: 'packages/dsh',
    packageName: '@memtensor/memos-cloud-dsh-plugin',
    tagPrefix: 'dsh-v',
    versionFiles: ['packages/dsh/package.json'],
    requiredBuildOutputs: ['packages/dsh/lib/index.js', 'packages/dsh/lib/index.d.ts'],
    requiredPackFiles: ['package/lib/index.js', 'package/lib/index.d.ts', 'package/cordis.patch.yml'],
  },
}

export const PLUGIN_DEFINITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [key, Object.freeze({
      ...definition,
      versionFiles: Object.freeze([...definition.versionFiles]),
      requiredBuildOutputs: Object.freeze([...definition.requiredBuildOutputs]),
      requiredPackFiles: Object.freeze([...definition.requiredPackFiles]),
    })]),
  ),
)

export const getPluginDefinition = (pluginKey) => {
  const definition = PLUGIN_DEFINITIONS[pluginKey]
  if (definition === undefined) throw new Error(`Unknown plugin key: ${pluginKey}`)
  return definition
}

const assertReleaseInput = ({ currentVersion, channel, bump }) => {
  if (semver.valid(currentVersion) === null) {
    throw new Error(`Release version must be valid SemVer: ${currentVersion}`)
  }
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`Unknown release channel: ${channel}`)
  }
  if (bump !== 'current' && bump !== 'patch') {
    throw new Error(`Unknown release bump: ${bump}`)
  }
}

const planPatchVersion = ({ currentVersion, channel }) => {
  const prerelease = semver.prerelease(currentVersion)
  if (channel === 'beta') {
    const releaseType = prerelease?.[0] === 'beta' ? 'prerelease' : 'prepatch'
    return semver.inc(currentVersion, releaseType, 'beta')
  }

  return semver.inc(currentVersion, 'patch')
}

export const planReleaseVersion = ({ currentVersion, channel, bump }) => {
  assertReleaseInput({ currentVersion, channel, bump })

  if (channel === 'stable' && bump === 'current' && semver.prerelease(currentVersion) !== null) {
    throw new Error('A stable current-version release requires a stable version')
  }

  if (channel === 'beta' && bump === 'current') {
    const prerelease = semver.prerelease(currentVersion)
    if (prerelease === null || prerelease[0] !== 'beta') {
      throw new Error('A beta current-version release requires a beta prerelease')
    }
  }

  const targetVersion = bump === 'current'
    ? currentVersion
    : planPatchVersion({ currentVersion, channel })

  if (targetVersion === null) throw new Error(`Unable to calculate the next ${channel} ${bump} version`)
  if (bump === 'patch' && !semver.gt(targetVersion, currentVersion)) {
    throw new Error(`The ${channel} patch version must advance beyond ${currentVersion}; calculated ${targetVersion}`)
  }

  return {
    currentVersion,
    targetVersion,
    distTag: channel === 'stable' ? 'latest' : 'beta',
    changesVersion: bump === 'patch',
  }
}

export const releaseConfirmation = (definition, targetVersion) => (
  `PUBLISH ${definition.tagPrefix}${targetVersion}`
)
