import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

function readBuildScript(name: string): string {
  return readFileSync(join(scriptsDir, name), 'utf8');
}

describe('packaged app install identity', () => {
  it('keeps local and community identities distinct in build-packaged-app.sh', () => {
    const script = readBuildScript('build-packaged-app.sh');

    expect(script).toMatch(
      /local\)(?:(?!;;)[\s\S])*?PROFILE_PRODUCT_NAME="Muse Local"(?:(?!;;)[\s\S])*?;;/,
    );
    expect(script).toMatch(
      /local\)(?:(?!;;)[\s\S])*?PROFILE_APP_ID="com\.muse\.app\.local"(?:(?!;;)[\s\S])*?;;/,
    );
    expect(script).toMatch(
      /local\)(?:(?!;;)[\s\S])*?PROFILE_EXECUTABLE_NAME="muse-local"(?:(?!;;)[\s\S])*?;;/,
    );
    expect(script).toMatch(
      /community\)(?:(?!;;)[\s\S])*?PROFILE_PRODUCT_NAME="Muse Community"(?:(?!;;)[\s\S])*?;;/,
    );
    expect(script).toMatch(
      /community\)(?:(?!;;)[\s\S])*?PROFILE_APP_ID="com\.muse\.community"(?:(?!;;)[\s\S])*?;;/,
    );
    expect(script).toMatch(
      /community\)(?:(?!;;)[\s\S])*?PROFILE_EXECUTABLE_NAME="muse-community"(?:(?!;;)[\s\S])*?;;/,
    );
  });

  it('keeps the quick DMG local identity aligned in build-mac-dmg-quick.sh', () => {
    const script = readBuildScript('build-mac-dmg-quick.sh');

    expect(script).toContain('PROFILE_PRODUCT_NAME="Muse Local"');
    expect(script).toContain('PROFILE_APP_ID="com.muse.app.local"');
  });
});
