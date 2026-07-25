import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.zvyak.zakaz',
  appName: 'Заказ Звяк',
  webDir: 'dist',
  server: {
    // The kiosk uses the production service, including its API and content
    // managed through the admin panel.
    url: 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai',
    androidScheme: 'https',
  },
};

export default config;
