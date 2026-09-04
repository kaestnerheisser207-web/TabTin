import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Replay harness 的独立 vitest 配置。
 *
 * root 固定为本目录；alias 复制自 packages/agent-runtime/vitest.config.ts
 * （路径改为从本目录出发）——runtime 源码内部的 @muse/* import 需要
 * 与其自身测试完全相同的解析规则。
 *
 * 运行方式见 run.sh：vitest 二进制借用 packages/agent-runtime 的安装。
 */

const PKG = path.resolve(__dirname, '../../packages');

export default defineConfig({
  resolve: {
    alias: {
      // 本目录在 packages/agent-runtime 之外，node 解析走不到它的
      // node_modules——显式把 vitest 指到运行用的同一份安装，避免
      // describe/it 注册进另一个 vitest 实例（"No test suite found"）。
      vitest: path.resolve(PKG, 'agent-runtime/node_modules/vitest/dist/index.js'),
      '@muse/config': path.resolve(PKG, 'tabtin-config/dist/index.js'),
      '@muse/file-pipeline': path.resolve(PKG, 'file-pipeline/src/index.ts'),
      '@muse/ws-gateway-client': path.resolve(PKG, 'ws-gateway-client/src/index.ts'),
      '@muse/terminal-core': path.resolve(PKG, 'terminal-core/src/index.ts'),
      '@muse/shared/storage-paths': path.resolve(PKG, 'tabtin-shared/src/storage-paths.ts'),
      '@muse/shared': path.resolve(PKG, 'tabtin-shared/src/index.ts'),
      '@muse/env-sanitize': path.resolve(PKG, 'env-sanitize/src/index.ts'),
    },
  },
  test: {
    root: __dirname,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    globals: true,
    /** 回放驱动真实引擎，单 case 可能到秒级；放宽超时。 */
    testTimeout: 30_000,
  },
});
