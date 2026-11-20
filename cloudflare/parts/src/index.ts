/**
 * Konium's parts service's Worker: the requests (handler.ts) and its one Durable Object holding
 * the counts, the answers kept and Digi-Key's token (store.ts) in SQLite.
 */
import { DurableObject } from 'cloudflare:workers';
import { handle, type PartsEnv } from './handler';
import { PartsStoreLogic, type Taken } from './store';

interface Env extends PartsEnv {
  STORE: DurableObjectNamespace<Store>;
}

export class Store extends DurableObject {
  private logic: PartsStoreLogic;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.logic = new PartsStoreLogic(ctx.storage.sql);
  }
  take(day: string, who: string, kind: string, limit: number): Taken { return this.logic.take(day, who, kind, limit); }
  left(day: string, who: string, kind: string, limit: number): number { return this.logic.left(day, who, kind, limit); }
  takeMinute(kind: string, minute: number, limit: number): boolean { return this.logic.takeMinute(kind, minute, limit); }
  answer(key: string, since: number): { at: number; body: unknown } | null { return this.logic.answer(key, since); }
  keep(key: string, at: number, body: unknown): void { this.logic.keep(key, at, body); }
  token(id: string, now: number): string | null { return this.logic.token(id, now); }
  setToken(id: string, value: string, until: number): void { this.logic.setToken(id, value, until); }
  prune(beforeDay: string, beforeAt: number, beforeMinute: number): void { this.logic.prune(beforeDay, beforeAt, beforeMinute); }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = env.STORE.get(env.STORE.idFromName('service'));
    try {
      return await handle(req, env, store);
    } catch (e) {
      console.log(`parts: ${(e as Error)?.stack ?? e}`);
      return new Response(JSON.stringify({ error: 'The Konium parts service had a problem: try again shortly' }), {
        status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      });
    }
  },
};
