/**
 * The world parts library's Worker: the requests (handler.ts) and its one Durable Object holding
 * the counts, the sign-ins under way, the contributors and the parts' index (store.ts) in SQLite.
 */
import { DurableObject } from 'cloudflare:workers';
import { handle, type LibraryEnv } from './handler';
import { LibraryStoreLogic, type Contributor, type Indexed, type SignIn, type Taken } from './store';

interface Env extends LibraryEnv {
  STORE: DurableObjectNamespace<Store>;
}

export class Store extends DurableObject {
  private logic: LibraryStoreLogic;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.logic = new LibraryStoreLogic(ctx.storage.sql);
  }
  take(period: string, who: string, kind: string, limit: number): Taken { return this.logic.take(period, who, kind, limit); }
  startSignIn(s: SignIn): void { this.logic.startSignIn(s); }
  signIn(id: string): SignIn | null { return this.logic.signIn(id); }
  confirmSignIn(id: string): void { this.logic.confirmSignIn(id); }
  endSignIn(id: string): void { this.logic.endSignIn(id); }
  contributor(uid: string): Contributor | null { return this.logic.contributor(uid); }
  keepContributor(uid: string, email: string, name: string | null, now: number, client?: string | null): void { this.logic.keepContributor(uid, email, name, now, client ?? null); }
  part(key: string): Indexed | null { return this.logic.part(key); }
  keepPart(p: Indexed): void { this.logic.keepPart(p); }
  partCount(): number { return this.logic.partCount(); }
  prune(beforePeriod: string, now: number): void { this.logic.prune(beforePeriod, now); }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = env.STORE.get(env.STORE.idFromName('library'));
    try {
      return await handle(req, env, store);
    } catch (e) {
      console.log(`library: ${(e as Error)?.stack ?? e}`);
      return new Response(JSON.stringify({ error: 'The parts library had a problem: try again shortly' }), {
        status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      });
    }
  },
};
