import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

/** Marks the currently loaded OTA bundle healthy, enabling automatic rollback
 * if a future bundle cannot start the kiosk successfully. */
export const otaService = {
  async markReady() {
    if (!Capacitor.isNativePlatform()) return;
    try { await CapacitorUpdater.notifyAppReady(); }
    catch (error) { console.warn('OTA readiness check unavailable', error); }
  },

  /** Downloads and immediately switches to the newest web bundle. `set` reloads
   * the WebView, so no code should be placed after that call. */
  async installLatest() {
    if (!Capacitor.isNativePlatform()) return { state: 'browser' as const };
    const [current, latest] = await Promise.all([CapacitorUpdater.current(), CapacitorUpdater.getLatest()]);
    if (!latest.version || !latest.url || latest.error === 'no_new_version_available') return { state: 'current' as const };
    if (current.bundle.version === latest.version) return { state: 'current' as const };

    const bundle = await CapacitorUpdater.download({
      url: latest.url,
      version: latest.version,
      sessionKey: latest.sessionKey,
      checksum: latest.checksum,
      manifest: latest.manifest,
    });
    await CapacitorUpdater.set({ id: bundle.id });
    return { state: 'installing' as const };
  },
};
