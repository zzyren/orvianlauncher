import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import { createHash } from 'node:crypto'
import https from 'node:https'
import type { PackFile, OrvianManifest } from '../src/shared/manifest'

export type PublishProgressCallback = (step: string, progress?: number) => void

export function httpsRequest(
  urlStr: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer | Uint8Array
  }
): Promise<{ statusCode: number; statusMessage: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      (res) => {
        // Redirecciones 301, 302, 307, 308 (muy comunes en releases y assets de GitHub / AWS S3)
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = res.headers.location
          const nextHeaders = { ...options.headers }
          // Si el redirect sale a otro dominio (ej. S3), quitar auth
          if (new URL(redirectUrl).hostname !== url.hostname) {
            delete nextHeaders['Authorization']
            delete nextHeaders['authorization']
          }
          httpsRequest(redirectUrl, {
            method: options.method,
            headers: nextHeaders,
            body: options.body
          }).then(resolve, reject)
          return
        }

        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 200,
            statusMessage: res.statusMessage || '',
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Timeout de red al conectar con ${url.hostname}`))
    })
    req.setTimeout(30_000)

    req.on('error', (err) => reject(new Error(`Error de red con ${url.hostname}: ${err.message}`)))

    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

/**
 * Procesa un ZIP exportado desde Prism Launcher o Modrinth (.mrpack)
 * En Prism Launcher:
 *  - Puede contener 'instance.cfg' y 'mmc-pack.json'
 *  - Los archivos del juego están dentro de '.minecraft/' (ej. .minecraft/mods/, .minecraft/config/) o en la raíz
 */
export async function buildManifestFromPrismZip(
  zipBuffer: Buffer,
  version: string,
  changelog: string[],
  githubRepo: string, // e.g. "zzyren/orvianmodpack"
  onProgress?: PublishProgressCallback
): Promise<{ manifest: OrvianManifest; overrides: Array<{ path: string; buffer: Buffer }> }> {
  onProgress?.('Abriendo paquete ZIP de Prism Launcher...', 0.1)
  const zip = await open(zipBuffer)
  const entries = await readAllEntries(zip)

  // 1. Detectar estructura de carpetas (Prism suele meter todo dentro de .minecraft/ o en la raíz)
  const hasDotMinecraft = entries.some((e) => e.fileName.startsWith('.minecraft/') || e.fileName.includes('/.minecraft/'))
  const hasOverrides = entries.some((e) => e.fileName.startsWith('overrides/'))

  let prefix = ''
  if (hasDotMinecraft) {
    const dotMcEntry = entries.find((e) => e.fileName.endsWith('.minecraft/') || e.fileName.includes('/.minecraft/'))
    if (dotMcEntry) {
      const idx = dotMcEntry.fileName.indexOf('.minecraft/')
      prefix = dotMcEntry.fileName.slice(0, idx + '.minecraft/'.length)
    } else {
      prefix = '.minecraft/'
    }
  } else if (hasOverrides) {
    prefix = 'overrides/'
  }

  // 2. Extraer información de Minecraft y Forge si existe mmc-pack.json
  let mcVersion = '1.20.1'
  let forgeVersion = '47.4.23'

  const mmcPackEntry = entries.find((e) => e.fileName.endsWith('mmc-pack.json'))
  if (mmcPackEntry) {
    try {
      const content = await readEntry(zip, mmcPackEntry)
      const mmc = JSON.parse(content.toString('utf8'))
      const components = mmc.components as Array<{ cachedVersion?: string; version?: string; uid?: string }> | undefined
      if (components) {
        const mc = components.find((c) => c.uid === 'net.minecraft')
        if (mc) mcVersion = mc.version || mc.cachedVersion || mcVersion
        const forge = components.find((c) => c.uid === 'net.minecraftforge' || c.uid === 'forge')
        if (forge) forgeVersion = forge.version || forge.cachedVersion || forgeVersion
      }
    } catch {}
  }

  // 3. Procesar archivos del juego (mods, configs, resourcepacks, shaderpacks, etc.)
  onProgress?.('Analizando mods y configuraciones del ZIP...', 0.3)
  const manifestFiles: PackFile[] = []
  const overrides: Array<{ path: string; buffer: Buffer }> = []

  const ignoredPrefixes = [
    'logs/',
    'crash-reports/',
    'screenshots/',
    'saves/',
    'backups/',
    'webcache/',
    'webcache2/',
    '.bobby/',
    'modernfix/',
    'xaerowaypoints/',
    'xaeroworldmap/',
    'mods/.connector/'
  ]

  const ignoredPrefixesLower = ignoredPrefixes.map(p => p.toLowerCase())

  const ignoredFiles = [
    'instance.cfg',
    'mmc-pack.json',
    'modrinth.index.json',
    'patches/',
    'fabricloader.log',
    'hotbar.nbt',
    'usercache.json',
    'usernamecache.json',
    'servers.dat_old',
    'config/voicechat/category-volumes.properties',
    'config/voicechat/player-volumes.properties',
    'config/voicechat/username-cache.json'
  ]

  const gameEntries = entries.filter((e) => {
    if (e.fileName.endsWith('/')) return false
    // Normalizar ruta: si contiene .minecraft/ o minecraft/, tomar lo que va después
    let rel = e.fileName
    if (rel.includes('.minecraft/')) {
      rel = rel.slice(rel.indexOf('.minecraft/') + '.minecraft/'.length)
    } else if (rel.startsWith('minecraft/')) {
      rel = rel.slice('minecraft/'.length)
    } else if (prefix && rel.startsWith(prefix)) {
      rel = rel.slice(prefix.length)
    }

    if (!rel || rel.startsWith('/')) return false
    
    // Ignorar si rel contiene o empieza por alguna carpeta prohibida
    const relLower = rel.toLowerCase()
    if (relLower.startsWith('xaero/')) return false
    if (ignoredPrefixesLower.some((p) => relLower.startsWith(p) || relLower.includes('/' + p))) return false
    if (ignoredFiles.some((f) => rel === f || rel.endsWith('/' + f))) return false
    if (rel.includes('inventoryprofilesnext/') && !rel.includes('inventoryprofilesnext/integrationHints/')) return false
    
    // Solo permitir carpetas válidas del modpack
    const validRoots = ['mods/', 'config/', 'defaultconfigs/', 'shaderpacks/', 'resourcepacks/', 'options']
    if (!validRoots.some((vr) => rel.startsWith(vr) || rel === 'servers.dat')) return false

    return true
  })

  let count = 0
  for (const entry of gameEntries) {
    let rel = entry.fileName
    if (rel.includes('.minecraft/')) {
      rel = rel.slice(rel.indexOf('.minecraft/') + '.minecraft/'.length)
    } else if (rel.startsWith('minecraft/')) {
      rel = rel.slice('minecraft/'.length)
    } else if (prefix && rel.startsWith(prefix)) {
      rel = rel.slice(prefix.length)
    }
    const content = await readEntry(zip, entry)
    overrides.push({ path: rel, buffer: content })

    const hash = createHash('sha256').update(content).digest('hex')
    let type: PackFile['type'] = 'other'
    if (rel.startsWith('config/')) type = 'config'
    else if (rel.startsWith('mods/')) type = 'mod'
    else if (rel.startsWith('defaultconfigs/')) type = 'defaultconfig'
    else if (rel.startsWith('shaderpacks/')) type = 'shaderpack'
    else if (rel.startsWith('resourcepacks/')) type = 'resourcepack'

    const isUserSetting = rel.startsWith('options') || rel === 'servers.dat' || type === 'config'

    const tagName = version.startsWith('v') ? version : `v${version}`
    manifestFiles.push({
      path: rel,
      sha256: hash,
      size: content.length,
      url: `https://github.com/${githubRepo}/releases/download/${tagName}/modpack.zip`,
      type,
      required: !isUserSetting,
      userMutable: isUserSetting,
      userDeletable: false
    })

    count++
    if (count % 30 === 0) {
      onProgress?.(`Procesando archivos (${count}/${gameEntries.length})...`, 0.3 + (count / gameEntries.length) * 0.35)
    }
  }

  const manifest: OrvianManifest = {
    schemaVersion: 1,
    pack: {
      id: 'orvian',
      name: 'Orvian',
      version,
      minecraft: '1.20.1',
      loader: 'forge',
      forge: forgeVersion
    },
    runtime: {
      java: 17
    },
    minimumLauncher: '0.1.0',
    publishedAt: new Date().toISOString(),
    changelog: changelog.length > 0 ? changelog : [`Actualización Orvian Modpack ${version}`],
    files: manifestFiles
  }

  return { manifest, overrides }
}

