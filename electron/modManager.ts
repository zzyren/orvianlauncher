import { IpcMain } from 'electron'
import { join } from 'node:path'
import { readdir, stat, rm, readFile, writeFile, mkdir } from 'node:fs/promises'

type MetadataFile = Record<string, { dependencies: string[] }>

async function getCustomMetadata(instance: string): Promise<MetadataFile> {
  try {
    const p = join(instance, '.orvian', 'custom-mods.json')
    const c = await readFile(p, 'utf8')
    return JSON.parse(c)
  } catch {
    return {}
  }
}

async function saveCustomMetadata(instance: string, data: MetadataFile) {
  const p = join(instance, '.orvian')
  await mkdir(p, { recursive: true }).catch(() => {})
  await writeFile(join(p, 'custom-mods.json'), JSON.stringify(data, null, 2))
}

export function registerModsIpc(ipc: IpcMain, dataRoot: string) {
  const instance = join(dataRoot, 'instances', 'orvian')
  const modsDir = join(instance, 'mods')
  const statePath = join(instance, '.orvian', 'official-state.json')

  ipc.handle('mods:list', async () => {
    let officialFiles: Record<string, string> = {}
    try {
      const stateContent = await readFile(statePath, 'utf8')
      const state = JSON.parse(stateContent)
      officialFiles = state.files || {}
    } catch {}

    const officialSet = new Set<string>()
    for (const key of Object.keys(officialFiles)) {
      if (key.startsWith('mods/')) {
        officialSet.add(key.slice(5).toLowerCase()) // remove 'mods/'
      }
    }

    const customMeta = await getCustomMetadata(instance)
    const reverseMeta: Record<string, string[]> = {}
    
    for (const [mod, data] of Object.entries(customMeta)) {
      for (const dep of data.dependencies) {
        if (!reverseMeta[dep]) reverseMeta[dep] = []
        reverseMeta[dep].push(mod)
      }
    }

    const mods: Array<{ filename: string; isOfficial: boolean; size: number; dependencies: string[]; requiredBy: string[] }> = []
    try {
      const files = await readdir(modsDir)
      for (const file of files) {
        if (!file.endsWith('.jar')) continue
        const fileStat = await stat(join(modsDir, file)).catch(() => null)
        if (!fileStat || !fileStat.isFile()) continue
        
        const isOfficial = officialSet.has(file.toLowerCase())
        mods.push({ 
          filename: file, 
          isOfficial, 
          size: fileStat.size,
          dependencies: customMeta[file]?.dependencies || [],
          requiredBy: reverseMeta[file] || []
        })
      }
    } catch {}

    return mods
  })

  ipc.handle('mods:delete', async (_event, filename: string) => {
    if (!filename.endsWith('.jar') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('Nombre de archivo inválido.')
    }
    const filePath = join(modsDir, filename)
    await rm(filePath, { force: true }).catch(()=>{})

    const meta = await getCustomMetadata(instance)
    if (meta[filename]) {
      delete meta[filename]
      await saveCustomMetadata(instance, meta)
    }

    return { ok: true }
  })

  ipc.handle('mods:search-modrinth', async (_event, query: string) => {
    const facets = [
      ["categories:forge"],
      ["versions:1.20.1"]
    ]
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20`
    const res = await fetch(url, { headers: { 'User-Agent': 'OrvianLauncher/1.0' } })
    if (!res.ok) throw new Error('Fallo al buscar en Modrinth')
    return res.json()
  })

  async function installModrinthMod(projectId: string, installedDeps: string[], visited: Set<string>): Promise<string> {
    if (visited.has(projectId)) return ""
    visited.add(projectId)

    const url = `https://api.modrinth.com/v2/project/${projectId}/version?loaders=["forge"]&game_versions=["1.20.1"]`
    const res = await fetch(url, { headers: { 'User-Agent': 'OrvianLauncher/1.0' } })
    if (!res.ok) throw new Error(`Fallo al obtener versiones para el proyecto ${projectId}`)
    const versions = await res.json()
    if (!versions || versions.length === 0) throw new Error(`No hay versiones compatibles para el mod ${projectId}.`)
    
    const latest = versions[0]
    const primaryFile = latest.files.find((f: any) => f.primary) || latest.files[0]
    if (!primaryFile) throw new Error(`No se encontró el archivo de descarga para ${projectId}.`)
    
    const downloadUrl = primaryFile.url
    const filename = primaryFile.filename
    const targetPath = join(modsDir, filename)
    
    const fileExists = await stat(targetPath).then(() => true).catch(() => false)
    if (!fileExists) {
      await mkdir(modsDir, { recursive: true }).catch(() => {})
      const downloadRes = await fetch(downloadUrl)
      if (!downloadRes.ok) throw new Error(`Fallo al descargar ${filename}.`)
      const arrayBuffer = await downloadRes.arrayBuffer()
      await writeFile(targetPath, Buffer.from(arrayBuffer))
    }
    
    const deps = latest.dependencies || []
    for (const dep of deps) {
      if (dep.dependency_type === 'required' && dep.project_id) {
        try {
          const depFilename = await installModrinthMod(dep.project_id, installedDeps, visited)
          if (depFilename && !installedDeps.includes(depFilename)) {
            installedDeps.push(depFilename)
          }
        } catch (e) {
          console.error('Error instalando dependencia de Modrinth:', e)
        }
      }
    }
    return filename
  }

  ipc.handle('mods:install-modrinth', async (_event, projectId: string) => {
    const installedDeps: string[] = []
    const visited = new Set<string>()
    const filename = await installModrinthMod(projectId, installedDeps, visited)
    
    const meta = await getCustomMetadata(instance)
    meta[filename] = { dependencies: installedDeps }
    await saveCustomMetadata(instance, meta)

    return { ok: true, filename, dependencies: installedDeps }
  })

  ipc.handle('mods:search-curseforge', async (_event, query: string) => {
    const url = `https://api.curse.tools/v1/mods/search?gameId=432&classId=6&searchFilter=${encodeURIComponent(query)}&gameVersion=1.20.1&modLoaderType=1&pageSize=20`
    const res = await fetch(url, { headers: { 'User-Agent': 'OrvianLauncher/1.0', 'Accept': 'application/json' } })
    if (!res.ok) throw new Error('Fallo al buscar en CurseForge')
    const json = await res.json()
    const hits = (json.data || []).map((mod: any) => ({
      project_id: String(mod.id),
      title: mod.name,
      description: mod.summary || '',
      icon_url: mod.logo?.thumbnailUrl || mod.logo?.url || '',
      author: mod.authors?.[0]?.name || 'Autor desconocido',
      downloads: mod.downloadCount || 0
    }))
    return { hits }
  })

  async function installCurseForgeMod(modId: string | number, installedDeps: string[], visited: Set<string>): Promise<string> {
    const modIdStr = String(modId)
    if (visited.has(modIdStr)) return ""
    visited.add(modIdStr)

    const url = `https://api.curse.tools/v1/mods/${modId}/files?gameVersion=1.20.1&modLoaderType=1`
    const res = await fetch(url, { headers: { 'User-Agent': 'OrvianLauncher/1.0', 'Accept': 'application/json' } })
    if (!res.ok) throw new Error(`Fallo al obtener archivos de CurseForge para ${modId}`)
    const json = await res.json()
    const files = json.data || []
    if (!files || files.length === 0) throw new Error(`No hay versiones compatibles (Forge 1.20.1) en CurseForge para ${modId}.`)

    const file = files[0]
    const filename = file.fileName
    let downloadUrl = file.downloadUrl
    if (!downloadUrl && file.id) {
      downloadUrl = `https://edge.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${file.fileName}`
    }
    if (!downloadUrl) throw new Error(`No se encontró el enlace de descarga para ${modId}.`)

    const targetPath = join(modsDir, filename)
    
    const fileExists = await stat(targetPath).then(() => true).catch(() => false)
    if (!fileExists) {
      await mkdir(modsDir, { recursive: true }).catch(() => {})
      const downloadRes = await fetch(downloadUrl)
      if (!downloadRes.ok) throw new Error(`Fallo al descargar desde CurseForge (${downloadRes.status}).`)
      const arrayBuffer = await downloadRes.arrayBuffer()
      await writeFile(targetPath, Buffer.from(arrayBuffer))
    }

    const deps = file.dependencies || []
    for (const dep of deps) {
      if (dep.relationType === 3 && dep.modId) { 
        try {
          const depFilename = await installCurseForgeMod(dep.modId, installedDeps, visited)
          if (depFilename && !installedDeps.includes(depFilename)) {
            installedDeps.push(depFilename)
          }
        } catch (e) {
          console.error('Error instalando dependencia de CurseForge:', e)
        }
      }
    }

    return filename
  }

  ipc.handle('mods:install-curseforge', async (_event, modId: string | number) => {
    const installedDeps: string[] = []
    const visited = new Set<string>()
    const filename = await installCurseForgeMod(modId, installedDeps, visited)
    
    const meta = await getCustomMetadata(instance)
    meta[filename] = { dependencies: installedDeps }
    await saveCustomMetadata(instance, meta)

    return { ok: true, filename, dependencies: installedDeps }
  })
}
