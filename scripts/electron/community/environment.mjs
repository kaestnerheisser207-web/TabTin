import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export const COMMUNITY_ENV_DEFAULTS = Object.freeze({
  MUSE_LOCAL_DEV_MODE: 'native',
  MUSE_API_BASE_URL: 'http://127.0.0.1:6060/api',
  VITE_API_BASE_URL: 'http://127.0.0.1:6060/api',
  VITE_COLLAB_WS_BASE: 'ws://127.0.0.1:4100',
  VITE_CENTRIFUGO_WS_URL: 'ws://127.0.0.1:8100/connection/websocket',
  VITE_PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:5176',
  VITE_DEV_SERVER_PORT: '5175',
  VITE_DISTRIBUTION_KIND: 'community',
});

const URL_ENV_KEYS = new Set([
  'MUSE_API_BASE_URL',
  'VITE_API_BASE_URL',
  'VITE_COLLAB_WS_BASE',
  'VITE_CENTRIFUGO_WS_URL',
  'VITE_PUBLIC_WEB_BASE_URL',
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ROOT_ENV_PUBLIC_SWITCHES = [
  'MUSE_EDITION',
  'AUTH_FIXED_VERIFICATION_CODE',
];

export function mergeCommunityEnv(existing) {
  return Object.fromEntries(
    Object.entries(COMMUNITY_ENV_DEFAULTS).map(([key, defaultValue]) => [
      key,
      existing[key] ?? defaultValue,
    ]),
  );
}

export function parseEnvText(text) {
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match) continue;

    const [, key, rawValue] = match;
    values[key] = unquoteEnvValue(rawValue);
  }

  return values;
}

export function validateCommunityEnv(values) {
  const issues = [];
  const requiresLocalHosts = values.MUSE_LOCAL_DEV_MODE === 'native';
  const placeholderKeys = new Set();

  for (const key of Object.keys(COMMUNITY_ENV_DEFAULTS)) {
    if (/\$\{[^}]+\}/.test(values[key])) {
      issues.push({ key, reason: 'contains an unresolved placeholder' });
      placeholderKeys.add(key);
    }
  }

  for (const key of URL_ENV_KEYS) {
    const value = values[key];
    if (placeholderKeys.has(key)) continue;

    let url;
    try {
      url = new URL(value);
    } catch {
      issues.push({ key, reason: 'is not a valid URL' });
      continue;
    }

    if (url.username || url.password) {
      issues.push({ key, reason: 'must not include credentials' });
      continue;
    }

    if (requiresLocalHosts && !LOCAL_HOSTS.has(url.hostname)) {
      issues.push({ key, reason: 'uses an unknown remote host in local mode' });
    }
  }

  return issues;
}

export async function ensureCommunityEnvFile(filePath) {
  const existingText = await readEnvironmentFile(filePath);
  const values = mergeCommunityEnv(parseEnvText(existingText));
  const issues = validateCommunityEnv(values);
  if (issues.length > 0) {
    throw new Error(formatValidationIssues(issues));
  }

  const nextText = serializeCommunityEnv(values);
  if (existingText === nextText) {
    return { values, changed: false };
  }

  const temporaryFile = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryFile, nextText, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryFile, filePath);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }

  return { values, changed: true };
}

export async function ensureRootEnvFile(filePath, templatePath) {
  let existingText;
  try {
    existingText = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const template = await readFile(templatePath, 'utf8');
  if (existingText !== undefined) {
    const existing = parseEnvText(existingText);
    const templateValues = parseEnvText(template);
    const additions = ROOT_ENV_PUBLIC_SWITCHES.filter(
      (key) => !Object.hasOwn(existing, key),
    ).map((key) => {
      if (!Object.hasOwn(templateValues, key)) {
        throw new Error(`Missing ${key} in ${templatePath}`);
      }
      return key === 'AUTH_FIXED_VERIFICATION_CODE'
        ? `${key}=`
        : `${key}=${templateValues[key]}`;
    });
    if (additions.length === 0) return { changed: false };

    const separator =
      existingText.length > 0 && !existingText.endsWith('\n') ? '\n' : '';
    const nextText = `${existingText}${separator}${additions.join('\n')}\n`;
    const temporaryFile = `${filePath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryFile, nextText, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryFile, filePath);
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw error;
    }
    return { changed: true };
  }

  try {
    await writeFile(filePath, template, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return { changed: true };
  } catch (error) {
    if (error.code === 'EEXIST') return { changed: false };
    throw error;
  }
}

export async function writeCommunityRuntimeEnvFile(filePath, runtimeFilePath) {
  const values = parseEnvText(await readFile(filePath, 'utf8'));
  const edition = String(values.MUSE_EDITION ?? '')
    .trim()
    .toLowerCase();
  if (!['community', 'saas'].includes(edition)) {
    throw new Error('MUSE_EDITION must be community or saas');
  }
  const fixedCode = String(values.AUTH_FIXED_VERIFICATION_CODE ?? '').trim();
  if (fixedCode && !/^\d{6}$/.test(fixedCode)) {
    throw new Error(
      'AUTH_FIXED_VERIFICATION_CODE must be empty or exactly 6 digits',
    );
  }

  const runtimeText =
    `MUSE_EDITION=${edition}\n` +
    `AUTH_FIXED_VERIFICATION_CODE=${fixedCode}\n`;
  const temporaryFile = `${runtimeFilePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryFile, runtimeText, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryFile, runtimeFilePath);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
  return { changed: true };
}

async function readEnvironmentFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function serializeCommunityEnv(values) {
  return `${Object.keys(COMMUNITY_ENV_DEFAULTS)
    .map((key) => `${key}=${values[key]}`)
    .join('\n')}\n`;
}

function formatValidationIssues(issues) {
  return `Invalid community environment: ${issues
    .map(({ key, reason }) => `${key} ${reason}`)
    .join('; ')}`;
}

function unquoteEnvValue(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, '').trimEnd();
}
