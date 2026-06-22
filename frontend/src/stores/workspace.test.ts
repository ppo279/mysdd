// Implements: tasks.md#T022 / plan.md#D-05
// stores/workspace#loadWorkspace 单测：mock api.workspaces.get 返回 DTO 含 isLegacy: true，
// 断言 store 中 detail.isLegacy === true 透传。
// 本期先写测试（RED 阶段），T023 实现对应代码（GREEN）。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWorkspaceStore } from './workspace'
import { api, type WorkspaceDetail } from '@/api'

// mock 整个 @/api 模块：T022 只需 workspaces.get，其它方法返回 undefined
// 注意：mock 模拟的是 api 函数本身（跳过 fetch/request），所以返回值仍是裸 DTO
// —— request 内部的 envelope 解包逻辑对 mock 不可见，store 直接拿 DTO
vi.mock('@/api', () => ({
  api: {
    workspaces: {
      get: vi.fn(),
    },
  },
}))

describe('stores/workspace#loadWorkspace (T022 / plan.md#D-05)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.workspaces.get).mockReset()
  })

  it('happy: 后端返回 isLegacy: true → store.detail.isLegacy === true 透传', async () => {
    const dto: WorkspaceDetail = {
      id: 'ws-1',
      name: 'legacy-ws',
      description: '',
      repoUrl: '',
      techStack: 'ts',
      background: '',
      localPath: '/tmp/ws-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      features: [],
      isLegacy: true,                // 后端 D-05 计算字段
    }
    vi.mocked(api.workspaces.get).mockResolvedValue(dto)

    const store = useWorkspaceStore()
    await store.loadWorkspace('ws-1')

    // 关键断言：isLegacy 由后端透传到 store，前端不重算
    expect(store.detail).toBeDefined()
    expect(store.detail?.isLegacy).toBe(true)
    // 反向断言：其他字段也透传
    expect(store.detail?.id).toBe('ws-1')
    expect(store.detail?.name).toBe('legacy-ws')
    // 关键断言：api.workspaces.get 被以正确 id 调用
    expect(api.workspaces.get).toHaveBeenCalledWith('ws-1')
  })

  it('happy: 后端返回 isLegacy: false → store.detail.isLegacy === false 透传', async () => {
    const dto: WorkspaceDetail = {
      id: 'ws-new',
      name: 'new-ws',
      description: '',
      repoUrl: '',
      techStack: 'ts',
      background: '',
      localPath: '/tmp/ws-new',
      createdAt: '2026-01-01T00:00:00.000Z',
      features: [],
      isLegacy: false,
    }
    vi.mocked(api.workspaces.get).mockResolvedValue(dto)

    const store = useWorkspaceStore()
    await store.loadWorkspace('ws-new')

    expect(store.detail).toBeDefined()
    expect(store.detail?.isLegacy).toBe(false)
  })
})
