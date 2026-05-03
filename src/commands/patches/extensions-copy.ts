// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { copy, remove } from 'fs-extra'

import { ENGINE_DIR, EXTENSIONS_DIR } from '../../constants'
import { log } from '../../log'
import { ensureDirectory, walkDirectoryTree } from '../../utils'
import { discard } from '../discard'
import { Task, TaskList } from '../../utils/task-list'
import { IMelonPatch } from './command'

// =============================================================================
// Types

export interface IExtensionPatch extends IMelonPatch {
  /** folder name under <repo>/extensions/, e.g. "bento-shell" */
  name: string
  /** absolute source folder under <repo>/extensions/<name>/ */
  srcPath: string
  /** absolute destination under engine/browser/extensions/<name>/ */
  destPath: string
  /** gecko addon id from manifest.json's applications.gecko.id */
  id: string
}

// =============================================================================
// Discovery

function readManifestId(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    return (
      manifest?.applications?.gecko?.id ??
      manifest?.browser_specific_settings?.gecko?.id
    )
  } catch {
    return undefined
  }
}

export function getExtensionPatches(): IExtensionPatch[] {
  if (!existsSync(EXTENSIONS_DIR)) return []

  const patches: IExtensionPatch[] = []
  const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Skip helper folders by convention (e.g. _shared, _proto)
    if (entry.name.startsWith('_')) continue

    const srcPath = join(EXTENSIONS_DIR, entry.name)
    const manifestPath = join(srcPath, 'manifest.json')

    if (!existsSync(manifestPath)) {
      log.info(
        `Skipping extensions/${entry.name}: no manifest.json (not a real extension)`
      )
      continue
    }

    const id = readManifestId(manifestPath)
    if (!id) {
      log.warning(
        `Skipping extensions/${entry.name}: manifest.json has no applications.gecko.id`
      )
      continue
    }

    patches.push({
      name: entry.name,
      srcPath,
      destPath: join(ENGINE_DIR, 'browser', 'extensions', entry.name),
      id,
    })
  }

  return patches
}

// =============================================================================
// Per-extension copy + moz.build generation

// Top-level entries (files or folders) that ship into the engine. Everything
// else (src/, node_modules/, vite.config.ts, package.json, .ladle/, etc.) is
// developer-side and would bloat omni.ja with megabytes of source.
const RUNTIME_ENTRIES = new Set([
  'manifest.json',
  'chrome.manifest',
  'dist',
  'experiments',
  'icons',
  '_locales',
  'background.html',
  'background.js',
  'options.html',
  'popup.html',
])

async function copyExtension(patch: IExtensionPatch): Promise<void> {
  log.info(
    `Copying extensions/${patch.name} → engine/browser/extensions/${patch.name} (runtime entries only)`
  )

  // Wipe destination so removed source files don't linger from a prior build
  if (existsSync(patch.destPath)) {
    await remove(patch.destPath)
  }
  await ensureDirectory(patch.destPath)

  await copy(patch.srcPath, patch.destPath, {
    overwrite: true,
    filter: (src: string) => {
      const rel = relative(patch.srcPath, src)
      if (rel === '') return true // root itself
      const top = rel.split(/[/\\]/)[0] ?? ''
      return RUNTIME_ENTRIES.has(top)
    },
  })
  await generateExtensionMozBuild(patch)
}

async function generateExtensionMozBuild(
  patch: IExtensionPatch
): Promise<void> {
  log.info(`Generating moz.build for ${patch.name} (id=${patch.id})`)

  const files = await walkDirectoryTree(patch.destPath)

  // Mirror of generateAddonMozBuild in download/addon.ts — same wire format.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function runTree(tree: any, parent: string): string {
    if (Array.isArray(tree)) {
      return tree
        .sort()
        .map(
          (file: string) =>
            `FINAL_TARGET_FILES.features["${patch.id}"]${parent} += ["${file
              .replace(patch.destPath + '/', '')
              .replace(patch.destPath, '')}"]`
        )
        .join('\n')
    }

    const current = (tree['.'] as string[])
      .sort()
      .map(
        (f: string) =>
          `FINAL_TARGET_FILES.features["${patch.id}"]${parent} += ["${f
            .replace(patch.destPath + '/', '')
            .replace(patch.destPath, '')}"]`
      )
      .join('\n')

    const children = Object.keys(tree)
      .filter((folder) => folder !== '.')
      .filter((folder) => typeof tree[folder] !== 'undefined')
      .map((folder) => runTree(tree[folder], `${parent}["${folder}"]`))
      .join('\n')

    return `${current}\n${children}`
  }

  writeFileSync(
    join(patch.destPath, 'moz.build'),
    `DEFINES["MOZ_APP_VERSION"] = CONFIG["MOZ_APP_VERSION"]
DEFINES["MOZ_APP_MAXVERSION"] = CONFIG["MOZ_APP_MAXVERSION"]

${runTree(files, '')}`
  )
}

// =============================================================================
// engine/browser/extensions/moz.build registration

async function addExtensionsToMozBuild(
  patches: IExtensionPatch[]
): Promise<void> {
  if (patches.length === 0) return

  log.info('Registering extensions in engine/browser/extensions/moz.build')

  // Discard any prior changes so we always rewrite from a clean upstream state
  await discard('browser/extensions/moz.build')

  const path = join(ENGINE_DIR, 'browser', 'extensions', 'moz.build')
  const existing = readFileSync(path, 'utf-8')

  const dirsLine = `DIRS += [${patches
    .map((p) => p.name)
    .sort()
    .map((name) => `"${name}"`)
    .join(', ')}]`

  // Defensive: avoid double-appending if discard somehow no-ops
  if (existing.includes(dirsLine)) return

  writeFileSync(path, `${existing}\n${dirsLine}\n`)
}

// =============================================================================
// Public task

export function importExtensionsCopy(): Task {
  const patches = getExtensionPatches()

  return {
    name: `Copy ${patches.length} bento extensions`,
    long: true,
    skip: () => patches.length === 0,
    task: () =>
      new TaskList([
        ...patches.map((patch) => ({
          name: `Copy ${patch.name}`,
          task: () => copyExtension(patch),
        })),
        {
          name: 'Register extensions in browser/extensions/moz.build',
          task: () => addExtensionsToMozBuild(patches),
        },
      ]),
  }
}
