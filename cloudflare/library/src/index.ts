/**
 * The world parts library's Worker: the requests (handler.ts), its one Durable Object holding
 * the counts, the sign-ins under way, the contributors and the parts' index (store.ts) in SQLite,
 * and one Durable Object for each company that has a library of its own (org.ts).
 */
import { DurableObject } from 'cloudflare:workers';
import { handle, type LibraryEnv } from './handler';
import { LibraryStoreLogic, type Contributor, type Indexed, type SignIn, type Taken } from './store';
import { OrgStoreLogic, type OrgFile, type OrgStored } from './org';
import type { OrgRole } from '../../../src/model/worldLibrary';

interface Env extends LibraryEnv {
  STORE: DurableObjectNamespace<Store>;
  ORGS: DurableObjectNamespace<Org>;
}

/** A company's own library: its members, its parts and what happened in it. One for each domain. */
export class Org extends DurableObject {
  private logic: OrgStoreLogic;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.logic = new OrgStoreLogic(ctx.storage.sql);
  }
  info() { return this.logic.info(); }
  member(email: string, now: number) { return this.logic.member(email, now); }
  members() { return this.logic.members(); }
  claim(email: string, now: number) { return this.logic.claim(email, now); }
  invite(email: string, role: OrgRole, by: string, now: number) { return this.logic.invite(email, role, by, now); }
  remove(email: string, by: string, now: number) { return this.logic.remove(email, by, now); }
  parts() { return this.logic.parts(); }
  part(key: string) { return this.logic.part(key); }
  partFile(key: string, file: OrgFile, who: string, now: number) { return this.logic.partFile(key, file, who, now); }
  putPart(p: Omit<OrgStored, 'revision'>, who: string, now: number) { return this.logic.putPart(p, who, now); }
  dropPart(key: string, who: string, now: number) { return this.logic.dropPart(key, who, now); }
  audit(limit?: number) { return this.logic.audit(limit); }
  take(period: string, kind: string, limit: number): Taken { return this.logic.take(period, kind, limit); }
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
      return await handle(req, env, store, fetch, Date.now(), (domain) => env.ORGS.get(env.ORGS.idFromName(domain)));
    } catch (e) {
      console.log(`library: ${(e as Error)?.stack ?? e}`);
      return new Response(JSON.stringify({ error: 'The parts library had a problem: try again shortly' }), {
        status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      });
    }
  },
};
