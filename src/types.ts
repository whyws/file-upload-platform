//类型定义
//type定义联合对象
export type UploadStatus = 'waiting' | 'uploading' | 'paused' | 'merging' | 'completed' | 'error'

// waiting	文件已选择，但还没开始上传	用户选择文件后立即设置
// uploading	正在上传分片中	用户点击"开始"，或者从 paused恢复时
// paused	用户主动暂停	用户点击"暂停"按钮
// merging	所有分片上传完毕，正在等待服务端合并	最后一个分片上传成功后
// completed	文件合并完成，可以在素材列表中看到	合并接口返回成功
// error	上传过程中出现不可恢复的错误	重试次数用尽后

// interface定义接口

// 上传任务(一个正在上传或等待上传的文件)
export interface UploadTask {
  file: File               //上传的文件对象
  fileId: string           //文件的唯一标识
  chunkSize: number        //分片大小，单位字节
  totalChunks: number      //文件被切成的总分片数
  uploadedChunks: number[] //已上传的分片索引数组
  status: UploadStatus    //任务当前状态
  error: string           //错误信息
}

// 素材，代表“已经上传完成的文件”
export interface Asset {
  id: string              //素材的唯一标识
  name: string            //用户上传的原始文件名
  storedName: string      //服务端实际存储的文件名
  size: number            //文件大小，单位字节
  type: string            //文件类型  MIME 
  url: string             //文件访问URL
  createdAt: string       //创建时间
}
