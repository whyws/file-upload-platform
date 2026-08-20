//createReadStream创建可读流，createWriteStream创建可写流，existsSync检查文件是否存在
import { createReadStream, createWriteStream, existsSync } from 'node:fs' //读写文件、检查文件是否存在
//mkdir创建目录，readdir读取目录，readFile读取文件，rename重命名文件，rm删除文件，stat获取文件信息，writeFile写入文件
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises' //同上，异步文件操作,await
//createServer创建 Web 服务器.
import { createServer } from 'node:http' //	创建 Web 服务器
//basename从路径中获取文件名，extname获取文件扩展名，join拼接路径，resolve解析路径，sep获取路径分隔符
import { basename, extname, join, resolve, sep } from 'node:path' //处理文件路径
//pipeline流式处理数据，边读边写
import { pipeline } from 'node:stream/promises' //流式处理数据，边读边写

//配置常量,确定服务器监听哪个端口。
const port = Number(process.env.PORT || 3001)
// 数据存储目录
const dataDir = resolve('server/data') //	所有数据的根目录
const chunksDir = join(dataDir, 'chunks') //分片存储目录,临时
const uploadsDir = join(dataDir, 'uploads') //上传文件存储目录,合并后的完整文件
const metadataDir = join(dataDir, 'metadata') //元数据(描述数据的数据)存储目录,每个文件的信息
const distDir = resolve('dist') //前端页面打包后的文件
// 确保数据存储目录存在，如果不存在就创建。 recursive: true 表示递归创建目录，如果上级目录不存在也会创建。
await Promise.all([mkdir(chunksDir, { recursive: true }), mkdir(uploadsDir, { recursive: true }), mkdir(metadataDir, { recursive: true })])

//工具函数
// JSON 响应,当客户端（浏览器）请求时，用统一的格式回复 JSON 数据。
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })//.writeHead()方法用于设置响应头，status表示HTTP状态码，Content-Type表示响应内容类型为JSON格式
  response.end(JSON.stringify(data))//.end()方法用于结束响应并发送数据给客户端
}

// 检查文件 ID 是不是 64 位的十六进制字符串（SHA256 的特征）,如果不是就抛出错误。
function safeId(value) {
  if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('文件标识不合法')
  return value
}

//检查文件名是否合法，把文件名中的特殊字符替换成下划线
function safeName(value) {
  return basename(value || 'file').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
}

//从 HTTP 请求中读取请求体中的 JSON 数据,把请求体中的数据读取出来，并解析 JSON 为JS对象。
async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

//查已上传的分片,获取已上传的分片索引,返回一个数组，表示已经上传的分片索引。
async function uploadedIndexes(fileId) {
  const folder = join(chunksDir, safeId(fileId))
  if (!existsSync(folder)) return []
  //只保留以数字开头、以 .part结尾的文件。0.part、1.part会保留，.uploading临时文件会被过滤掉。
  return (await readdir(folder)).filter((name) => /^\d+\.part$/.test(name)).map((name) => Number(name.replace('.part', ''))).sort((a, b) => a - b)
}

//核心业务函数（七个接口）
//获取上传状态,返回一个对象，包含已上传的分片索引和文件的元数据（如果已经合并完成）。
async function uploadStatus(fileId) {
  const id = safeId(fileId)
  const metadataPath = join(metadataDir, `${id}.json`) 
  //如果元数据文件存在，说明文件已经合并完成，返回空的 uploadedChunks 数组和解析后的 asset 对象；否则，返回已上传的分片索引数组。
  if (existsSync(metadataPath)) return { uploadedChunks: [], asset: JSON.parse(await readFile(metadataPath, 'utf8')) }
  return { uploadedChunks: await uploadedIndexes(id) }
}

