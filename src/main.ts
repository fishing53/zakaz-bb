import './styles/index.css';
import { startApp } from './app';
import { appStore } from './store/app-store';
import { imageCacheService } from './services/image-cache-service';

if ('serviceWorker' in navigator) window.addEventListener('load', async () => {
  const registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
  await registration.update();
  registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', () => {
    if (registration.installing?.state === 'installed' && navigator.serviceWorker.controller) appStore.set({ pwaUpdateReady: true });
  }));
});
void imageCacheService.init().catch(() => undefined).finally(startApp);
