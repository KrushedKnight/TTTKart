// Tiny global event bus. Node-safe.
//   import { bus } from './bus.js';
//   const off = bus.on('kart:hop', (e) => { ... });   // returns an unsubscribe fn
//   bus.emit('kart:hop', { kart });
// Listeners are called synchronously in subscription order. A throwing
// listener is logged and does not stop the others.

class EventBus {
  constructor() { this._map = new Map(); }

  on(type, fn) {
    let list = this._map.get(type);
    if (!list) { list = []; this._map.set(type, list); }
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (e) => { off(); fn(e); });
    return off;
  }

  off(type, fn) {
    const list = this._map.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, data = {}) {
    const list = this._map.get(type);
    if (list && list.length) {
      for (const fn of list.slice()) {
        try { fn(data, type); } catch (err) { console.error(`[bus] listener for "${type}" threw`, err); }
      }
    }
    const any = this._map.get('*');
    if (any && any.length) {
      for (const fn of any.slice()) {
        try { fn(data, type); } catch (err) { console.error('[bus] wildcard listener threw', err); }
      }
    }
  }

  clear() { this._map.clear(); }
}

export const bus = new EventBus();
export { EventBus };
