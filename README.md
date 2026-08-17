# Upload Studio - 大文件分片上传与素材管理平台

一个基于 Vue 3、TypeScript、Pinia 和 Node.js 的大文件上传项目。项目聚焦文件分片、并发控制、断点续传、暂停恢复与失败重试，不包含登录、权限、文件夹等非核心业务，适合作为前端校招项目学习和讲解。

## 1. 功能范围

- 点击选择或拖拽添加多个文件
- 按 5 MB 将文件切分为多个 Blob
- 每个文件最多同时上传 3 个分片
- 暂停时取消正在进行的网络请求
- 恢复时查询服务端已有分片，只上传缺失部分
- 单个分片失败后自动重试 2 次
- 所有分片完成后通知服务端按顺序合并
- 展示任务状态、分片数量、上传进度和已完成素材
- 删除不再需要的素材及其服务端文件

## 2. 技术栈

- Vue 3 Composition API：页面组件与响应式状态
- TypeScript：约束任务状态、素材数据和接口参数
- Pinia：管理上传任务和素材列表
- Fetch + AbortController：上传二进制分片并取消请求
- Blob.slice：在浏览器中创建文件分片
- Web Crypto：根据文件元信息生成 SHA-256 文件标识
- Node.js HTTP/Stream：接收分片并按顺序合并文件
- Vite：开发服务器、接口代理与生产构建

## 3. 项目结构

```text
file-upload-platform/
├─ server/
│  └─ index.js                 # 上传接口、分片存储、文件合并、静态素材访问
├─ src/
│  ├─ composables/
│  │  └─ useUploadManager.ts   # 并发队列、暂停、恢复、重试等核心调度逻辑
│  ├─ services/
│  │  └─ uploadApi.ts          # 前端请求层
│  ├─ stores/
│  │  └─ upload.ts             # Pinia任务和素材状态
│  ├─ App.vue                  # 页面与用户交互
│  ├─ types.ts                 # TypeScript类型
│  ├─ styles.css               # PC和移动端样式
│  └─ main.ts                  # 应用入口
├─ vite.config.ts              # Vite代理配置
└─ package.json
```

运行后，服务端会自动创建以下目录：

```text
server/data/
├─ chunks/<fileId>/            # 尚未合并的分片
├─ uploads/                    # 合并后的完整文件
└─ metadata/                   # 素材元信息
```

这些运行数据已经加入 `.gitignore`。

## 4. 启动项目

要求 Node.js 20.19 或更高版本。

```bash
npm install
npm run dev
```

一个命令会同时启动：

- 前端：http://localhost:5180
- 上传接口：http://127.0.0.1:3001

生产构建：

```bash
npm run build
npm start
```

生产页面和接口均由 http://127.0.0.1:3001 提供。

## 5. 上传流程

```text
用户选择文件
  -> 根据 name + size + lastModified 生成 SHA-256 文件标识
  -> 计算总分片数
  -> 查询服务端已存在的分片
  -> 过滤出缺失分片
  -> 3 个 worker 共享分片队列
  -> 每个 worker 逐个上传分片
  -> 失败分片最多重试 2 次
  -> 全部分片上传完成
  -> 请求服务端合并
  -> 刷新素材列表
```

## 6. 核心实现

### 6.1 文件分片

`File` 继承自 `Blob`，可以通过 `slice(start, end)` 得到指定范围的 Blob：

```ts
const start = chunkIndex * chunkSize
const chunk = file.slice(start, Math.min(start + chunkSize, file.size))
```

`slice` 通常只创建对原始文件数据的范围引用，不需要提前把整个文件读进 JavaScript 内存。因此它比先调用 `file.arrayBuffer()` 再手动切割更适合大文件。

### 6.2 并发控制

项目没有对所有分片直接使用 `Promise.all`，因为这会瞬间发出大量请求。实现中创建最多 3 个 worker，让它们共享同一个数组队列：

```ts
const worker = async () => {
  while (queue.length && task.status === 'uploading') {
    const chunkIndex = queue.shift()
    if (chunkIndex !== undefined) await uploadOne(task, chunkIndex)
  }
}

await Promise.all(Array.from({ length: 3 }, worker))
```

JavaScript在执行 `queue.shift()` 时不会被其他同步代码插入，因此同一个分片不会被两个 worker 重复取走。并发数过低无法充分利用网络，并发数过高会增加浏览器连接、服务端文件句柄和网络拥塞压力，3 是本项目的保守默认值。

### 6.3 暂停与恢复

每次分片上传都会创建一个 `AbortController`。任务暂停时，将任务状态改为 `paused`，并取消该任务所有正在进行的请求：

```ts
controllers.get(task.id)?.forEach((controller) => controller.abort())
```

已经完成的分片保留在服务端。恢复时先调用状态接口获得 `uploadedChunks`，再过滤队列：

```ts
const queue = allChunks.filter((index) => !uploadedChunks.includes(index))
```

因此恢复上传不会重复传输已完成分片，这就是本项目的断点续传。

### 6.4 失败重试

单个分片采用循环重试，并使用递增等待时间：第一次等待 500 ms，第二次等待 1000 ms。主动暂停产生的 AbortError不会重试，否则用户点击暂停后请求会再次启动。

