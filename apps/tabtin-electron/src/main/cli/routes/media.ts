/**
 * 媒体生成路由 — 委托给 @muse/media-capabilities 共享实现。
 *
 * 认证通过 Electron 的 djangoRequest（JWT / TokenManager）注入。
 */

import { createMediaHandler } from '@muse/media-capabilities/routes'
import { djangoRequest } from './shared/error-handler'

export const handleMediaRoute = createMediaHandler({ djangoRequest })
