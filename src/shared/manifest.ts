import { z } from 'zod'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'SHA-256 inválido')
const packFile = z.object({
  path: z.string().min(1), sha256, size: z.number().int().nonnegative(),
  url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Solo HTTPS'),
  type: z.enum(['mod', 'config', 'defaultconfig', 'kubejs', 'script', 'resourcepack', 'shaderpack', 'other']),
  required: z.boolean(), userMutable: z.boolean(), userDeletable: z.boolean()
})

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Solo HTTPS')

/** The single archive the files come from, with enough data to verify it before opening it. */
const archive = z.object({ url: httpsUrl, sha256, size: z.number().int().positive() })

const server = z.object({
  name: z.string().min(1).max(64),
  address: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional()
})

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  pack: z.object({ id: z.literal('orvian'), name: z.literal('Orvian'), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), minecraft: z.literal('1.20.1'), loader: z.literal('forge'), forge: z.string().min(1) }),
  runtime: z.object({ java: z.literal(17) }),
  minimumLauncher: z.string().regex(/^\d+\.\d+\.\d+/), publishedAt: z.string().datetime(), changelog: z.array(z.string()), files: z.array(packFile),
  /** Optional so manifests published by older launchers keep validating. */
  archive: archive.optional(),
  server: server.optional()
}).superRefine((manifest, ctx) => {
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (!safePackPath(file.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `Ruta insegura: ${file.path}` })
    const key = file.path.toLowerCase()
    if (paths.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `Ruta duplicada: ${file.path}` })
    paths.add(key)
    if (file.required && (file.userMutable || file.userDeletable)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `Un archivo oficial obligatorio no puede ser mutable ni eliminable: ${file.path}` })
  }
})

export type OrvianManifest = z.infer<typeof ManifestSchema>
export type PackFile = OrvianManifest['files'][number]

export type LocalFileState = { exists: boolean; currentHash?: string; lastOfficialHash?: string }
export type FileSyncDecision = 'install' | 'replace' | 'keep-user-config' | 'stage-new-default' | 'unchanged'

/**
 * Config overrides are seeded from the official pack on first install. Later
 * updates replace untouched defaults, but never overwrite a user's edits.
 * The incoming official version is staged separately for review/recovery.
 */
export function decideFileSync(file: PackFile, local: LocalFileState): FileSyncDecision {
  if (!local.exists) return 'install'
  if (local.currentHash?.toLowerCase() === file.sha256.toLowerCase()) return 'unchanged'
  if (file.userMutable || file.type === 'config') {
    // If no baseline is known (upgrade from older launcher), err on preserving
    // the existing file instead of assuming it is an untouched official file.
    if (!local.lastOfficialHash || local.currentHash?.toLowerCase() !== local.lastOfficialHash.toLowerCase()) {
      return local.lastOfficialHash?.toLowerCase() === file.sha256.toLowerCase() ? 'keep-user-config' : 'stage-new-default'
    }
  }
  return 'replace'
}

export function safePackPath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.includes('\0')) return false
  const segments = value.split('/')
  return segments.every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[<>:"|?*]/.test(part))
}

export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => version.split('-')[0].split('.').map((n) => Number(n))
  const left = parse(a); const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return Math.sign(delta)
  }
  if (a.includes('-') !== b.includes('-')) return a.includes('-') ? -1 : 1
  return 0
}
