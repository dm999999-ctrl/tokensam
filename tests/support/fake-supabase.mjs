// Minimal in-memory stand-in for the Supabase query builder calls used by the
// collectors, persistence, metrics runner, and refresh store. Not a general
// PostgREST emulator: it implements only what this codebase calls.

const IDENTITY_TABLES = new Set([
  "raw_provider_records", "token_metric_observations", "calculated_metric_observations",
  "data_refresh_runs", "data_refresh_steps", "token_ai_analyses",
]);
const VIEWS = {
  latest_token_metric_observations: { source: "token_metric_observations", key: ["token_id", "provider_id", "metric_id"], order: ["observed_at", "collected_at", "id"] },
  latest_raw_provider_records: { source: "raw_provider_records", key: ["provider_id", "token_id", "chain_id"], order: ["collected_at", "id"] },
};

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "string" && typeof b === "string") {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (Number.isFinite(da) && Number.isFinite(db) && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) return da - db;
    return a < b ? -1 : 1;
  }
  return a < b ? -1 : 1;
}

export function createFakeSupabase({ seed = {}, views = true, missingTables = [] } = {}) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const nextId = new Map();
  const calls = [];
  for (const [name, rows] of tables) nextId.set(name, rows.reduce((max, row) => Math.max(max, row.id ?? 0), 0) + 1);

  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  function viewRows(name) {
    const view = VIEWS[name];
    const latest = new Map();
    const sorted = [...rowsOf(view.source)].filter((row) => !row.excluded_reason).sort((a, b) => {
      for (const column of view.order) {
        const result = compare(b[column], a[column]);
        if (result) return result;
      }
      return 0;
    });
    for (const row of sorted) {
      const key = view.key.map((column) => row[column]).join("|");
      if (!latest.has(key)) latest.set(key, { ...row });
    }
    return [...latest.values()];
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.orders = [];
      this.returning = false;
      this.mode = "many";
      this.from = null;
      this.to = null;
      this.limitCount = null;
      this.head = false;
    }
    select(_columns, options = {}) {
      if (this.op === "select") this.head = Boolean(options.head);
      else this.returning = true;
      return this;
    }
    insert(rows) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, options = {}) { this.op = "upsert"; this.payload = Array.isArray(rows) ? rows : [rows]; this.conflict = options.onConflict?.split(","); return this; }
    update(values) { this.op = "update"; this.values = values; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    gte(column, value) { this.filters.push((row) => compare(row[column], value) >= 0); return this; }
    lte(column, value) { this.filters.push((row) => compare(row[column], value) <= 0); return this; }
    lt(column, value) { this.filters.push((row) => compare(row[column], value) < 0); return this; }
    is(column, value) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
    order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
    range(from, to) { this.from = from; this.to = to; return this; }
    limit(count) { this.limitCount = count; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.execute()).then(resolve, reject); }

    execute() {
      calls.push({ table: this.table, op: this.op });
      if (missingTables.includes(this.table)) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}'` } };
      if (VIEWS[this.table]) {
        if (!views) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}'` } };
        return this.finish(viewRows(this.table).filter((row) => this.filters.every((filter) => filter(row))));
      }
      const rows = rowsOf(this.table);
      if (this.op === "insert") {
        if (this.table === "data_refresh_runs" && this.payload.some((row) => row.status === "running")
          && rows.some((row) => row.status === "running")) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const inserted = this.payload.map((row) => this.withId(row));
        rows.push(...inserted);
        return this.finish(inserted.map((row) => ({ ...row })), true);
      }
      if (this.op === "upsert") {
        for (const row of this.payload) {
          const existing = this.conflict ? rows.find((candidate) => this.conflict.every((column) => candidate[column] === row[column])) : undefined;
          if (existing) Object.assign(existing, row);
          else rows.push(this.withId(row));
        }
        return { data: null, error: null };
      }
      if (this.op === "update") {
        for (const row of rows.filter((candidate) => this.filters.every((filter) => filter(candidate)))) Object.assign(row, this.values);
        return { data: null, error: null };
      }
      return this.finish(rows.filter((row) => this.filters.every((filter) => filter(row))).map((row) => ({ ...row })));
    }
    withId(row) {
      const copy = { ...row };
      if (IDENTITY_TABLES.has(this.table) && copy.id === undefined) {
        copy.id = nextId.get(this.table) ?? 1;
        nextId.set(this.table, copy.id + 1);
      }
      return copy;
    }
    finish(rows, mutation = false) {
      if (mutation && !this.returning) return { data: null, error: null };
      let result = [...rows];
      if (this.orders.length) {
        result.sort((a, b) => {
          for (const { column, ascending } of this.orders) {
            const value = compare(a[column], b[column]);
            if (value) return ascending ? value : -value;
          }
          return 0;
        });
      }
      if (this.from !== null) result = result.slice(this.from, this.to + 1);
      if (this.limitCount !== null) result = result.slice(0, this.limitCount);
      if (this.head) return { data: null, error: null, count: result.length };
      if (this.mode === "single") return result.length === 1 ? { data: result[0], error: null } : { data: null, error: { code: "PGRST116", message: "Expected one row" } };
      if (this.mode === "maybe") return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
  }

  return {
    client: { from: (table) => new Query(table) },
    rows: (table) => rowsOf(table),
    calls,
  };
}
