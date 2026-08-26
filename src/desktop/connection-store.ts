import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TunnelPreferences {
  tunnelId: string;
  tunnelClientPath: string;
  profile: string;
}

export interface TunnelDraft extends TunnelPreferences {
  apiKey: string;
}

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const DEFAULT_PREFERENCES: TunnelPreferences = {
  tunnelId: '',
  tunnelClientPath: 'tunnel-client',
  profile: 'workspaceguard-local',
};

function assertPreferences(input: TunnelPreferences): TunnelPreferences {
  const tunnelId = input.tunnelId.trim();
  const tunnelClientPath = input.tunnelClientPath.trim();
  const profile = input.profile.trim();
  if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelId)) {
    throw new Error('Tunnel ID phải có dạng tunnel_ + 32 ký tự chữ thường hoặc số.');
  }
  if (!tunnelClientPath || tunnelClientPath.includes('\0')) {
    throw new Error('Hãy nhập đường dẫn tunnel-client hợp lệ.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile)) {
    throw new Error('Profile chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.');
  }
  return { tunnelId, tunnelClientPath, profile };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWrite(filePath: string, content: Buffer | string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700).catch(() => undefined);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, filePath);
  await chmod(filePath, mode).catch(() => undefined);
}

export class ConnectionStore {
  private readonly preferencesPath: string;
  private readonly secretPath: string;

  constructor(private readonly directory: string, private readonly cipher: SecretCipher) {
    this.preferencesPath = path.join(directory, 'tunnel-connection.json');
    this.secretPath = path.join(directory, 'tunnel-runtime-key.bin');
  }

  async load(): Promise<TunnelPreferences & { hasApiKey: boolean }> {
    let parsed: Partial<TunnelPreferences> = {};
    try {
      parsed = JSON.parse(await readFile(this.preferencesPath, 'utf8')) as Partial<TunnelPreferences>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Không thể đọc cấu hình tunnel đã lưu.');
    }
    const preferences = {
      tunnelId: typeof parsed.tunnelId === 'string' ? parsed.tunnelId : DEFAULT_PREFERENCES.tunnelId,
      tunnelClientPath: typeof parsed.tunnelClientPath === 'string' ? parsed.tunnelClientPath : DEFAULT_PREFERENCES.tunnelClientPath,
      profile: typeof parsed.profile === 'string' ? parsed.profile : DEFAULT_PREFERENCES.profile,
    };
    return { ...preferences, hasApiKey: await exists(this.secretPath) };
  }

  async save(input: TunnelDraft): Promise<TunnelPreferences & { hasApiKey: boolean }> {
    const preferences = assertPreferences(input);
    const apiKey = input.apiKey.trim();
    if (apiKey) {
      if (apiKey.length < 16) throw new Error('Runtime API key có vẻ không hợp lệ.');
      if (!this.cipher.isAvailable()) throw new Error('Mã hóa hệ điều hành hiện không khả dụng; không thể lưu runtime API key an toàn.');
    }
    await atomicWrite(this.preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, 0o600);
    if (apiKey) {
      await atomicWrite(this.secretPath, this.cipher.encrypt(apiKey), 0o600);
    }
    return { ...preferences, hasApiKey: await exists(this.secretPath) };
  }

  async runtimeApiKey(): Promise<string> {
    if (!this.cipher.isAvailable()) throw new Error('Mã hóa hệ điều hành hiện không khả dụng.');
    try {
      return this.cipher.decrypt(await readFile(this.secretPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Hãy nhập Runtime API key trước khi kết nối tunnel.');
      throw new Error('Không thể đọc Runtime API key từ Keychain.');
    }
  }
}
