import { describe, expect, it } from 'vitest'
import {
  isDevLikeBuild,
  isMeetingRecordsUiEnabled,
  isRuntimeVersionDetailsEnabled,
} from './featureFlags'

describe('isDevLikeBuild', () => {
  it('enables dev-like capabilities for local packaged builds', () => {
    expect(isDevLikeBuild(false, 'local')).toBe(true)
  })

  it('keeps preprod and production packaged builds non-dev-like', () => {
    expect(isDevLikeBuild(false, 'preprod')).toBe(false)
    expect(isDevLikeBuild(false, 'production')).toBe(false)
  })
})

describe('isMeetingRecordsUiEnabled', () => {
  it('defaults on for dev-like builds unless explicitly disabled', () => {
    expect(isMeetingRecordsUiEnabled(true, undefined)).toBe(true)
    expect(isMeetingRecordsUiEnabled(true, 'false')).toBe(false)
  })

  it('requires an explicit opt-in for packaged community or production builds', () => {
    expect(isMeetingRecordsUiEnabled(false, undefined)).toBe(false)
    expect(isMeetingRecordsUiEnabled(false, 'true')).toBe(true)
  })
})

describe('isRuntimeVersionDetailsEnabled', () => {
  it.each(['development', 'preprod'])('keeps runtime details for %s builds', (profile) => {
    expect(isRuntimeVersionDetailsEnabled(profile)).toBe(true)
  })

  it('hides runtime details for production builds', () => {
    expect(isRuntimeVersionDetailsEnabled('production')).toBe(false)
  })
})
