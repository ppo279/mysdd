import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// Implements: tasks.md#T002 / plan.md#D-07
// 前端测试基础设施：jsdom 环境，匹配 vitest 默认的 *.{test,spec}.ts(x)
// plugin-vue 必须注册，否则 .vue 单文件组件无法被解析
// resolve.alias 把 tsconfig.app.json 的 "@/*" paths 同步给 vitest（避免测试 import '@/api' 失败）
//
// Implements: tasks.md#T032.3
// vitest 2.x 内部打包了 vite 6.x 的类型，与项目根的 vite 8.x 类型在 Plugin.apply 等接口上漂移
// （proxy.configure 签名差异等）。运行时完全正常（`npx vitest run` 通过），是纯 TS 类型噪音。
// 后续若 vitest 升 3.x 把 vite 类型对齐后可去掉这一行。
export default defineConfig({
  plugins: [
    // @ts-expect-error - 见上方 T032.3 说明（vue() 的 Plugin 类型来自 vite 8.x，与 vitest 内嵌 vite 6.x 漂移）
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
  },
});
