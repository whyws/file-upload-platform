import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const port = Number(process.env.PORT || 3001)
const dataDir = resolve('server/data')
const chunksDir = join(dataDir, 'chunks')
const uploadsDir = join(dataDir, 'uploads')
const metadataDir = join(dataDir, 'metadata')
const distDir = resolve('dist')
await Promise.all([mkdir(chunksDir, { recursive: true }), mkdir(uploadsDir, { recursive: true }), mkdir(metadataDir, { recursive: true })])

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}

function safeId(value) {
  if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('文件标识不合法')
  return value
}

function safeName(value) {
  return basename(value || 'file').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function uploadedIndexes(fileId) {
  const folder = join(chunksDir, safeId(fileId))
  if (!existsSync(folder)) return []
  return (await readdir(folder)).filter((name) => /^\d+\.part$/.test(name)).map((name) => Number(name.replace('.part', ''))).sort((a, b) => a - b)
}

async function uploadStatus(fileId) {
  const id = safeId(fileId)
  const metadataPath = join(metadataDir, `${id}.json`)
  if (existsSync(metadataPath)) return { uploadedChunks: [], asset: JSON.parse(await readFile(metadataPath, 'utf8')) }
  return { uploadedChunks: await uploadedIndexes(id) }
}

async function uploadChunk(request, response, url) {
  const fileId = safeId(url.searchParams.get('fileId'))
  const chunkIndex = Number(url.searchParams.get('chunkIndex'))
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('分片序号不合法')
  const folder = join(chunksDir, fileId)
  await mkdir(folder, { recursive: true })
  const temporary = join(folder, `${chunkIndex}.uploading`)
  await pipeline(request, createWriteStream(temporary))
  await rename(temporary, join(folder, `${chunkIndex}.part`))
  json(response, 200, { chunkIndex })
}

async function mergeFile(request, response) {
  const { fileId: rawId, fileName: rawName, totalChunks, size, type } = await readJson(request)
  const fileId = safeId(rawId)
  const fileName = safeName(rawName)
  const indexes = await uploadedIndexes(fileId)
  if (indexes.length !== totalChunks) return json(response, 409, { error: '分片尚未全部上传', uploadedChunks: indexes })

  const storedName = `${fileId.slice(0, 12)}-${fileName}`
  const output = createWriteStream(join(uploadsDir, storedName))
  for (let index = 0; index < totalChunks; index += 1) {
    await pipeline(createReadStream(join(chunksDir, fileId, `${index}.part`)), output, { end: false })
  }
  output.end()
  await new Promise((resolvePromise, reject) => output.on('finish', resolvePromise).on('error', reject))

  const asset = { id: fileId, name: fileName, storedName, size, type, url: `/uploads/${encodeURIComponent(storedName)}`, createdAt: new Date().toISOString() }
  await writeFile(join(metadataDir, `${fileId}.json`), JSON.stringify(asset, null, 2))
  await rm(join(chunksDir, fileId), { recursive: true, force: true })
  json(response, 200, asset)
}

async function listAssets(response) {
  const files = (await readdir(metadataDir)).filter((name) => name.endsWith('.json'))
  const assets = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(metadataDir, name), 'utf8'))))
  assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  json(response, 200, assets)
}

async function deleteAsset(response, rawId) {
  const fileId = safeId(rawId)
  const metadataPath = join(metadataDir, `${fileId}.json`)
  if (!existsSync(metadataPath)) return json(response, 404, { error: '素材不存在' })
  const asset = JSON.parse(await readFile(metadataPath, 'utf8'))
  await rm(join(uploadsDir, safeName(asset.storedName)), { force: true })
  await rm(metadataPath, { force: true })
  json(response, 200, { id: fileId })
}

async function serveAsset(response, pathname) {
  const filePath = join(uploadsDir, safeName(decodeURIComponent(pathname.replace('/uploads/', ''))))
  const info = await stat(filePath)
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.pdf': 'application/pdf' }
  response.writeHead(200, { 'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size })
  createReadStream(filePath).pipe(response)
}

async function serveApp(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let filePath = resolve(distDir, relativePath)
  if (!filePath.startsWith(`${distDir}${sep}`) || !existsSync(filePath)) filePath = join(distDir, 'index.html')
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
  const info = await stat(filePath)
  response.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream', 'Content-Length': info.size })
  createReadStream(filePath).pipe(response)
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/api/uploads/status') return json(response, 200, await uploadStatus(url.searchParams.get('fileId')))
    if (request.method === 'POST' && url.pathname === '/api/uploads/chunk') return await uploadChunk(request, response, url)
    if (request.method === 'POST' && url.pathname === '/api/uploads/merge') return await mergeFile(request, response)
    if (request.method === 'GET' && url.pathname === '/api/assets') return await listAssets(response)
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/assets/')) return await deleteAsset(response, url.pathname.replace('/api/assets/', ''))
    if (request.method === 'GET' && url.pathname.startsWith('/uploads/')) return await serveAsset(response, url.pathname)
    if (request.method === 'GET' && existsSync(distDir)) return await serveApp(response, url.pathname)
    json(response, 404, { error: '接口不存在' })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : '服务器异常' })
  }
}).listen(port, () => console.log(`Upload API running at http://127.0.0.1:${port}`))
