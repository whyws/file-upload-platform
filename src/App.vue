<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { Check, File, FileArchive, FileImage, FolderOpen, HardDriveUpload, Pause, Play, RefreshCw, RotateCcw, Trash2, Upload, Video } from '@lucide/vue'
import { useUploadStore } from './stores/upload'
import { useUploadManager } from './composables/useUploadManager'
import type { UploadTask } from './types'

const store = useUploadStore()
const { tasks, assets, activeCount, completedCount } = storeToRefs(store)
const { addFiles, startTask, pauseTask, removeTask, startAll, refreshAssets, deleteAsset } = useUploadManager()
// 文件输入元素的引用
const fileInput = ref<HTMLInputElement>()
//标记是否正在拖拽文件:拖拽文件经过页面时，改变样式
const dragging = ref(false)
// 标记是否正在加载素材列表：刷新按钮旋转动画
const loadingAssets = ref(false)

// 计算总的素材空间大小，使用 reduce 方法累加每个素材的大小。
const totalBytes = computed(() => assets.value.reduce((sum, asset) => sum + asset.size, 0))

// 上传状态对应的文本描述，用于在界面上显示任务状态。
const statusText = {
  waiting: '等待上传', uploading: '上传中', paused: '已暂停', merging: '正在合并', completed: '已完成', error: '上传失败',
}

// 将字节数格式化为可读的字符串，支持 B、KB、MB、GB 单位。
function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

// 计算上传任务的进度百分比，返回一个整数值。
function progress(task: UploadTask) {
  return Math.round((task.uploadedChunks.length / task.totalChunks) * 100)
}

// 处理文件选择事件，将选中的文件添加到上传队列中，并清空输入框的值。
function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) addFiles(Array.from(input.files))
  input.value = ''
}

// 处理文件拖放事件，将拖入的文件添加到上传队列中，并取消拖拽状态。
function dropFiles(event: DragEvent) {
  dragging.value = false
  if (event.dataTransfer?.files) addFiles(Array.from(event.dataTransfer.files))
}

// 根据文件类型返回对应的图标组件，用于在界面上显示文件类型。
function fileIcon(type: string) {
  if (type.startsWith('image/')) return FileImage
  if (type.startsWith('video/')) return Video
  if (type.includes('zip') || type.includes('compressed')) return FileArchive
  return File
}

// 重新加载素材列表，设置加载状态为 true，调用刷新函数后再将加载状态设置为 false。
async function reloadAssets() {
  loadingAssets.value = true
  try { await refreshAssets() } finally { loadingAssets.value = false }
}

// 弹出确认框，确认是否删除素材，如果用户确认，则调用删除函数。
async function confirmDelete(assetId: string, assetName: string) {
  // window.confirm是浏览器原生弹窗，点“确定”返回 true，“取消”返回 false
  if (window.confirm(`确定删除“${assetName}”吗？此操作无法撤销。`)) await deleteAsset(assetId)
}

//页面加载完成后自动刷新素材列表
onMounted(reloadAssets)
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><span><HardDriveUpload :size="20" /></span><div><b>Upload Studio</b><small>素材管理</small></div></div>
      <button class="primary compact" :disabled="!tasks.length || activeCount > 0" @click="startAll"><Upload :size="16" />全部开始</button>
    </header>

    <main>
      <section class="summary">
        <div><small>上传任务</small><strong>{{ tasks.length }}</strong></div>
        <div><small>正在处理</small><strong>{{ activeCount }}</strong></div>
        <div><small>本次完成</small><strong>{{ completedCount }}</strong></div>
        <div><small>素材空间</small><strong>{{ formatBytes(totalBytes) }}</strong></div>
      </section>
      <section class="workspace">
        <div class="section-head"><div><h1>上传队列</h1><p>{{ tasks.length ? `${tasks.length} 个任务` : '暂无任务' }}</p></div></div>
        <button class="dropzone" :class="{ dragging }" 
        @click="fileInput?.click()" 
        @dragenter.prevent="dragging = true" 
        @dragover.prevent 
        @dragleave.prevent="dragging = false" 
        @drop.prevent="dropFiles">//拖拽文件到页面时，添加文件到上传队列
          <span><Upload :size="23" /></span><b>选择或拖入文件</b><small>单个分片 5 MB · 3 路并发</small>
        </button>
        <input ref="fileInput" class="hidden-input" type="file" multiple @change="selectFiles" />

        <div class="task-list">
          <article v-for="task in tasks" :key="task.fileId" class="task-row">
            <div class="file-icon"><component :is="fileIcon(task.file.type)" :size="20" /></div>
            <div class="task-main">
              <div class="task-title"><b>{{ task.file.name }}</b><span :class="['status', task.status]">{{ statusText[task.status] }}</span></div>
              <div class="task-meta"><span>{{ formatBytes(task.file.size) }}</span><span>{{ task.uploadedChunks.length }}/{{ task.totalChunks }} 分片</span><span>{{ progress(task) }}%</span></div>
              <div class="progress"><i :style="{ width: `${progress(task)}%` }"></i></div>
              <p v-if="task.error" class="error-text">{{ task.error }}</p>
            </div>
            <div class="actions">
              <button v-if="task.status === 'uploading'" title="暂停" @click="pauseTask(task)"><Pause :size="17" /></button>
              <button v-else-if="['waiting','paused'].includes(task.status)" title="开始" @click="startTask(task)"><Play :size="17" /></button>
              <button v-else-if="task.status === 'error'" title="重试" @click="startTask(task)"><RotateCcw :size="17" /></button>
              <span v-else-if="task.status === 'completed'" class="done"><Check :size="17" /></span>
              <button v-if="!['uploading','merging'].includes(task.status)" title="移除任务" @click="removeTask(task)"><Trash2 :size="17" /></button>
            </div>
          </article>
        </div>
      </section>

      <section class="library">
        <div class="section-head"><div><h2>素材库</h2><p>{{ assets.length }} 个文件</p></div><button class="icon-button" title="刷新素材" @click="reloadAssets"><RefreshCw :size="17" :class="{ spinning: loadingAssets }" /></button></div>
        <div v-if="assets.length" class="asset-grid">
          <article v-for="asset in assets" :key="asset.id" class="asset">
            <a class="preview" :href="asset.url" target="_blank"><img v-if="asset.type.startsWith('image/')" :src="asset.url" :alt="asset.name" /><component :is="fileIcon(asset.type)" v-else :size="28" /></a>
            <div class="asset-info"><span><b>{{ asset.name }}</b><small>{{ formatBytes(asset.size) }} · {{ new Date(asset.createdAt).toLocaleDateString() }}</small></span><button title="删除素材" @click="confirmDelete(asset.id, asset.name)"><Trash2 :size="16" /></button></div>
          </article>
        </div>
        <div v-else class="empty-library"><FolderOpen :size="28" /><span>暂无已上传素材</span></div>
      </section>
    </main>
  </div>
</template>

<style>
.asset-info{display:flex;align-items:center;gap:8px}.asset-info>span{min-width:0;flex:1}.asset-info button{width:30px;height:30px;flex:none;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:#7a858b;cursor:pointer}.asset-info button:hover{background:#fbe9e7;color:#b33d31}
</style>
