import { defineConfig } from 'vitest/config';

// Implements: tasks.md#T001 / plan.md#D-07
// 后端测试基础设施：node 环境，匹配 *.test.ts
// passWithNoTests: tasks.md#T001 完成判据要求"无测试文件也不报错"
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
