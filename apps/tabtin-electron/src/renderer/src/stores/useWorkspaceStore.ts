/** @store-category domain */

/**
 * 组织状态管理 — 从 @muse/app-shell 重导出
 *
 * Electron 端的实际逻辑已移至 @muse/app-shell。
 * 本文件保留向后兼容，所有现有 import 无需改动。
 */

export {
  useOrganizationStore,
  useOrganizationStore as useWorkspaceStore,
  setCurrentSpaceOrganizationIdResolver,
  setSpaceClearer,
  type SelectOrganizationOptions as SelectOrganizationOptions,
} from '@muse/app-shell'
