import './style.css';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

const api = 'https://xn--80aatcn.xn--b1ajk7f.xn--p1ai/api/v1';
const root = document.querySelector<HTMLDivElement>('#app')!;
let token = localStorage.getItem('bb-waiter-token') ?? '';
let waiter = JSON.parse(localStorage.getItem('bb-waiter-profile') ?? 'null') as { id: string; name: string } | null;
let initialized = false; let known = new Set<string>();
let pushInitialized = false;
let pushStatus = Capacitor.isNativePlatform() ? 'PUSH: подключение…' : 'PUSH доступен только в APK';
type Request = { id:number; table_number:string; request_type:string; status:string; created_at:string };
type Order = { order_number:string; table_number:string; total:number; status_step:number; created_at:string; source:string };
const request = async <T>(path:string, init:RequestInit={}) => { const r=await fetch(`${api}${path}`,{...init,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})}}); const b=await r.json().catch(()=>({})); if(!r.ok) throw new Error(b.error??'Ошибка сервера'); return b as T; };
const title:Record<string,string>={waiter:'Позвать официанта',bill:'Принести счёт',cutlery:'Принести приборы',help:'Нужна помощь'};
const sound=()=>{ try { const c=new AudioContext(); const o=c.createOscillator(); const g=c.createGain(); o.frequency.value=880; g.gain.value=.12; o.connect(g);g.connect(c.destination);o.start();setTimeout(()=>{o.frequency.value=1175},180);setTimeout(()=>{o.stop();c.close()},520); }catch{} };
async function enablePush() {
  if (pushInitialized || !token || !Capacitor.isNativePlatform()) return;
  pushInitialized = true;
  try {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') { pushStatus = 'PUSH: разрешите уведомления'; pushInitialized = false; return; }
    await PushNotifications.createChannel({ id: 'bb_waiter_urgent', name: 'Срочные вызовы BrooklynBowl', description: 'Новые заказы и вызовы гостей', importance: 5, visibility: 1, sound: 'default', vibration: true, lights: true, lightColor: '#f43131' });
    await PushNotifications.addListener('registration', async ({ value }) => { await request('/waiter/devices', { method: 'POST', body: JSON.stringify({ token: value, platform: 'android' }) }); pushStatus = 'PUSH: подключён'; render([], []); });
    await PushNotifications.addListener('registrationError', () => { pushStatus = 'PUSH: ошибка регистрации'; pushInitialized = false; });
    await PushNotifications.addListener('pushNotificationReceived', async () => { sound(); await queue(); });
    await PushNotifications.addListener('pushNotificationActionPerformed', async () => { await queue(); });
    await PushNotifications.register();
  } catch { pushStatus = 'PUSH: ошибка подключения'; pushInitialized = false; }
}
function login(){ root.innerHTML=`<section class="login"><span>BrooklynBowl</span><h1>Официант</h1><p>Введите персональный PIN-код.</p><input inputmode="numeric" type="password" maxlength="8" placeholder="PIN" autofocus><button>Войти</button></section>`; root.querySelector('button')!.onclick=async()=>{try{const pin=root.querySelector('input')!.value;const r=await request<{token:string;waiter:{id:string;name:string}}>('/waiter/login',{method:'POST',body:JSON.stringify({pin})});token=r.token;waiter=r.waiter;localStorage.setItem('bb-waiter-token',token);localStorage.setItem('bb-waiter-profile',JSON.stringify(waiter));initialized=false;await enablePush();queue()}catch(e){alert(e instanceof Error?e.message:'Ошибка')}}; }
function render(requests:Request[],orders:Order[],alert?:Request){ root.innerHTML=`<header><span>BROOKLYN BOWL</span><strong>${waiter?.name??''}</strong></header><div class="push-banner ${pushStatus.includes('подключён') ? 'is-ready' : ''}">${pushStatus}</div><section class="dashboard"><div class="hero"><span>СМЕНА АКТИВНА</span><h1>Ваши<br><em>задачи</em></h1><p>Новые вызовы и заказы появляются автоматически.</p></div><div class="columns"><section><h2>Вызовы</h2>${requests.length?requests.map(r=>`<article class="task ${r.status==='new'?'new':''}"><span>СТОЛ №${r.table_number}</span><h3>${title[r.request_type]??r.request_type}</h3><small>${new Date(r.created_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small>${r.status==='new'?`<button data-accept-id="${r.id}">Принять</button>`:r.status==='accepted'?`<button data-start-id="${r.id}">В путь</button>`:`<button data-complete-id="${r.id}">Выполнено</button>`}</article>`).join(''):'<p class="empty">Нет новых вызовов</p>'}</section><section><h2>Активные заказы</h2>${orders.map(o=>`<article class="order"><span>СТОЛ №${o.table_number}</span><h3>${o.order_number}</h3><b>${o.total} ₽</b></article>`).join('')||'<p class="empty">Нет активных заказов</p>'}</section></div></section>${alert?`<div class="incoming"><span>НОВЫЙ ВЫЗОВ</span><h1>СТОЛ №${alert.table_number}</h1><p>${title[alert.request_type]??alert.request_type}</p><button data-accept-id="${alert.id}">Принять вызов</button></div>`:''}`;root.querySelectorAll<HTMLButtonElement>('[data-accept-id]').forEach(b=>b.onclick=()=>accept(Number(b.dataset.acceptId)));root.querySelectorAll<HTMLButtonElement>('[data-start-id]').forEach(b=>b.onclick=()=>changeRequest(Number(b.dataset.startId),'start'));root.querySelectorAll<HTMLButtonElement>('[data-complete-id]').forEach(b=>b.onclick=()=>changeRequest(Number(b.dataset.completeId),'complete')); }
async function accept(id:number){try{await request(`/waiter/requests/${id}/accept`,{method:'POST'});await queue()}catch(e){alert(e instanceof Error?e.message:'Не удалось принять вызов')}}
async function changeRequest(id:number,action:'start'|'complete'){try{await request(`/waiter/requests/${id}/${action}`,{method:'POST'});await queue()}catch(e){alert(e instanceof Error?e.message:'Не удалось обновить вызов')}}
async function queue(){if(!token)return login();try{await enablePush();const data=await request<{requests:Request[];orders:Order[]}>('/waiter/queue');const fresh=data.requests.find(r=>r.status==='new'&&!known.has(String(r.id)));if(!initialized){data.requests.forEach(r=>known.add(String(r.id)));initialized=true}else if(fresh){known.add(String(fresh.id));sound()}render(data.requests,data.orders,fresh)}catch{localStorage.removeItem('bb-waiter-token');token='';pushInitialized=false;login()}}
queue();setInterval(queue,5000);
