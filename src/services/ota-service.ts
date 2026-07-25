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
};