//删除分片，后端递归删除对应的临时分片目录。
async function deleteUpload(response, rawId) {
  const fileId = safeId(rawId)
  // recursive: true：递归删除目录及其所有内容。force: true：目录不存在，不报错。maxRetries: 5：删除失败时最多重试 5 次。
  // 解决文件被暂时占用导致的删除失败.retryDelay: 100：每次重试间隔 100 毫秒
  await rm(join(chunksDir, fileId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  json(response, 200, { id: fileId })
}

//上传分片,把客户端上传的分片数据保存到服务器的临时目录中。
async function uploadChunk(request, response, url) {
  const fileId = safeId(url.searchParams.get('fileId'))
  const chunkIndex = Number(url.searchParams.get('chunkIndex'))
  //检查分片序号是否合法，如果不是整数或者小于 0，就抛出错误。
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('分片序号不合法')
    //创建分片存储目录，如果目录不存在就创建。然后把请求体中的数据写入到一个临时文件中，最后重命名为正式的分片文件。
  const folder = join(chunksDir, fileId)
  await mkdir(folder, { recursive: true })
  //创建一个临时文件名，防止在写入过程中被其他请求读取到不完整的文件。
  const temporary = join(folder, `${chunkIndex}.uploading`)
  //使用 pipeline 方法把请求体中的数据流写入到临时文件中，等写入完成后再重命名为正式的分片文件。
  await pipeline(request, createWriteStream(temporary))
  await rename(temporary, join(folder, `${chunkIndex}.part`))
  //返回 JSON 响应，表示分片上传成功，并返回分片索引。
  json(response, 200, { chunkIndex })
}

//合并分片,把所有已上传的分片按照顺序合并成一个完整的文件，并保存到上传目录中，同时生成文件的元数据。
async function mergeFile(request, response) {
  //从请求体中读取 JSON 数据，获取文件 ID、文件名、总分片数、文件大小和文件类型。解构赋值的同时，使用 safeId 和 safeName 函数对文件 ID 和文件名进行安全检查和处理。
  const { fileId: rawId, fileName: rawName, totalChunks, size, type } = await readJson(request)
  const fileId = safeId(rawId)
  const fileName = safeName(rawName)
  //检查已上传的分片数量是否等于总分片数，如果不相等就返回 409 冲突错误，并返回已上传的分片索引。
  const indexes = await uploadedIndexes(fileId)
  if (indexes.length !== totalChunks) return json(response, 409, { error: '分片尚未全部上传', uploadedChunks: indexes })

  //创建一个可写流，把所有分片按照顺序写入到一个完整的文件中。文件名由文件 ID 的前 12 个字符和原始文件名组成，保证唯一性和可读性。
  const storedName = `${fileId.slice(0, 12)}-${fileName}`
  const output = createWriteStream(join(uploadsDir, storedName))
  for (let index = 0; index < totalChunks; index += 1) {
    //createReadStream 创建一个可读流，从指定的分片文件中读取数据，然后通过 pipeline 方法把数据流写入到输出流中。{ end: false } 表示在写入完成后不要关闭输出流，以便继续写入下一个分片。
    await pipeline(createReadStream(join(chunksDir, fileId, `${index}.part`)), output, { end: false })
  }
  //output.end()结束输出流。
  output.end()
  //等待输出流完全写入磁盘;output.on('finish', resolvePromise)：写入完成时 resolve;output.on('error', reject)：出错时 reject
  await new Promise((resolvePromise, reject) => output.on('finish', resolvePromise).on('error', reject))

  //创建一个 asset 对象:文件 ID、原始文件名、存储文件名、大小、类型、URL(encodeURIComponent进行URL编码)和创建时间。
  const asset = { id: fileId, name: fileName, storedName, size, type, url: `/uploads/${encodeURIComponent(storedName)}`, createdAt: new Date().toISOString() }
  //把 asset 对象写入到元数据目录中，文件名为文件 ID 的 JSON 文件。然后删除分片存储目录，释放磁盘空间。最后返回 JSON 响应，表示合并成功，并返回 asset 对象。
  await writeFile(join(metadataDir, `${fileId}.json`), JSON.stringify(asset, null, 2))
  await rm(join(chunksDir, fileId), { recursive: true, force: true })
  json(response, 200, asset)
}

//获取素材列表,返回一个数组，包含所有已上传的素材的元数据，并按创建时间降序排序。
async function listAssets(response) {
  //读取元数据目录中的所有 JSON 文件，过滤出以 .json 结尾的文件名，然后使用 Promise.all 并行读取每个 JSON 文件的内容，并解析为 JavaScript 对象。最后对资产数组按创建时间降序排序，并返回 JSON 响应。
  const files = (await readdir(metadataDir)).filter((name) => name.endsWith('.json'))
  const assets = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(metadataDir, name), 'utf8'))))
  assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  json(response, 200, assets)
}

//删除素材,删除指定的素材文件和元数据文件，如果素材不存在则返回 404 错误。
async function deleteAsset(response, rawId) {
  const fileId = safeId(rawId)
  const metadataPath = join(metadataDir, `${fileId}.json`)
  if (!existsSync(metadataPath)) return json(response, 404, { error: '素材不存在' })
    //读取元数据文件，获取存储文件名，然后删除上传目录中的文件和元数据文件。最后返回 JSON 响应，表示删除成功，并返回素材 ID。rm的force: true选项表示即使文件不存在也不会报错。
  const asset = JSON.parse(await readFile(metadataPath, 'utf8'))
  await rm(join(uploadsDir, safeName(asset.storedName)), { force: true })
  await rm(metadataPath, { force: true })
  json(response, 200, { id: fileId })
}

