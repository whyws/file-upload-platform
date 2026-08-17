// 前端请求层，负责和后端的所有通信
// 封装了 5 个 API 调用函数，每个函数对应一个后端接口
import type { Asset } from '../types'


// 泛型函数，<T>表示调用者可以指定返回类型  参数名 response，类型是 Response 对象
async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`)
  return data
}

// 查询某个文件的上传状态函数，用于断点续传。 返回值：uploadedChunks:已上传分片的数组  asset?: 如果文件已经上传完成，返回素材信息
export async function getUploadStatus(fileId: string): Promise<{ uploadedChunks: number[]; asset?: Asset }> {
                                                         //  把 fileId 中的特殊字符转义，防止破坏 URL
  return parseResponse(await fetch(`/api/uploads/status?fileId=${encodeURIComponent(fileId)}`))
}

// 上传分片函数
export async function uploadChunk(fileId: string, chunkIndex: number, chunk: Blob, signal: AbortSignal) {
  const response = await fetch(`/api/uploads/chunk?fileId=${encodeURIComponent(fileId)}&chunkIndex=${chunkIndex}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: chunk,
    signal,
  })
  return parseResponse<{ chunkIndex: number }>(response)
}

// 合并上传函数         payload：有效载荷，就是你要发给服务器的数据                totalChunks：总分片数   size：文件总大小
export async function mergeUpload(payload: { fileId: string; fileName: string; totalChunks: number; size: number; type: string }) {
  return parseResponse<Asset>(await fetch('/api/uploads/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

// 获取所有素材函数
export async function getAssets() {
  return parseResponse<Asset[]>(await fetch('/api/assets'))
}

// 删除素材函数
export async function deleteAsset(assetId: string) {
  return parseResponse<{ id: string }>(await fetch(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }))
}
