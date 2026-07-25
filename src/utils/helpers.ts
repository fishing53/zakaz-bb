export const formatPrice = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
export const escapeHtml = (value: string | number | null | undefined) => String(value ?? '').replace(/[&<>'"]/g, (symbol) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[symbol] ?? symbol);
export const debounce = <T extends (...args: never[]) => void>(callback: T, delay = 180) => {
  let timer = 0;
  return (...args: Parameters<T>) => { clearTimeout(timer); timer = window.setTimeout(() => callback(...args), delay); };
};
export const imageStyle = (url: string, position = 'center') => `style="--image: url('${url.replace(/'/g, '%27')}');--image-position:${position.replace(/[^\w% -]/g, '')}"`;
