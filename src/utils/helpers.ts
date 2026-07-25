export const formatPrice = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
export const escapeHtml = (value: string | number | null | undefined) => String(value ?? '').replace(/[&<>'"]/g, (symbol) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[symbol] ?? symbol);
export const debounce = <T extends (...args: never[]) => void>(callback: T, delay = 180) => {
  let timer = 0;
  return (...args: Parameters<T>) => { clearTimeout(timer); timer = window.setTimeout(() => callback(...args), delay); };
};
export const imageStyle = (url: string, position = 'center') => {
  const source = String(url ?? '').trim();
  const safeUrl = /^(https?:\/\/|\/)/i.test(source) ? encodeURI(source).replace(/["']/g, (symbol) => symbol === '"' ? '%22' : '%27') : '/icons/app-icon.svg';
  return `style="--image: url('${safeUrl}');--image-position:${position.replace(/[^\w% -]/g, '')}"`;
};
