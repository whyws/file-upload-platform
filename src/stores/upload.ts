import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Asset, UploadTask } from '../types'

export const useUploadStore = defineStore('upload', () => {
  // 上传任务列表
  const tasks = ref<UploadTask[]>([])
  // 素材列表
  const assets = ref<Asset[]>([])

  // 计算当前正在上传中的任务数量。
  const activeCount = computed(() => tasks.value.filter((task) => task.status === 'uploading' || task.status === 'merging').length)
  // 计算当前已完成的任务数量。
  const completedCount = computed(() => tasks.value.filter((task) => task.status === 'completed').length)

  // 添加任务
  function addTask(task: UploadTask) {
    // 添加一个新任务到列表最前面，但如果已经有相同 fileId 的任务，就不添加。
    if (!tasks.value.some((item) => item.fileId === task.fileId)) tasks.value.unshift(task)
  }

  // 删除任务
  function removeTask(fileId: string) {
    tasks.value = tasks.value.filter((task) => task.fileId !== fileId)
  }

  return { tasks, assets, activeCount, completedCount, addTask, removeTask }
})
