import fs from 'node:fs';
import path from 'node:path';
import type { DaemonConfig } from '../../../base/types/daemon-config.js';
import { DEFAULT_CONFIG } from '../../../base/types/daemon-config.js';
import { atomicWriteFileSync } from '@tabtin/terminal-core';
import { getDaemonHomePath } from '@tabtin/shared/storage-paths';

const CONFIG_FILE_NAME = 'config.json';
const FINGERPRINT_FILE_NAME = 'fingerprint';

export class ConfigManager {
  private readonly configDir: string;
  private readonly configPath: string;
  private config: DaemonConfig | null = null;

  constructor(configDir?: string) {
    this.configDir = configDir ?? getDaemonHomePath();
    this.configPath = path.join(this.configDir, CONFIG_FILE_NAME);
  }

  getConfigDir(): string {
    return this.configDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  load(): DaemonConfig {
    if (this.config) return this.config;
    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Config not found at ${this.configPath}. Run 'tabtin-daemon init' first.`);
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw) as DaemonConfig;
    return this.config;
  }

  save(config: DaemonConfig): void {
    this.ensureConfigDir();
    const data = JSON.stringify(config, null, 2);
    atomicWriteFileSync(this.configPath, data, 0o600);
    this.config = config;
  }

  exists(): boolean {
    return fs.existsSync(this.configPath);
  }

  getOrCreateFingerprint(): string {
    const existing = this.getFingerprint();
    if (existing) return existing;
    this.ensureConfigDir();
    const fp = `daemon-${crypto.randomUUID()}`;
    atomicWriteFileSync(path.join(this.configDir, FINGERPRINT_FILE_NAME), fp, 0o600);
    return fp;
  }

  getFingerprint(): string | null {
    const fpPath = path.join(this.configDir, FINGERPRINT_FILE_NAME);
    if (!fs.existsSync(fpPath)) return null;
    const value = fs.readFileSync(fpPath, 'utf-8').trim();
    return value || null;
  }

  bindFingerprint(expected: string): string {
    const fingerprint = expected.trim();
    if (!fingerprint || fingerprint.length > 255) {
      throw new Error('Invalid token-bound device fingerprint');
    }
    const existing = this.getFingerprint();
    if (existing && existing !== fingerprint) {
      throw new Error('Cloud install token is bound to a different device fingerprint');
    }
    if (!existing) {
      this.ensureConfigDir();
      atomicWriteFileSync(
        path.join(this.configDir, FINGERPRINT_FILE_NAME),
        fingerprint,
        0o600,
      );
    }
    return fingerprint;
  }

  initFromToken(token: {
    server_url: string;
    ws_url: string;
    organization_id: string;
    /**
     * LH2-D3：install token 里的 user_id（owner.userId 来源）。可选——保留
     * 历史调用兼容，但不传将导致 DaemonAgentHost 启动期 SyncQueue 无法
     * 创建（owner 必填）。新调用必须传。
     */
    user_id?: string;
    device_name: string;
    device_type?: 'daemon' | 'cloud';
    cloud_generation?: number;
    workspace_root?: string;
  }, credential: {
    device_id: string;
    access_token: string;
  }): DaemonConfig {
    const fingerprint = this.getOrCreateFingerprint();
    const config: DaemonConfig = {
      ...DEFAULT_CONFIG,
      device_type: token.device_type ?? 'daemon',
      ...(token.cloud_generation ? { cloud_generation: token.cloud_generation } : {}),
      ...(token.workspace_root ? { workspace_root: token.workspace_root } : {}),
      server_url: token.server_url,
      ws_url: token.ws_url,
      device_id: credential.device_id,
      fingerprint,
      credential: credential.access_token,
      organization_id: token.organization_id,
      ...(token.user_id ? { user_id: token.user_id } : {}),
      device_name: token.device_name,
    };
    this.save(config);
    return config;
  }

  deleteFingerprint(): void {
    const fpPath = path.join(this.configDir, FINGERPRINT_FILE_NAME);
    try {
      if (fs.existsSync(fpPath)) {
        fs.unlinkSync(fpPath);
      }
    } catch {
      // best effort — missing file is the desired state
    }
  }

  getLogPath(): string {
    return path.join(this.configDir, 'daemon.log');
  }

  getPidPath(): string {
    return path.join(this.configDir, 'daemon.pid');
  }
}
