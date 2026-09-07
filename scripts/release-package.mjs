import { resolve } from 'node:path'
import semver from 'semver'

import { isMainModule } from './command-runtime.mjs'
import { createReleaseOperations } from './release-package-operations.mjs'
import {
  getPluginDefinition,
  planReleaseVersion,
  releaseConfirmation,
} from './plugin-command-config.mjs'

export const buildReleasePlan = ({ pluginKey, channel, bump, dryRun, currentVersion }) => {
  const definition = getPluginDefinition(pluginKey)
  const versionPlan = planReleaseVersion({ currentVersion, channel, bump })
  return {
    pluginKey,
    packageName: definition.packageName,
    ...versionPlan,
    dryRun,
    confirmation: releaseConfirmation(definition, versionPlan.targetVersion),
  }
}

const samePath = (left, right) => {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

const validatePublishedMetadata = ({ metadata, plan, sourceCommit }) => {
  if (metadata === null) throw new Error(`${plan.packageName}@${plan.targetVersion} is not visible on npm`)
  if (metadata.version !== plan.targetVersion) {
    throw new Error(`Published version mismatch: expected ${plan.targetVersion}, got ${String(metadata.version)}`)
  }
  if (metadata.gitHead !== sourceCommit) {
    throw new Error(`Published gitHead mismatch: expected ${sourceCommit}, got ${String(metadata.gitHead)}`)
  }
  if (metadata.distTags?.[plan.distTag] !== plan.targetVersion) {
    throw new Error(`Published ${plan.distTag} dist-tag does not point to ${plan.targetVersion}`)
  }
}

const validateRealPublishRepository = (operations) => {
  if (operations.branch() === '') throw new Error('Real publishing requires a named Git branch')
  if (operations.status() !== '') throw new Error('Real publishing requires a clean Git worktree')
}

const runDryRelease = (operations, definition, plan) => {
  let versionSnapshots
  let dryRunError
  try {
    if (plan.changesVersion) {
      versionSnapshots = operations.captureVersionFiles(definition)
      operations.updateVersionFiles(definition, plan.targetVersion)
      const temporaryVersion = operations.readCurrentVersion(definition)
      if (temporaryVersion !== plan.targetVersion) {
        throw new Error(`Dry-run version mismatch: expected ${plan.targetVersion}, got ${temporaryVersion}`)
      }
    }

    operations.inspectPackage(definition)
    operations.publishDryRun(definition, plan.distTag)
  } catch (error) {
    dryRunError = error
  }

  let restoreError
  if (versionSnapshots !== undefined) {
    try {
      operations.restoreVersionFiles(definition, versionSnapshots)
      const restoredVersion = operations.readCurrentVersion(definition)
      if (restoredVersion !== plan.currentVersion) {
        throw new Error(`Dry-run failed to restore version ${plan.currentVersion}; got ${restoredVersion}`)
      }
    } catch (error) {
      restoreError = error
    }
  }

  if (dryRunError !== undefined && restoreError !== undefined) {
    throw new AggregateError([dryRunError, restoreError], 'Dry-run failed and version restoration also failed')
  }
  if (dryRunError !== undefined) throw dryRunError
  if (restoreError !== undefined) throw restoreError

  operations.log(`Dry-run passed for ${plan.packageName}; target version: ${plan.targetVersion}`)
}

export const runRelease = async (options, providedOperations) => {
  const operations = providedOperations ?? createReleaseOperations()
  if (!samePath(operations.cwd(), operations.root)) {
    throw new Error(`Run release commands from the repository root: ${operations.root}`)
  }

  if (!options.dryRun) validateRealPublishRepository(operations)

  const definition = getPluginDefinition(options.pluginKey)
  const currentVersion = operations.readCurrentVersion(definition)
  const plan = buildReleasePlan({ ...options, currentVersion })
  const initialHead = operations.head()

  operations.installWorkspace()
  operations.testPackage(definition)

  if (plan.dryRun) {
    runDryRelease(operations, definition, plan)
    return { ...plan, sourceCommit: initialHead }
  }

  operations.inspectPackage(definition)

  if (operations.status() !== '') throw new Error('Release preflight changed tracked files')

  operations.npmWhoami()
  const currentDistTagVersion = await operations.readDistTagVersion(definition, plan.distTag)
  if (currentDistTagVersion !== null && !semver.gt(plan.targetVersion, currentDistTagVersion)) {
    throw new Error(
      `${plan.targetVersion} must advance npm ${plan.distTag} beyond ${currentDistTagVersion}`,
    )
  }
  const existing = await operations.readRegistryMetadata(definition, plan.targetVersion)
  if (existing !== null) throw new Error(`${plan.packageName}@${plan.targetVersion} already exists on npm`)

  operations.log(`Package: ${plan.packageName}`)
  operations.log(`Current source: ${initialHead}`)
  operations.log(`Target: ${plan.targetVersion} (${plan.distTag})`)
  await operations.confirm(plan.confirmation)

  if (plan.changesVersion) {
    operations.updateVersionFiles(definition, plan.targetVersion)
    operations.commitVersion(definition, plan.targetVersion)
    const committedVersion = operations.readCurrentVersion(definition)
    if (committedVersion !== plan.targetVersion) {
      throw new Error(`Committed version mismatch: expected ${plan.targetVersion}, got ${committedVersion}`)
    }
    if (operations.status() !== '') throw new Error('Version commit did not leave a clean Git worktree')
    operations.inspectPackage(definition)
  }

  const sourceCommit = operations.head()
  let publishError
  try {
    operations.publish(definition, plan.distTag)
  } catch (error) {
    publishError = error
  }

  const readPublished = operations.waitForRegistryMetadata ?? operations.readRegistryMetadata
  let metadata
  try {
    metadata = await readPublished(definition, plan.targetVersion, {
      distTag: plan.distTag,
      sourceCommit,
    })
  } catch (visibilityError) {
    if (publishError !== undefined) {
      throw new AggregateError(
        [publishError, visibilityError],
        'npm publish failed and registry verification also failed',
      )
    }
    throw visibilityError
  }
  try {
    validatePublishedMetadata({ metadata, plan, sourceCommit })
  } catch (verificationError) {
    if (publishError !== undefined) {
      throw new AggregateError([publishError, verificationError], 'npm publish failed and no matching release became visible')
    }
    throw verificationError
  }

  if (publishError !== undefined) {
    operations.log('npm returned an error, but the exact version, gitHead, and dist-tag are verified; no retry was attempted.')
  }
  operations.log(`Published and verified ${plan.packageName}@${plan.targetVersion} from ${sourceCommit}`)
  return { ...plan, sourceCommit }
}

const parseArguments = (argv) => {
  const [pluginKey, ...flags] = argv
  let channel
  let bump
  let dryRun = false

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === '--dry-run') {
      dryRun = true
      continue
    }
    if (flag === '--channel' || flag === '--bump') {
      const value = flags[index + 1]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      if (flag === '--channel') channel = value
      if (flag === '--bump') bump = value
      index += 1
      continue
    }
    throw new Error(`Unknown release argument: ${flag}`)
  }

  if (pluginKey === undefined || channel === undefined || bump === undefined) {
    throw new Error('Usage: release-package.mjs <openclaw|dsh> --channel <stable|beta> --bump <current|patch> [--dry-run]')
  }
  return { pluginKey, channel, bump, dryRun }
}

if (isMainModule(import.meta.url)) {
  try {
    await runRelease(parseArguments(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
