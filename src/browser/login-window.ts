import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteId } from '../core/types';

/**
 * Google refuses "Sign in with Google" inside a browser controlled by automation
 * ("Esse navegador ou app pode não ser seguro"). So logins happen BEFORE the run, in a
 * normal Edge/Chrome window that FlashHire only opens (it does not control it), using
 * FlashHire's own profile. The sessions stay saved in that profile and the run reuses them.
 */
export interface LoginPlatform {
  label: string;
  urls: string[];
}

export const LOGIN_PLATFORMS: Partial<Record<SiteId, LoginPlatform>> = {
  linkedin: { label: 'LinkedIn', urls: ['https://www.linkedin.com/login'] },
  gupy: { label: 'Gupy', urls: ['https://portal.gupy.io/'] },
  indeed: { label: 'Indeed', urls: ['https://secure.indeed.com/auth?hl=pt_BR&co=BR'] },
  glassdoor: { label: 'Glassdoor', urls: ['https://www.glassdoor.com.br/profile/login_input.htm'] },
};

/** Glassdoor's "Candidatura simplificada" runs on Indeed, so it needs both logins. */
export function platformsFor(site: SiteId): SiteId[] {
  if (site === 'glassdoor') return ['glassdoor', 'indeed'];
  return LOGIN_PLATFORMS[site] ? [site] : [];
}

export function executableCandidates(channel: 'msedge' | 'chrome', platform = process.platform, env = process.env): string[] {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean) as string[];
    const rel = channel === 'msedge' ? join('Microsoft', 'Edge', 'Application', 'msedge.exe') : join('Google', 'Chrome', 'Application', 'chrome.exe');
    return roots.map((r) => join(r, rel));
  }
  if (platform === 'darwin') {
    return channel === 'msedge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return channel === 'msedge' ? ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'];
}

export function findExecutable(channels: ('msedge' | 'chrome')[], override?: string): { channel: 'msedge' | 'chrome'; path: string } | null {
  if (override && existsSync(override)) return { channel: 'chrome', path: override };
  for (const channel of channels) {
    const path = executableCandidates(channel).find((p) => existsSync(p));
    if (path) return { channel, path };
  }
  return null;
}

/** Opens a plain browser window (not automated) on FlashHire's profile with one tab per login page. */
export function openLoginWindow(executable: string, profileDir: string, urls: string[]): ChildProcess {
  const child = spawn(executable, [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--new-window', ...urls], {
    stdio: 'ignore',
    detached: false,
  });
  child.on('error', () => {});
  return child;
}
