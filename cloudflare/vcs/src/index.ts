/**
 * Konium's version control Worker: the requests (handler.ts) and its one Durable Object holding
 * the team store's ledger (ledger.ts) in SQLite.
 */
import { DurableObject } from 'cloudflare:workers';
import { handle, type Env as HandlerEnv } from './handler';
import { LedgerLogic, type Room, type Taken } from './ledger';

interface Env extends HandlerEnv {
  LEDGER: DurableObjectNamespace<Ledger>;
}

export class Ledger extends DurableObject {
  private logic: LedgerLogic;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.logic = new LedgerLogic(ctx.storage.sql);
  }
  team(team: string): number | null { return this.logic.team(team); }
  enter(team: string, bytes: number, now: number): void { this.logic.enter(team, bytes, now); }
  reserve(team: string, delta: number, maxTeam: number, maxStore: number, now: number): Room { return this.logic.reserve(team, delta, maxTeam, maxStore, now); }
  release(team: string, delta: number): void { this.logic.release(team, delta); }
  take(day: string, who: string, kind: string, limit: number, units?: number): Taken { return this.logic.take(day, who, kind, limit, units); }
  prune(beforeDay: string): void { this.logic.prune(beforeDay); }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env, fetch, env.LEDGER.get(env.LEDGER.idFromName('store')));
    } catch (e) {
      console.log(`vcs: ${(e as Error)?.stack ?? e}`);
      return new Response(JSON.stringify({ error: 'Konium\'s store had a problem: try again shortly' }), {
        status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      });
    }
  },
};
