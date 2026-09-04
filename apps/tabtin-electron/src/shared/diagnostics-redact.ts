/**
 * 诊断包脱敏（主进程 / 渲染进程共享）——薄壳。
 *
 * 实现已提升到 @muse/shared：Daemon 的 Sentry beforeSend
 * 也复用同一份规则，保证多端脱敏口径同源。本文件保留原 import 路径不变。
 */

export { redact, redactJson } from '@muse/shared/diagnostics-redact'
