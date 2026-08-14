import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

export type OtaCheckResult = {
  platform: 'android' | 'browser';
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
};

const bundledVersion = import.meta.env.VITE_BUILD_VERSION || '0.1.0';

function installedVersion(bundleVersion: string, nativeVersion: string) {
  return !bundleVersion || bundleVersion === 'builtin' ? nativeVersion || bundledVersion : bundleVersion;
}

/** Marks the currently loaded OTA bundle healthy, enabling automatic rollback
 * if a future bundle cannot start the kiosk successfully. */
export const otaService = {
  bundledVersion,

  async markReady() {
    if (!Capacitor.isNativePlatform()) return;
    try { await CapacitorUpdater.notifyAppReady(); }
    catch (error) { console.warn('OTA readiness check unavailable', error); }
  },

  async current(): Promise<OtaCheckResult> {
    if (!Capacitor.isNativePlatform()) return { platform: 'browser', currentVersion: bundledVersion, latestVersion: null, available: false };
    const current = await CapacitorUpdater.current();
    return { platform: 'android', currentVersion: installedVersion(current.bundle.version, current.native), latestVersion: null, available: false };
  },

  async check(): Promise<OtaCheckResult> {
    if (!Capacitor.isNativePlatform()) return { platform: 'browser', currentVersion: bundledVersion, latestVersion: bundledVersion, available: false };
    const [current, latest] = await Promise.all([CapacitorUpdater.current(), CapacitorUpdater.getLatest()]);
    const currentVersion = installedVersion(current.bundle.version, current.native);
    const latestVersion = latest.version && latest.version !== 'builtin' ? latest.version : currentVersion;
    const unavailable = latest.error === 'no_new_version_available' || latest.kind === 'up_to_date' || !latest.url;
    return { platform: 'android', currentVersion, latestVersion, available: !unavailable && current.bundle.version !== latestVersion };
  },

  /** Downloads and immediately switches to the newest web bundle. `set` reloads
   * the WebView, so no code should be placed after that call. */
  async installLatest(onProgress?: (percent: number) => void) {
    if (!Capacitor.isNativePlatform()) return { state: 'browser' as const };
    const [current, latest] = await Promise.all([CapacitorUpdater.current(), CapacitorUpdater.getLatest()]);
    if (!latest.version || !latest.url || latest.error === 'no_new_version_available') return { state: 'current' as const };
    if (current.bundle.version === latest.version) return { state: 'current' as const };

    const progressListener = onProgress ? await CapacitorUpdater.addListener('download', ({ percent }) => onProgress(Math.max(0, Math.min(100, Math.round(percent))))) : null;
    try {
      const bundle = await CapacitorUpdater.download({
        url: latest.url,
        version: latest.version,
        sessionKey: latest.sessionKey,
        checksum: latest.checksum,
        manifest: latest.manifest,
      });
      onProgress?.(100);
      await CapacitorUpdater.set({ id: bundle.id });
      return { state: 'installing' as const };
    } finally {
      await progressListener?.remove();
    }
  },
};
