export type Listener<T> = (v: T) => void;

export class Emitter<T = void> {
  private ls = new Set<Listener<T>>();
  on(l: Listener<T>): () => void { this.ls.add(l); return () => this.ls.delete(l); }
  emit(v: T): void { for (const l of [...this.ls]) l(v); }
}
