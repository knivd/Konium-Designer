/**
 * The Konium AI service's Worker: the requests (handler.ts) and its one Durable Object holding the
 * day's counts, the day's spend and the shared cache (store.ts) in SQLite.
 */
import { DurableObject } from 'cloudflare:workers';
import { handle, type AiEnv } from './handler';
import { StoreLogic, type Cached, type Taken } from './store';

interface Env extends AiEnv {
  STORE: DurableObjectNamespace<Store>;
}

export class Store extends DurableObject {
  private logic: StoreLogic;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.logic = new StoreLogic(ctx.storage.sql);
  }
  take(day: string, client: string, kind: string, limit: number, units?: number): Taken { return this.logic.take(day, client, kind, limit, units); }
  left(day: string, client: string, kind: string, limit: number): number { return this.logic.left(day, client, kind, limit); }
  spent(day: string): number { return this.logic.spent(day); }
  spend(day: string, usd: number): void { this.logic.spend(day, usd); }
  reserve(day: string, usd: number, budget: number): boolean { return this.logic.reserve(day, usd, budget); }
  settle(day: string, delta: number): void { this.logic.settle(day, delta); }
  cached(key: string): Cached | null { return this.logic.cached(key); }
  accept(key: string, client: string, answer: unknown, now: number): void { this.logic.accept(key, client, answer, now); }
  prune(before: string): void { this.logic.prune(before); }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = env.STORE.get(env.STORE.idFromName('service'));
    try {
      return await handle(req, env, store);
    } catch (e) {
      console.log(`ai: ${(e as Error)?.stack ?? e}`);
      return new Response(JSON.stringify({ error: 'The Konium service had a problem: try again shortly' }), {
        status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      });
    }
  },
};