export async function publishReleaseToGitHub(options: {
  token: string
  repo: string // e.g. "zzyren/orvianmodpack"
  version: string // e.g. "1.0.1" o "v0.1.6-alpha"
  changelog: string
  manifest: OrvianManifest
  zipBuffer?: Buffer
  onProgress?: PublishProgressCallback
}): Promise<{ releaseUrl: string }> {
  const { token, repo, version, changelog, manifest, zipBuffer, onProgress } = options
  const cleanToken = token.trim()
  const tagName = version.startsWith('v') ? version : `v${version}`

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cleanToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Orvian-Launcher-Admin',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  // 1. Crear o reutilizar la Release en GitHub
  onProgress?.('Conectando con GitHub...', 0.7)
  const releasePayload = Buffer.from(
    JSON.stringify({
      tag_name: tagName,
      name: `Orvian Modpack ${tagName}`,
      body: changelog || `Actualización ${tagName} de Orvian Modpack.`,
      draft: false,
      prerelease: false
    }),
    'utf8'
  )

  const createRes = await httpsRequest(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': String(releasePayload.length)
    },
    body: releasePayload
  })

  let releaseData: { id: number; upload_url: string; html_url: string; assets: Array<{ id: number; name: string }> }

  if (createRes.statusCode >= 200 && createRes.statusCode < 300) {
    releaseData = JSON.parse(createRes.body.toString('utf8'))
  } else if (createRes.statusCode === 422) {
    onProgress?.(`Actualizando versión ${tagName} existente en GitHub...`, 0.75)
    const getRes = await httpsRequest(`https://api.github.com/repos/${repo}/releases/tags/${tagName}`, {
      method: 'GET',
      headers
    })
    if (getRes.statusCode >= 400) {
      throw new Error(`Error accediendo a la release ${tagName}: ${getRes.body.toString('utf8')}`)
    }
    releaseData = JSON.parse(getRes.body.toString('utf8'))
  } else {
    let errMessage = createRes.body.toString('utf8')
    try {
      const parsed = JSON.parse(errMessage)
      if (parsed.message) errMessage = parsed.message
    } catch {}
    throw new Error(`GitHub API (HTTP ${createRes.statusCode}): ${errMessage}`)
  }

  // 2. Si ya existían assets con el mismo nombre en la release (ej. orvian-manifest.json o modpack.zip), eliminarlos primero
  if (Array.isArray(releaseData.assets)) {
    for (const asset of releaseData.assets) {
      if (asset.name === 'orvian-manifest.json' || asset.name === `Orvian-${tagName}.zip` || asset.name === 'modpack.zip') {
        onProgress?.(`Eliminando asset previo (${asset.name})...`)
        await httpsRequest(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
          method: 'DELETE',
          headers
        }).catch(() => {})
      }
    }
  }

  const uploadUrl = releaseData.upload_url.replace('{?name,label}', '')

  // 3. Subir orvian-manifest.json
  onProgress?.('Subiendo orvian-manifest.json a GitHub Release...', 0.85)
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  const uploadManifestRes = await httpsRequest(`${uploadUrl}?name=orvian-manifest.json`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': String(manifestBuf.length)
    },
    body: manifestBuf
  })

  if (uploadManifestRes.statusCode >= 400) {
    let err = uploadManifestRes.body.toString('utf8')
    try {
      const p = JSON.parse(err)
      if (p.message) err = p.message
    } catch {}
    throw new Error(`Error al subir orvian-manifest.json a la Release: ${err}`)
  }

  // 4. Subir el ZIP completo de Prism Launcher como modpack.zip
  if (zipBuffer) {
    onProgress?.('Subiendo modpack.zip a GitHub...', 0.92)
    const uploadZipRes = await httpsRequest(`${uploadUrl}?name=modpack.zip`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/zip',
        'Content-Length': String(zipBuffer.length)
      },
      body: zipBuffer
    })

    if (uploadZipRes.statusCode >= 400) {
      let err = uploadZipRes.body.toString('utf8')
      try {
        const p = JSON.parse(err)
        if (p.message) err = p.message
      } catch {}
      throw new Error(`Error al subir modpack.zip: ${err}`)
    }
  }

  onProgress?.('¡Publicación completada con éxito!', 1)
  return { releaseUrl: releaseData.html_url }
}
