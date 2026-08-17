import crypto from 'node:crypto';

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);

export const normalizeBridgeEmployee = (value) => {
  const id = text(value?.id, 160);
  const displayName = text(value?.displayName, 200);
  if (!id || !displayName) throw Object.assign(new Error('Некорректная запись сотрудника iikoFront'), { status: 400 });
  return {
    id,
    displayName,
    firstName: text(value?.firstName, 100),
    middleName: text(value?.middleName, 100),
    lastName: text(value?.lastName, 100),
    roleIds: [...new Set((Array.isArray(value?.roleIds) ? value.roleIds : []).map((item) => text(item, 160)).filter(Boolean))].slice(0, 100),
    roleNames: [...new Set((Array.isArray(value?.roleNames) ? value.roleNames : []).map((item) => text(item, 160)).filter(Boolean))].slice(0, 100),
    isActive: value?.isActive !== false,
  };
};

export const validateEmployeeSnapshot = (value) => {
  if (!Array.isArray(value) || value.length > 5_000) throw Object.assign(new Error('Некорректный список сотрудников iikoFront'), { status: 400 });
  const employees = value.map(normalizeBridgeEmployee);
  if (new Set(employees.map((employee) => employee.id)).size !== employees.length) throw Object.assign(new Error('Список сотрудников iikoFront содержит дубликаты'), { status: 400 });
  return employees;
};

export class BridgeConnectionRegistry {
  constructor() {
    this.connections = new Map();
    this.pending = new Map();
  }

  register(connection) {
    this.connections.set(connection.bridgeId, connection);
  }

  unregister(bridgeId, socket) {
    const connection = this.connections.get(bridgeId);
    if (!connection || connection.socket !== socket) return;
    this.connections.delete(bridgeId);
    for (const [requestId, pending] of this.pending) {
      if (pending.bridgeId !== bridgeId) continue;
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('iikoFront Bridge отключился'), { status: 503 }));
      this.pending.delete(requestId);
    }
  }

  connectedForRestaurant(restaurantId) {
    return [...this.connections.values()].filter((connection) => connection.restaurantId === restaurantId && connection.socket.readyState === 1);
  }

  disconnect(bridgeId) {
    const connection = this.connections.get(bridgeId);
    if (!connection) return false;
    try { connection.socket.close(1008, 'Bridge access revoked'); } catch { }
    this.unregister(bridgeId, connection.socket);
    return true;
  }

  requestAuthentication(restaurantId, pin, timeoutMs = 8_000) {
    const connection = this.connectedForRestaurant(restaurantId).sort((a, b) => b.connectedAt - a.connectedAt)[0];
    if (!connection) return Promise.reject(Object.assign(new Error('Нет связи с iikoFront. Обратитесь к администратору'), { status: 503 }));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error('iikoFront не ответил вовремя'), { status: 504 }));
      }, timeoutMs);
      this.pending.set(requestId, { bridgeId: connection.bridgeId, resolve, reject, timer });
      try { connection.socket.send(JSON.stringify({ type: 'auth_request', requestId, pin })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(Object.assign(new Error('Не удалось отправить запрос в iikoFront'), { status: 503, cause: error }));
      }
    });
  }

  resolveAuthentication(message, bridgeId) {
    const requestId = text(message?.requestId, 100);
    const pending = this.pending.get(requestId);
    if (!pending || pending.bridgeId !== bridgeId) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (message.ok === true) pending.resolve({ ok: true, employee: normalizeBridgeEmployee(message.employee) });
    else pending.resolve({ ok: false, error: text(message.error, 200) || 'Неверный PIN-код' });
    return true;
  }
}
