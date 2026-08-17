import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.zvyak.zakaz',
  appName: 'BrooklynBowl Kiosk',
  webDir: 'dist',
  plugins: {
    CapacitorUpdater: {
      // Updates are deliberately started from the protected tablet settings.
      // A kiosk must never download/apply a bundle while a guest is ordering.
      autoUpdate: false,
      updateUrl: 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1/ota/update',
      appReadyTimeout: 15_000,
      responseTimeout: 10,
      autoDeleteFailed: true,
      autoDeletePrevious: false,
      resetWhenUpdate: false,
    },
  },
};

export default config;
