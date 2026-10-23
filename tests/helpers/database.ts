import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/db.js';
import type { DBValue } from '../../src/types.js';

type TestResult<T> = { success: true; results: T[]; meta: Record<string, string | number | boolean> };

class SQLitePreparedStatement {
  constructor(readonly sqlite: DatabaseSync, readonly sql: string, readonly params: DBValue[] = []) {}

  bind(...params: DBValue[]): SQLitePreparedStatement {
    return new SQLitePreparedStatement(this.sqlite, this.sql, params);
  }

  execute<T>(): TestResult<T> {
    const before = this.sqlite.prepare('SELECT total_changes() AS count').get() as { count: number };
    const rows = this.sqlite.prepare(this.sql).all(...this.params) as T[];
    const after = this.sqlite.prepare('SELECT total_changes() AS count, last_insert_rowid() AS last_id').get() as { count: number; last_id: number };
    const changes = after.count - before.count;
    // Plain records make equality assertions match D1 JSON results instead of SQLite's null prototypes.
    const results = rows.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>))) as T[];
    return {
      success: true,
      results,
      meta: {
        changes, last_row_id: after.last_id, changed_db: changes > 0,
        duration: 0, size_after: 0, rows_read: rows.length, rows_written: changes, served_by: 'sqlite-test',
      },
    };
  }

  async all<T>(): Promise<TestResult<T>> { return this.execute<T>(); }
  async run<T>(): Promise<TestResult<T>> { return this.execute<T>(); }

  async first<T>(columnName?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>().results[0];
    if (!row) return null;
    if (columnName === undefined) return row as T;
    if (!(columnName in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${columnName}`);
    return row[columnName] as T;
  }

  async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.sqlite.prepare(this.sql);
    const columnNames = stmt.columns().map(column => column.name);
    const rows = this.execute<Record<string, unknown>>().results;
    const result = rows.map(row => columnNames.map(name => row[name]));
    if (options?.columnNames) result.unshift(columnNames);
    return result as T[];
  }
}

/** Real SQLite, bound parameters, constraints, migrations, RETURNING and atomic D1.batch semantics. */
export function createTestDatabase(): { db: Database; binding: D1Database; close: () => void } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url).href);
  try {
    for (const migration of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(`${migrations}/${migration}`, 'utf8'));
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const binding = {
    prepare(sql: string): SQLitePreparedStatement { return new SQLitePreparedStatement(sqlite, sql); },
    async batch<T>(statements: SQLitePreparedStatement[]): Promise<TestResult<T>[]> {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute<T>());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
  return { binding, db: new Database(binding), close: () => sqlite.close() };
}
