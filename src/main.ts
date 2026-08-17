import './styles/index.css';
import { startApp } from './app';
import { imageCacheService } from './services/image-cache-service';

if ('serviceWorker' in navigator) window.addEventListener('load', async () => {
  const registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
  await registration.update();
});
void imageCacheService.init().catch(() => undefined).finally(() => { void startApp(); });
