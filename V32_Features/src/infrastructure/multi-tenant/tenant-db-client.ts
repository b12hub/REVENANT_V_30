// tenant-db-client.ts
//
// The mechanism that makes "forgetting a WHERE tenant_id = X clause"
// structurally impossible to write, rather than a discipline developers
// have to remember. See the two architectural notes below the imports for
// the two distinct, real failure modes this design exists to close.

import { getTenantContext, isValidTenantIdentifier, type Environment } from './tenant-context.js';

// ---------------------------------------------------------------------------
// Minimal mock interfaces standing in for the real `pg` library's Pool/
// PoolClient shapes. A production implementation satisfies these same two
// interfaces with the real `pg.Pool` — `pg.Pool.connect()` already returns
// something structurally compatible with PgPoolClientLike below.
// ---------------------------------------------------------------------------

export interface QueryResultLike<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface PgPoolClientLike {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResultLike<Row>>;
  release(err?: Error): void;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

// ---------------------------------------------------------------------------
// Postgres literal-safety helpers. Two DIFFERENT escaping rules — these
// are not interchangeable, and using the wrong one for the wrong slot is
// itself a real, common mistake worth being explicit about:
//   - Identifiers (schema/table/column names) are quoted with DOUBLE
//     quotes; an embedded double-quote is escaped by doubling it.
//   - String literals (ordinary VALUES) are quoted with SINGLE quotes; an
//     embedded single-quote is escaped by doubling IT.
// Both are applied here even though isValidTenantIdentifier() already
// makes injection via tenantId structurally impossible (the regex forbids
// quote characters entirely) — this is deliberate defense in depth, the
// same layered-defense philosophy used throughout this codebase (e.g. the
// Gateway's pino redact config existing ALONGSIDE the dedicated redacted
// log line, not instead of it).
// ---------------------------------------------------------------------------

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function escapePostgresStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Schema resolution incorporates BOTH tenantId and environment — not
 * tenantId alone. This is a deliberate design decision beyond the literal
 * spec: a bank's sandbox/integration-testing traffic must never be able
 * to read or write into the same schema as that same bank's production
 * data. Without this, `environment` would be context data carried for no
 * purpose; with it, the field actually enforces something real.
 */
function resolveSchemaName(tenantId: string, environment: Environment): string {
  if (!isValidTenantIdentifier(tenantId)) {
    // Re-validated here, immediately before use, independent of whatever
    // validation happened when the context was first established — see
    // the file header note on why this isn't redundant.
    throw new Error(`Refusing to construct a schema name from invalid tenant identifier: "${tenantId}".`);
  }
  return environment === 'sandbox' ? `tenant_${tenantId}_sandbox` : `tenant_${tenantId}`;
}

/** Loose hygiene bound on traceId for the observability GUC below — lower stakes than tenantId's validation, since a malformed traceId can corrupt a log correlation at worst, never grant schema access. Still bounded and quote-escaped rather than trusted blindly. */
const TRACE_ID_SANITY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Narrowed interface exposed to a transaction() callback — deliberately
 * NOT the full PgPoolClientLike. A caller-supplied transaction function
 * has no business calling .release() itself (that would break the
 * checkout/release invariant this class maintains) or acquiring a SECOND
 * connection mid-transaction (which would silently run outside the
 * SET LOCAL schema scope already established on the first one).
 */
export interface TenantScopedClient {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResultLike<Row>>;
}

export class TenantAwareDatabaseProxy {
  constructor(private readonly pool: PgPoolLike) {}

  /**
   * Single-statement convenience method. Internally wraps the developer's
   * SQL in its own dedicated transaction — see the class-level
   * architectural note above this method's implementation for why that's
   * load-bearing, not incidental.
   */
  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<Row>> {
    return this.transaction((client) => client.query<Row>(sql, params));
  }

  /**
   * Multi-statement transaction support. Everything inside `fn` runs
   * against the SAME single checked-out connection, inside ONE BEGIN/
   * COMMIT — so a caller composing several queries that must be
   * atomically consistent with each other gets that for free, on top of
   * (not instead of) the tenant-isolation guarantee.
   *
   * THE CENTRAL ARCHITECTURAL GUARANTEE OF THIS WHOLE FILE:
   *
   * 1. `pool.connect()` checks out ONE specific physical connection,
   *    exclusively, for the lifetime of this call.
   * 2. `SET LOCAL search_path` is issued on THAT SAME connection,
   *    inside an explicit transaction — `SET LOCAL` (not `SET`) is
   *    transaction-scoped and is GUARANTEED by Postgres itself to revert
   *    automatically at COMMIT or ROLLBACK, regardless of how the
   *    transaction ends. This is what makes it safe to hand the
   *    connection back to a shared pool afterward: there is no manual
   *    "remember to reset search_path" step for a developer to forget,
   *    because the database guarantees the reset, not application code.
   * 3. The developer's actual query runs on that exact same connection,
   *    inside that exact same transaction — never via a second,
   *    independent `pool.query()` call, which COULD silently land on a
   *    DIFFERENT physical connection from the pool than the one the SET
   *    ran on. That mismatch is the single most dangerous version of this
   *    bug class: a query that appears to have set its schema correctly,
   *    but actually executes against whatever schema the connection it
   *    happened to land on was left in by a PREVIOUS, unrelated tenant's
   *    request.
   * 4. `release()` runs in a `finally` block — the connection always goes
   *    back to the pool, on success OR failure, so a thrown error never
   *    leaks a connection out of the pool permanently.
   *
   * Net effect for a developer using this class: there is no `WHERE
   * tenant_id = $1` to remember, because there is no SHARED table row
   * space to filter at all — `search_path` makes an unqualified `SELECT *
   * FROM users` resolve against `tenant_alpha.users`, a table that
   * doesn't even contain any OTHER tenant's rows. The isolation is
   * structural (separate schemas), not row-level discipline (a WHERE
   * clause a developer could forget to write).
   */
  async transaction<T>(fn: (client: TenantScopedClient) => Promise<T>): Promise<T> {
    const context = getTenantContext(); // synchronous, fail-closed — throws MissingTenantContextError if absent

    const schemaName = resolveSchemaName(context.tenantId, context.environment);
    const quotedSchema = quotePostgresIdentifier(schemaName);

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${quotedSchema};`);

      // Observability enhancement, not a security boundary: tags every
      // query in this transaction with the originating trace_id via a
      // custom GUC, queryable from Postgres' own slow-query log /
      // pg_stat_activity for correlating a slow query back to the request
      // that caused it. Consistent with this platform's established
      // treatment of trace_id propagation as load-bearing everywhere, not
      // an afterthought.
      if (TRACE_ID_SANITY_PATTERN.test(context.traceId)) {
        const escapedTraceId = escapePostgresStringLiteral(context.traceId);
        await client.query(`SET LOCAL "revenant.trace_id" = '${escapedTraceId}';`);
      }

      const scopedClient: TenantScopedClient = {
        query: (sql, params) => client.query(sql, params),
      };

      const result = await fn(scopedClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // Swallowed deliberately: if ROLLBACK itself fails (e.g. the
        // connection already dropped), the ORIGINAL error from `fn` or
        // from BEGIN/SET LOCAL is what should propagate — a failed
        // rollback attempt shouldn't mask the real failure that caused it.
      });
      throw err;
    } finally {
      client.release();
    }
  }
}