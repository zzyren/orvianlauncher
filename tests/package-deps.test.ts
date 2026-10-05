import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * electron-builder packs `dependencies` and what they depend on, but not peer dependencies.
 * A peer that is installed in development yet is not reachable through regular dependencies makes
 * the packaged app crash at start-up ("Cannot find module"). Every required peer of a package that
 * ships has to be reachable the same way, so it must be declared in package.json.
 */

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const root = join(__dirname, '..')
const read = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf8')) as PackageJson

/** Same lookup Node does: the nearest node_modules folder up the tree that has the package. */
function resolvePackage(name: string, from: string): string | null {
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Every package that ends up in the installer: reachable through dependencies, never through peers. */
function shippedPackages(): Map<string, string> {
  const shipped = new Map<string, string>()
  const queue: Array<{ name: string; from: string }> = Object.keys(read(join(root, 'package.json')).dependencies ?? {}).map((name) => ({ name, from: root }))
  while (queue.length > 0) {
    const { name, from } = queue.pop() as { name: string; from: string }
    const dir = resolvePackage(name, from)
    if (!dir || shipped.has(dir)) continue
    shipped.set(dir, name)
    const pkg = read(join(dir, 'package.json'))
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) queue.push({ name: dep, from: dir })
  }
  return shipped
}

describe('packaged dependencies', () => {
  const shipped = shippedPackages()
  const shippedNames = new Set(shipped.values())

  it('finds the dependency tree to check', () => {
    expect(shippedNames.has('@xmcl/core')).toBe(true)
  })

  it('ships every required peer dependency of the packages it ships', () => {
    const missing: string[] = []
    for (const [dir, name] of shipped) {
      const pkg = read(join(dir, 'package.json'))
      for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
        if (pkg.peerDependenciesMeta?.[peer]?.optional) continue
        if (!shippedNames.has(peer)) missing.push(`${name} needs ${peer}`)
      }
    }
    expect(missing, 'add these to "dependencies" in package.json').toEqual([])
  })
})
