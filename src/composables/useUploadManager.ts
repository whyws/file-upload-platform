// 上传调度器
import { useUploadStore } from '../stores/upload'
import { deleteAsset as requestDeleteAsset, deleteUpload, getAssets, getUploadStatus, mergeUpload, uploadChunk } from '../services/uploadApi'
import type { UploadTask } from '../types'

// 分片大小，单位字节
const CHUNK_SIZE = 5 * 1024 * 1024
// 并发上传的分片数
const CONCURRENCY = 3
// 最大重试次数
const MAX_RETRIES = 2

//键是文件 id，值是该任务所有正在进行的请求的 AbortController 集合。
const controllers = new Map<string, Set<AbortController>>()
// 记录当前正在运行的文件 id 集合，防止重复启动同一个任务。
const activeRuns = new Set<string>()

// 根据文件的元信息（名字、大小、最后修改时间）生成一个唯一的字符串标识。
async function createFileId(file: File) {
  const source = new TextEncoder().encode(`${file.name}:${file.size}:${file.lastModified}`)
  // 浏览器提供的加密哈希函数,'SHA-256':使用的哈希算法，输出 256 位的哈希值
  const digest = await crypto.subtle.digest('SHA-256', source) //digest是一个 ArrayBuffer（二进制缓冲区）
  // Array.from把伪数组变真数组  Uint8Array把digest包装成可操作的字节数组  把字节（0-255 的数字）转成十六进制字符串,补成两位
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// 上传管理函数
export function useUploadManager() {
  const store = useUploadStore()

  // 接收用户选择的文件列表，为每个文件创建上传任务并添加到 Store。
  async function addFiles(files: File[]) {
    for (const file of files) {
      const fileId = await createFileId(file)
      // 创建一个符合 UploadTask接口的对象，添加到 Store。
      store.addTask({
        file,
        fileId,
        chunkSize: CHUNK_SIZE,
        totalChunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
        uploadedChunks: [],
        status: 'waiting',
        error: '',
      })
    }
  }

  // 上传单个分片，包含重试逻辑。              task：要上传哪个文件的任务   chunkIndex：上传第几个分片（从 0 开始）
  async function uploadOne(task: UploadTask, chunkIndex: number) {
    // 重试逻辑：如果上传失败，最多重试 MAX_RETRIES 次，每次重试前等待一段时间（500ms * 尝试次数）。
    let attempt = 0
    while (attempt <= MAX_RETRIES) {
      // 创建一个新的 AbortController，用于取消当前分片的上传请求。
      const controller = new AbortController()
      // 获取当前任务的所有 AbortController 集合，如果没有则创建一个新的 Set。
      const taskControllers = controllers.get(task.fileId) || new Set<AbortController>()
      // 将当前的 AbortController 添加到集合中，并更新 controllers Map。
      taskControllers.add(controller)
      //把更新后的 Set 存回 Map 中.
      controllers.set(task.fileId, taskControllers)
      // 调用 uploadChunk 上传分片，传入文件 ID、分片索引、分片数据和取消信号。
      try {
        // 计算当前分片在文件中的起始位置。
        const start = chunkIndex * task.chunkSize
        await uploadChunk(task.fileId, chunkIndex, task.file.slice(start, Math.min(start + task.chunkSize, task.file.size)), controller.signal)
        //如果这个分片索引还没有记录在已上传列表中，就添加进去
        if (!task.uploadedChunks.includes(chunkIndex)) task.uploadedChunks.push(chunkIndex)
        return
      } catch (error) {
        if (controller.signal.aborted) throw error
        attempt += 1
        if (attempt > MAX_RETRIES) throw error
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
      } finally {
        taskControllers.delete(controller)
      }
    }
  }

  // 负责启动一个上传任务的完整流程
  async function startTask(task: UploadTask) {
    if (activeRuns.has(task.fileId) || task.status === 'completed') return
    activeRuns.add(task.fileId)
    task.status = 'uploading'
    task.error = ''
    // 定义一个函数，用于检查任务是否被暂停。
    const isPaused = () => task.status === 'paused' //真表示任务被暂停，假表示任务没有被暂停
    try {
      // 调用 API 查询服务端已经有哪些分片上传成功了，返回值是一个对象，包含已上传分片索引数组和可选的素材信息。
      const status = await getUploadStatus(task.fileId)
      // 如果返回 asset字段，说明这个文件已经合并完成了，不需要上传，直接标记为完成。
      if (status.asset) {
        task.status = 'completed'
        await refreshAssets()
        return
      }
      // 把服务端返回的已上传分片列表赋值给任务。
      task.uploadedChunks = status.uploadedChunks
      // 创建一个数组，包含从 0 到 totalChunks - 1的所有索引,然后过滤掉已经上传的分片索引，得到需要上传的分片队列。
      const queue = Array.from({ length: task.totalChunks }, (_, index) => index).filter((index) => !task.uploadedChunks.includes(index))

      // 多个 worker 共享一个队列，每次 shift 一个分片，并发数限制为 CONCURRENCY。
      // 定义一个异步函数 worker，循环从队列中取出分片索引并上传，直到队列为空或任务被暂停。
      const worker = async () => {
        while (queue.length && task.status === 'uploading') {
          const chunkIndex = queue.shift()
          if (chunkIndex !== undefined) await uploadOne(task, chunkIndex)
        }
      }
      // 创建多个 worker 并发执行，直到所有分片上传完成或任务被暂停。
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
      // 如果任务被暂停了，就直接返回，不继续合并。
      if (isPaused()) return

      // 所有分片上传完成后，调用 mergeUpload 合并分片，传入文件 ID、文件名、总分片数、文件大小和文件类型。
      task.status = 'merging'
      await mergeUpload({ fileId: task.fileId, fileName: task.file.name, totalChunks: task.totalChunks, size: task.file.size, type: task.file.type })
      task.status = 'completed'
      await refreshAssets()
    } catch (error) {
      // 如果任务没有被暂停，就标记为错误状态，并记录错误信息。
      if (!isPaused()) {
        task.status = 'error'
        task.error = error instanceof Error ? error.message : '上传失败'
      }
    } finally {
      //清理运行标记和控制器集合。
      activeRuns.delete(task.fileId)
      controllers.delete(task.fileId)
    }
  }

  // 暂停一个上传任务，设置状态为 paused，并取消所有正在进行的请求。
  function pauseTask(task: UploadTask) {
    task.status = 'paused'
    controllers.get(task.fileId)?.forEach((controller) => controller.abort())
  }

  // 删除一个上传任务，先暂停它，await 等待后端清理完成，再继续往下执行，然后从 Store 中移除。
  async function removeTask(task: UploadTask) {
    pauseTask(task)
    await deleteUpload(task.fileId)
    store.removeTask(task.fileId)
  }

  // 启动所有等待或暂停的任务，返回一个 Promise，等待所有任务完成。
  async function startAll() {
    // 过滤出状态为 waiting、paused 或 error 的任务，并调用 startTask 启动它们，使用 Promise.all 等待所有任务完成。
    await Promise.all(store.tasks.filter((task) => ['waiting', 'paused', 'error'].includes(task.status)).map(startTask))
  }

  // 刷新素材列表，从服务端获取最新的素材数据，并更新 Store。
  async function refreshAssets() {
    store.assets = await getAssets()
  }

  // 删除素材，先调用 API 删除素材，然后从 Store 中移除。
  async function deleteAsset(assetId: string) {
    await requestDeleteAsset(assetId)
    store.assets = store.assets.filter((asset) => asset.id !== assetId)
  }

  return { addFiles, startTask, pauseTask, removeTask, startAll, refreshAssets, deleteAsset }
}
