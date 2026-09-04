/**
 * @muse/media-core
 *
 * Shared media primitives used by TabVideo and TabSlide.
 * Import specific pipelines via subpath exports for tree-shaking:
 *
 *   import { ... } from '@muse/media-core/fonts'
 *   import { ... } from '@muse/media-core/assets'
 *   import { ... } from '@muse/media-core/svg'
 *   import { ... } from '@muse/media-core/effects'
 */

// Re-export all pipelines for convenience (prefer subpath imports for tree-shaking)
export * from './fonts/index.js'
export * from './assets/index.js'
export * from './svg/index.js'
export * from './effects/index.js'