//服务静态资源,根据请求的路径返回对应的文件内容，并设置正确的 Content-Type 和 Content-Length 响应头。
async function serveAsset(response, pathname) {
  //pathname是请求的路径，从请求路径中获取文件名:pathname.replace('/uploads/', '')去掉路径前缀/uploads/
  const filePath = join(uploadsDir, safeName(decodeURIComponent(pathname.replace('/uploads/', ''))))
  //info是文件信息对象。types定义 MIME 类型映射表。response.writeHead()设置响应头，告诉浏览器文件类型和大小。createReadStream()创建一个可读流，从文件中读取数据，并通过管道传输到响应对象中，返回给客户端。
  const info = await stat(filePath)
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.pdf': 'application/pdf' }
  response.writeHead(200, { 'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size })
  createReadStream(filePath).pipe(response)
}

//服务前端页面,根据请求的路径返回对应的 HTML、JS 或 CSS 文件，如果文件不存在则返回 index.html。
async function serveApp(response, pathname) {
  //根据请求路径计算相对路径，如果请求的是根路径 /，则返回 index.html，否则去掉路径前缀的斜杠。
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  //resolve()方法将相对路径解析为绝对路径，确保文件路径在 distDir 目录下。
  let filePath = resolve(distDir, relativePath)
  //startsWith()方法检查 filePath 是否以 distDir 开头。如果不满足条件，就把 filePath 设置为 distDir 下的 index.html。
  if (!filePath.startsWith(`${distDir}${sep}`) || !existsSync(filePath)) filePath = join(distDir, 'index.html')
  //types定义 MIME 类型映射表，stat()方法获取文件信息，writeHead()方法设置响应头，createReadStream()方法创建可读流，并通过管道传输到响应对象中，返回给客户端。
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
  const info = await stat(filePath)
  response.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream', 'Content-Length': info.size })
  createReadStream(filePath).pipe(response)
}

//创建 HTTP 服务器,根据请求的路径和方法调用不同的处理函数，并返回相应的 JSON 数据或文件内容。
createServer(async (request, response) => {
  try {
    //根据请求的 URL 和方法判断要调用的处理函数。request.method 表示请求的方法，url.pathname 表示请求的路径，url.searchParams.get() 方法可以获取查询参数的值。
    //new URL()方法将请求的 URL 解析为一个 URL 对象。request.url 是请求的路径和查询字符串，request.headers.host 是请求的主机名和端口号。
    const url = new URL(request.url || '/', `http://${request.headers.host}`)
    //查询上传状态:GET /api/uploads/status?fileId=xxx
    if (request.method === 'GET' && url.pathname === '/api/uploads/status') return json(response, 200, await uploadStatus(url.searchParams.get('fileId')))
    //上传分片：POST /api/uploads/chunk?fileId=xxx&chunkIndex=0
    if (request.method === 'POST' && url.pathname === '/api/uploads/chunk') return await uploadChunk(request, response, url)
    //合并分片：POST /api/uploads/merge
    if (request.method === 'POST' && url.pathname === '/api/uploads/merge') return await mergeFile(request, response)
    //清理分片：DELETE /api/uploads/
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/uploads/')) return await deleteUpload(response, url.pathname.replace('/api/uploads/', ''))
    //素材列表：GET /api/assets
    if (request.method === 'GET' && url.pathname === '/api/assets') return await listAssets(response)
    //删除素材：DELETE /api/assets/:id
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/assets/')) return await deleteAsset(response, url.pathname.replace('/api/assets/', ''))
    //访问文件：GET /uploads/*
    if (request.method === 'GET' && url.pathname.startsWith('/uploads/')) return await serveAsset(response, url.pathname)
    //前端页面：GET /*
    if (request.method === 'GET' && existsSync(distDir)) return await serveApp(response, url.pathname)
    //未知路径返回 404
    json(response, 404, { error: '接口不存在' })
  } catch (error) {
    //发生错误时返回 500 状态码和错误信息
    json(response, 500, { error: error instanceof Error ? error.message : '服务器异常' })
  }
}).listen(port, () => console.log(`Upload API running at http://127.0.0.1:${port}`))
