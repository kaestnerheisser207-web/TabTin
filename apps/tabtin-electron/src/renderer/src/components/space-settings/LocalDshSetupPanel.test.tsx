import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDshStatus } from '@shared/types/local-dsh'
import zh from '../../i18n/locales/zh-CN/space.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { version?: string; supportedVersion?: string }) => {
    const value = key.split('.').reduce<any>((result, part) => result?.[part], zh) ?? key
    return value.replace('{{version}}', options?.version ?? '').replace('{{supportedVersion}}', options?.supportedVersion ?? '')
  } }),
}))
vi.mock('@muse/smartsheet-ui', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button>,
}))
import { LocalDshSetupPanel } from './LocalDshSetupPanel'

const missing: LocalDshStatus = { installed: false, executable: null, version: null, installing: false, canInstall: true, detail: null, error: null }
const ready: LocalDshStatus = { ...missing, installed: true, executable: '/opt/homebrew/bin/dsh', version: '0.1.1-rc.2', canInstall: false }
const getStatus = vi.fn()
const install = vi.fn()
const openExternal = vi.fn()

beforeEach(() => {
  getStatus.mockReset().mockResolvedValue(missing)
  install.mockReset().mockResolvedValue(ready)
  openExternal.mockReset().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'muse', { configurable: true, value: { localDsh: { getStatus, install }, openExternal } })
})
afterEach(cleanup)

describe('LocalDshSetupPanel', () => {
  it('only checks on mount and installs after an explicit click', async () => {
    const onReadyChange = vi.fn()
    render(<LocalDshSetupPanel onReadyChange={onReadyChange} />)
    const button = await screen.findByRole('button', { name: '安装 DSH' })
    expect(getStatus).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
    expect(onReadyChange).toHaveBeenLastCalledWith(false)
    fireEvent.click(button)
    await screen.findByText('本机 DSH 已就绪')
    expect(install).toHaveBeenCalledOnce()
    expect(screen.getByText('版本 0.1.1-rc.2')).toBeTruthy()
    expect(onReadyChange).toHaveBeenLastCalledWith(true)
  })

  it('reuses an existing installation and allows another read-only check', async () => {
    getStatus.mockResolvedValue(ready)
    render(<LocalDshSetupPanel />)
    await screen.findByText('本机 DSH 已就绪')
    expect(screen.queryByRole('button', { name: '安装 DSH' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
    expect(install).not.toHaveBeenCalled()
  })

  it('deduplicates repeated install clicks and shows progress until completion', async () => {
    let finish!: (status: LocalDshStatus) => void
    install.mockImplementation(() => new Promise<LocalDshStatus>(resolve => { finish = resolve }))
    render(<LocalDshSetupPanel />)
    const button = await screen.findByRole('button', { name: '安装 DSH' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(install).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: '正在安装…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('正在安装 DSH，可能需要几分钟。')).toBeTruthy()
    await act(async () => finish(ready))
    expect(screen.getByText('本机 DSH 已就绪')).toBeTruthy()
  })

  it('shows an installation failure and supports retrying', async () => {
    install.mockResolvedValueOnce({ ...missing, error: '下载失败，请检查网络。' }).mockResolvedValueOnce(ready)
    render(<LocalDshSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '安装 DSH' }))
    expect((await screen.findByRole('alert')).textContent).toContain('下载失败，请检查网络。')
    fireEvent.click(screen.getByRole('button', { name: '重试安装' }))
    await screen.findByText('本机 DSH 已就绪')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('ignores late rejection after closing the panel', async () => {
    let fail!: (error: Error) => void
    install.mockImplementation(() => new Promise<LocalDshStatus>((_resolve, reject) => { fail = reject }))
    const onReadyChange = vi.fn()
    const view = render(<LocalDshSetupPanel onReadyChange={onReadyChange} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装 DSH' }))
    const notifications = onReadyChange.mock.calls.length
    view.unmount()
    await act(async () => fail(new Error('late rejection')))
    expect(onReadyChange).toHaveBeenCalledTimes(notifications)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('provides Node.js instructions without an install action when prerequisites are missing', async () => {
    getStatus.mockResolvedValue({ ...missing, canInstall: false, detail: 'Node missing' })
    render(<LocalDshSetupPanel />)
    expect(await screen.findByText('请先安装 Node.js 22.12 或更新版本（含 npm），再重新检测。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '安装 DSH' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装 Node.js' }))
    expect(openExternal).toHaveBeenCalledWith('https://nodejs.org/en/download')
    expect(install).not.toHaveBeenCalled()
  })

  it('recovers from a failed status check without triggering installation', async () => {
    getStatus.mockRejectedValueOnce(new Error('检测失败')).mockResolvedValueOnce(ready)
    render(<LocalDshSetupPanel />)
    expect((await screen.findByRole('alert')).textContent).toContain('检测失败')
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    await screen.findByText('本机 DSH 已就绪')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(install).not.toHaveBeenCalled()
  })

  it('checks an installation already running in the background until it is ready', async () => {
    vi.useFakeTimers()
    try {
      getStatus.mockResolvedValueOnce({ ...missing, installing: true }).mockResolvedValueOnce(ready)
      const onReadyChange = vi.fn()
      render(<LocalDshSetupPanel onReadyChange={onReadyChange} />)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText('正在安装 DSH，可能需要几分钟。')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByText('本机 DSH 已就绪')).toBeTruthy()
      expect(onReadyChange).toHaveBeenLastCalledWith(true)
      expect(install).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('explains an incompatible global DSH and installs a compatible managed version only after a click', async () => {
    getStatus.mockResolvedValue({ ...missing, version: '0.1.0', supportedVersion: '0.1.1-rc.2', errorCode: 'DSH_VERSION_INCOMPATIBLE', error: 'version incompatible' })
    const onReadyChange = vi.fn()
    render(<LocalDshSetupPanel onReadyChange={onReadyChange} compact />)
    expect(await screen.findByText('本机 DSH 0.1.0 与当前 Muse 不兼容。可安装 0.1.1-rc.2，现有 DSH 保持不变。')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(onReadyChange).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: '安装 DSH' }))
    await screen.findByText('就绪')
    expect(screen.getByText('v0.1.1-rc.2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '安装 DSH' })).toBeNull()
    expect(onReadyChange).toHaveBeenLastCalledWith(true)
  })

  it('still displays an installation transport failure after an incompatibility notice', async () => {
    getStatus.mockResolvedValue({ ...missing, version: '0.1.0', supportedVersion: '0.1.1-rc.2', errorCode: 'DSH_VERSION_INCOMPATIBLE', error: 'version incompatible' })
    install.mockRejectedValueOnce(new Error('安装连接失败'))
    render(<LocalDshSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '安装 DSH' }))
    expect((await screen.findByRole('alert')).textContent).toContain('安装连接失败')
    expect(screen.getByRole('button', { name: '重试安装' })).toBeTruthy()
  })

  it('keeps all mutation controls disabled when its parent disables the panel', async () => {
    render(<LocalDshSetupPanel disabled />)
    const button = await screen.findByRole('button', { name: '安装 DSH' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(install).not.toHaveBeenCalled()
  })
})