### 6.5 文件标识

项目对 `文件名 + 文件大小 + 最后修改时间` 计算 SHA-256，将结果作为分片目录和任务 ID。这样无需读取整个文件，添加大文件时响应较快。

需要注意：它是“元信息指纹”，并不能严格证明两个文件内容相同。生产系统的秒传应在 Web Worker 中增量读取文件内容并计算完整文件 Hash。

### 6.6 服务端流式写入

上传接口不会把整个分片缓存进内存，而是使用 Node Stream直接写入临时文件：

```js
await pipeline(request, createWriteStream(temporary))
await rename(temporary, finalChunkPath)
```

先写 `.uploading` 临时文件，完整写入后再重命名为 `.part`，避免网络中断留下的残缺文件被状态接口误认为上传成功。

### 6.7 分片合并

服务端确认分片数量完整后，严格按照 `0.part`、`1.part` 的顺序写入同一个输出流。合并成功后保存素材元信息并删除临时分片目录。

## 7. 接口说明

### 查询上传状态

```http
GET /api/uploads/status?fileId=<sha256>
```

返回已上传分片序号；如果文件已经合并，同时返回 `asset`。

### 上传分片

```http
POST /api/uploads/chunk?fileId=<sha256>&chunkIndex=0
Content-Type: application/octet-stream

<binary>
```

### 合并文件

```http
POST /api/uploads/merge
Content-Type: application/json

{
  "fileId": "...",
  "fileName": "demo.mp4",
  "totalChunks": 20,
  "size": 104857600,
  "type": "video/mp4"
}
```

### 素材列表

```http
GET /api/assets
```

### 删除素材

```http
DELETE /api/assets/:fileId
```

删除成功后，服务端会同时移除完整文件和素材元信息。该操作不可撤销。

## 8. 状态设计

每个任务只会处于以下一种状态：

```text
waiting -> uploading -> merging -> completed
              |             
              +-> paused -> uploading
              +-> error  -> uploading
```

- `waiting`：已选择但尚未上传
- `uploading`：worker正在消费分片队列
- `paused`：用户暂停，活动请求已取消
- `merging`：所有分片完成，等待服务端合并
- `completed`：完整文件可访问
- `error`：重试后仍然失败，可以手动重试

## 9. 为什么使用 Pinia

任务列表同时被顶部统计、上传队列和上传管理器使用，状态已经跨越多个职责模块。Pinia将任务数据放在统一 Store中，而请求和调度逻辑仍保留在 composable，避免把网络副作用全部塞进 Store。

## 10. 当前边界

- 未实现用户登录和不同用户的数据隔离
- 未限制文件类型和总存储容量
- 元信息保存在 JSON 文件中，而非数据库
- 同名同元信息文件会被视作同一个任务
- 文件内容 Hash、秒传、IndexedDB任务持久化属于后续增强
- 生产环境还需要鉴权、限流、文件扫描、对象存储和定时清理过期分片

## 11. 可量化测试方法

不要在简历中直接编写性能提升数字。可以使用 Chrome DevTools Network Throttling，固定测试环境后记录：

| 测试项 | 建议条件 | 记录指标 |
|---|---|---|
| 并发效果 | 500 MB文件，并发1/3/5 | 完整上传耗时 |
| 暂停恢复 | 上传50%后暂停并刷新 | 重复上传字节数、恢复耗时 |
| 内存占用 | 1 GB文件 | JS Heap峰值 |
| 失败重试 | DevTools设置Offline后恢复 | 恢复成功率、重试次数 |

完成测试后再把真实结果写入简历。

## 12. 简历描述参考

**大文件分片上传与素材管理平台**

项目介绍：基于 Vue 3、TypeScript和 Node.js实现的大文件素材上传平台，支持文件分片、并发控制、暂停恢复、失败重试、断点续传和服务端合并。

项目亮点：

1. 基于 `Blob.slice` 将文件切分为 5 MB分片，设计共享队列和 3 worker并发模型，避免 `Promise.all` 一次创建大量网络请求，并对失败分片实现最多2次退避重试。
2. 使用 `AbortController` 取消活动分片请求，恢复时查询服务端已完成分片并仅上传缺失部分；服务端采用临时文件 + 原子重命名，避免残缺分片被误判为成功。
3. 基于 Node Stream实现分片流式落盘和顺序合并，避免分片完整缓存在服务端内存；使用 Pinia管理任务状态，并通过 TypeScript约束上传状态流转和接口数据。

## 13. 高频面试问题

1. 为什么不能直接 `Promise.all` 上传所有分片？
2. 如何确保并发 worker不会上传同一个分片？
3. 暂停时已经传到一半的分片如何处理？
4. 服务端如何区分完整分片和残缺分片？
5. 恢复上传为什么不依赖浏览器保存任务？
6. 元信息 Hash与完整文件 Hash有什么差别？
7. `Blob.slice` 是否会复制完整文件？
8. 为什么使用 Node Stream，而不是先读取为 Buffer？
9. 如何保证分片合并顺序正确？
10. 多用户上传同一文件时如何实现真正的秒传？

回答这些问题时，应结合 `useUploadManager.ts` 和 `server/index.js` 的具体实现，不要只背概念。
