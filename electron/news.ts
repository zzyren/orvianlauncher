import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NewsItem } from '../src/shared/launcher-state'
import type { OrvianManifest } from '../src/shared/manifest'
import { log } from './logger'
import { fetchJson } from './net'

/** "News" are the release notes of the modpack: from GitHub releases, remembered on disk. */

const MAX_ITEMS = 4
const MAX_LINES = 20
const MAX_LINE_LENGTH = 300

/** Release notes are Markdown written for GitHub; keep the words, drop the markup (shown as plain text). */
export function bodyToNotes(body: string | null | undefined): string[] {
  if (!body) return []
  const lines: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw
      .replace(/<[^>]*>/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) lines.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line)
    if (lines.length >= MAX_LINES) break
  }
  return lines
}

interface GithubRelease {
  tag_name?: string
  draft?: boolean
  published_at?: string | null
  body?: string | null
}

export interface NewsServiceOptions {
  dataRoot: string
  repo: string
  ttlMs?: number
  now?: () => number
}

interface NewsCache {
  fetchedAt: number
  items: NewsItem[]
}

export class NewsService {
  private readonly cacheFile: string
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly options: NewsServiceOptions) {
    this.cacheFile = join(options.dataRoot, 'launcher', 'news.json')
    this.ttlMs = options.ttlMs ?? 30 * 60_000
    this.now = options.now ?? Date.now
  }

  /** Fresh from GitHub when due, otherwise the saved copy, and finally the current manifest's changelog. */
  async get(options: { force?: boolean; manifest?: OrvianManifest | null } = {}): Promise<NewsItem[]> {
    const cache = await this.readCache()
    if (cache && !options.force && this.now() - cache.fetchedAt < this.ttlMs) return cache.items

    try {
      const releases = await fetchJson<GithubRelease[]>(`https://api.github.com/repos/${this.options.repo}/releases?per_page=${MAX_ITEMS}`, { timeoutMs: 10_000 })
      const items = releases
        .filter((r) => !r.draft && typeof r.tag_name === 'string')
        .slice(0, MAX_ITEMS)
        .map((r): NewsItem => ({ version: (r.tag_name as string).replace(/^v/, ''), publishedAt: r.published_at ?? undefined, notes: bodyToNotes(r.body) }))
      if (items.length > 0) {
        await mkdir(dirname(this.cacheFile), { recursive: true })
        await writeFile(this.cacheFile, JSON.stringify({ fetchedAt: this.now(), items } satisfies NewsCache)).catch(() => undefined)
        return items
      }
    } catch (err) {
      log.info('[Noticias] No se pudieron obtener las novedades: %s', err instanceof Error ? err.message : String(err))
    }

    if (cache) return cache.items
    const manifest = options.manifest
    return manifest ? [{ version: manifest.pack.version, publishedAt: manifest.publishedAt, notes: manifest.changelog.flatMap((l) => bodyToNotes(l)) }] : []
  }

  private async readCache(): Promise<NewsCache | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as NewsCache
      return typeof parsed.fetchedAt === 'number' && Array.isArray(parsed.items) ? parsed : null
    } catch {
      return null
    }
  }
}
