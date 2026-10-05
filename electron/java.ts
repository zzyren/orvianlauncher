import { join } from 'node:path'
import { stat, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

const ADOPTIUM_URL = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk'

export async function ensureJava17(dataRoot: string, onProgress: (detail: string) => void): Promise<string> {
  const javaHome = join(dataRoot, 'runtime', 'java-17')
  const javaw = join(javaHome, 'bin', 'javaw.exe')

  const isJavaValid = await testJava(javaw)
  if (isJavaValid) {
    onProgress('Java 17 encontrado y verificado.')
    return javaw
  }

  onProgress('Descargando Java 17 (Eclipse Temurin JRE)...')
  await mkdir(join(dataRoot, 'runtime'), { recursive: true })
  const zipPath = join(dataRoot, 'runtime', 'java-17.zip')

  // Timeout de 120s para la descarga de Java (puede ser grande ~60 MB)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120_000)
  let res: Response
  try {
    res = await fetch(ADOPTIUM_URL, { redirect: 'follow', signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok || !res.body) throw new Error(`Fallo al descargar Java 17 (HTTP ${res.status}): ${res.statusText}`)
  
  const { Readable } = require('node:stream')
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zipPath))

  onProgress('Extrayendo Java 17...')
  await rm(javaHome, { recursive: true, force: true })
  
  const zip = await open(zipPath)
  const entries = await readAllEntries(zip)
  
  // Find the root directory name inside the zip (e.g. jdk-17.0.20.1+1-jre/)
  let rootFolder = ''
  for (const entry of entries) {
    const parts = entry.fileName.split('/')
    if (parts.length > 0 && parts[0]) {
      rootFolder = parts[0]
      break
    }
  }

  if (!rootFolder) throw new Error('El archivo ZIP de Java 17 tiene un formato inesperado.')

  let extractedCount = 0
  for (const entry of entries) {
    if (entry.fileName.endsWith('/')) continue
    const relPath = entry.fileName.substring(rootFolder.length + 1)
    if (!relPath) continue
    
    const targetPath = join(javaHome, ...relPath.split('/'))
    await mkdir(join(targetPath, '..'), { recursive: true })
    
    const content = await readEntry(zip, entry)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(targetPath, content)
    
    extractedCount++
    if (extractedCount % 100 === 0) onProgress(`Extrayendo Java 17... (${extractedCount} archivos)`)
  }

  await rm(zipPath, { force: true })
  
  const finalCheck = await testJava(javaw)
  if (!finalCheck) throw new Error('La instalación de Java 17 falló la verificación final.')
  
  onProgress('Java 17 instalado correctamente.')
  return javaw
}

async function testJava(javawPath: string): Promise<boolean> {
  try {
    const info = await stat(javawPath)
    if (!info.isFile()) return false
  } catch {
    return false
  }

  // Timeout de 10s para evitar que javaw.exe se quede colgado
  return new Promise((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        try { proc.kill() } catch {}
        resolve(false)
      }
    }, 10_000)

    const proc = spawn(javawPath, ['-version'])
    let output = ''
    proc.stderr?.on('data', (data) => { output += data.toString() })
    proc.stdout?.on('data', (data) => { output += data.toString() })
    
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0 && (output.includes('version "17') || output.includes('version \\"17'))) {
        resolve(true)
      } else {
        resolve(false)
      }
    })
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(false)
    })
  })
}
