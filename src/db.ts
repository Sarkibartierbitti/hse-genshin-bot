import type { DBValue } from './types.js';

/** Small bound-parameter wrapper, shared by production D1 and the SQLite test binding. */
export class Database {
  constructor(private readonly binding: D1Database) {}

  get<T>(sql: string, params: DBValue[] = []): Promise<T | null> {
    return this.binding.prepare(sql).bind(...params).first<T>();
  }

  async all<T>(sql: string, params: DBValue[] = []): Promise<T[]> {
    const result = await this.binding.prepare(sql).bind(...params).all<T>();
    return result.results ?? [];
  }

  run(sql: string, params: DBValue[] = []): Promise<D1Result> {
    return this.binding.prepare(sql).bind(...params).run();
  }

  batch(statements: { sql: string; params?: DBValue[] }[]): Promise<D1Result[]> {
    if (statements.length === 0) return Promise.resolve([]);
    return this.binding.batch(statements.map(({ sql, params = [] }) => this.binding.prepare(sql).bind(...params)));
  }
}
