import { afterEach, describe, expect, it } from 'vitest'
import { buildToastLaunchUrl, parseToastLaunchUrl } from '../notify-launch'

const originalRuntimeProfile = process.env.MUSE_RUNTIME_PROFILE

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.MUSE_RUNTIME_PROFILE
  } else {
    process.env.MUSE_RUNTIME_PROFILE = originalRuntimeProfile
  }
})

describe('notify-launch', () => {
  it('无 navigateTo 时生成 focus URL', () => {
    expect(buildToastLaunchUrl(undefined)).toBe('muse://focus')
    expect(buildToastLaunchUrl(null)).toBe('muse://focus')
    expect(buildToastLaunchUrl({ type: 'im-conversation', id: '' })).toBe('muse://focus')
  })

  it('IM 目标往返编码解码', () => {
    const target = {
      type: 'im-conversation' as const,
      id: 'conv-1',
      organizationId: 'org-1',
    }
    const url = buildToastLaunchUrl(target)
    expect(url.startsWith('muse://notify?d=')).toBe(true)
    expect(parseToastLaunchUrl(url)).toEqual({ kind: 'notify', navigateTo: target })
  })

  it('preprod uses an isolated protocol scheme', () => {
    process.env.MUSE_RUNTIME_PROFILE = 'preprod'

    const url = buildToastLaunchUrl({ type: 'im-conversation', id: 'conv-preprod' })

    expect(url.startsWith('muse-preprod://notify?d=')).toBe(true)
    expect(parseToastLaunchUrl(url)).toEqual({
      kind: 'notify',
      navigateTo: { type: 'im-conversation', id: 'conv-preprod' },
    })
    expect(parseToastLaunchUrl('muse://focus')).toEqual({ kind: 'other' })
  })

  it('解析 focus / 其它协议', () => {
    expect(parseToastLaunchUrl('muse://focus')).toEqual({ kind: 'focus' })
    expect(parseToastLaunchUrl('muse://resource/document/doc-1')).toEqual({ kind: 'other' })
    expect(parseToastLaunchUrl('https://example.com')).toEqual({ kind: 'other' })
  })
})
