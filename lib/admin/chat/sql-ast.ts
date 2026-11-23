/**
 * Deterministic, fail-closed AST validation for LLM-written SQL.
 *
 * The SQL is parsed once by the real PostgreSQL parser (libpg-query, compiled to WASM) and the resulting
 * tree is checked against an explicit allowlist. Nothing here is heuristic: every node type, every field of
 * every node, every operator, function, type and relation must be known, otherwise the query is rejected.
 *
 * This module is intentionally free of `server-only` / path aliases so it can be unit-tested in plain Node.
 * The database (analyst_ro role + column grants) remains the final authority; this is the layer before it.
 */
import { loadModule, parseSync } from 'libpg-query';

export class SqlGuardError extends Error {}

export const MAX_SQL_LENGTH = 6000;
const MAX_DEPTH = 40;
const MAX_NODES = 4000;

let parserReady: Promise<void> | null = null;
/** Load the WASM parser (once per process). Must be awaited before validateSqlAst. */
export function initSqlParser(): Promise<void> {
  if (!parserReady) {
    parserReady = loadModule().catch((e) => {
      parserReady = null; // allow retry; validation stays fail-closed meanwhile
      throw e;
    });
  }
  return parserReady;
}

// ── Allowlists (Sets for O(1) lookup) ───────────────────────────────────────

/** Functions callable from analyst SQL. Unqualified or `pg_catalog.`-qualified only. */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'mode', 'percentile_cont', 'percentile_disc', 'stddev',
  // window
  'row_number', 'rank', 'dense_rank', 'lag', 'lead',
  // date / time
  'now', 'date_trunc', 'date_part', 'extract', 'age', 'timezone', 'to_char',
  // numeric
  'round', 'ceil', 'ceiling', 'floor', 'abs',
  // text
  'lower', 'upper', 'length', 'btrim', 'ltrim', 'rtrim', 'substring', 'split_part', 'replace', 'position',
]);

/** Functions that only make sense with OVER (...) — enforced so the intent of the allowlist is explicit. */
const WINDOW_ONLY = new Set(['row_number', 'rank', 'dense_rank', 'lag', 'lead']);

const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  '+', '-', '*', '/', '%', '=', '<>', '!=', '<', '>', '<=', '>=', '||', '~~', '!~~', '~~*', '!~~*',
]);

const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'text', 'varchar', 'bpchar',
  'date', 'time', 'timestamp', 'timestamptz', 'interval',
]);

const ALLOWED_SQL_VALUE_FUNCS: ReadonlySet<string> = new Set([
  'SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIME', 'SVFOP_CURRENT_TIMESTAMP', 'SVFOP_LOCALTIME', 'SVFOP_LOCALTIMESTAMP',
]);

const ALLOWED_AEXPR_KINDS: ReadonlySet<string> = new Set([
  'AEXPR_OP', 'AEXPR_IN', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_BETWEEN_SYM', 'AEXPR_NOT_BETWEEN_SYM',
  'AEXPR_LIKE', 'AEXPR_ILIKE', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_NULLIF',
]);

// ── Node specs: child fields are walked, scalar fields are type-checked, anything else is rejected ──

interface Spec {
  c?: readonly string[]; // child fields (node or list of nodes)
  s?: readonly string[]; // scalar fields (never objects)
}
const LOC = 'location';
const SPECS: Record<string, Spec> = {
  SelectStmt: {
    c: ['withClause', 'distinctClause', 'targetList', 'fromClause', 'whereClause', 'groupClause', 'havingClause',
      'sortClause', 'limitOffset', 'limitCount', 'larg', 'rarg'],
    s: ['limitOption', 'op', 'all', 'groupDistinct'],
  },
  WithClause: { c: ['ctes'], s: ['recursive', LOC] },
  CommonTableExpr: { c: ['aliascolnames', 'ctequery'], s: ['ctename', 'ctematerialized', LOC] },
  ResTarget: { c: ['val'], s: ['name', LOC] },
  ColumnRef: { c: ['fields'], s: [LOC] },
  String: { s: ['sval'] },
  A_Star: {},
  A_Const: { s: ['ival', 'sval', 'fval', 'boolval', 'bsval', 'isnull', LOC] },
  Integer: { s: ['ival'] },
  Float: { s: ['fval'] },
  Boolean: { s: ['boolval'] },
  A_Expr: { c: ['name', 'lexpr', 'rexpr'], s: ['kind', 'rexpr_list_start', 'rexpr_list_end', LOC] },
  BoolExpr: { c: ['args'], s: ['boolop', LOC] },
  NullTest: { c: ['arg'], s: ['nulltesttype', 'argisrow', LOC] },
  BooleanTest: { c: ['arg'], s: ['booltesttype', LOC] },
  List: { c: ['items'] },
  CaseExpr: { c: ['arg', 'args', 'defresult'], s: [LOC] },
  CaseWhen: { c: ['expr', 'result'], s: [LOC] },
  CoalesceExpr: { c: ['args'], s: [LOC] },
  MinMaxExpr: { c: ['args'], s: ['op', LOC] },
  SQLValueFunction: { s: ['op', 'typmod', LOC] },
  TypeCast: { c: ['arg', 'typeName'], s: [LOC] },
  TypeName: { c: ['names', 'typmods'], s: ['typemod', LOC] },
  FuncCall: {
    c: ['funcname', 'args', 'agg_order', 'agg_filter', 'over'],
    s: ['agg_within_group', 'agg_star', 'agg_distinct', 'funcformat', LOC],
  },
  WindowDef: { c: ['partitionClause', 'orderClause', 'startOffset', 'endOffset'], s: ['frameOptions', LOC] },
  SortBy: { c: ['node'], s: ['sortby_dir', 'sortby_nulls', LOC] },
  SubLink: { c: ['testexpr', 'operName', 'subselect'], s: ['subLinkType', 'subLinkId', LOC] },
  RangeVar: { c: ['alias'], s: ['schemaname', 'relname', 'inh', 'relpersistence', LOC] },
  RangeSubselect: { c: ['subquery', 'alias'], s: ['lateral'] },
  JoinExpr: { c: ['larg', 'rarg', 'usingClause', 'quals'], s: ['jointype', 'isNatural', LOC] },
  Alias: { c: ['colnames'], s: ['aliasname'] },
};

const ALLOWED_JOINS = new Set(['JOIN_INNER', 'JOIN_LEFT']);
const ALLOWED_SUBLINKS = new Set(['EXISTS_SUBLINK', 'ANY_SUBLINK', 'EXPR_SUBLINK']);

// ── Validation ───────────────────────────────────────────────────────────────

export interface AstValidationResult {
  /** Normalized single statement (no trailing semicolon). */
  sql: string;
  /** Names of base tables the query references (before plan verification). */
  tables: string[];
}

interface Ctx {
  allowedTables: ReadonlySet<string>;
  allColumns: ReadonlySet<string>;
  nodes: number;
  cteNames: Set<string>;
  relNames: Set<string>; // unqualified relation names referenced
  qualifiers: Set<string>; // table / alias / cte / subquery names usable as column qualifiers
  declaredCols: Set<string>; // output-column names introduced by the query itself
  colRefs: string[][];
}

const fail = (msg: string): never => {
  throw new SqlGuardError(msg);
};

type Node = Record<string, unknown>;

function strList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((n) => String((n as { String?: { sval?: string } })?.String?.sval ?? ''));
}

function checkScalars(kind: string, body: Node, spec: Spec) {
  for (const k of Object.keys(body)) {
    const isChild = spec.c?.includes(k);
    const isScalar = spec.s?.includes(k);
    if (!isChild && !isScalar) fail(`Unsupported SQL construct (${kind}.${k})`);
    if (isScalar) {
      const v = body[k];
      if (v !== null && typeof v === 'object') {
        // A_Const wraps its value as {ival:{ival:1}} / {sval:{sval:'x'}}; accept only one level of plain scalars.
        const wrapped = kind === 'A_Const' && !Array.isArray(v) && Object.values(v as Node).every((x) => x === null || typeof x !== 'object');
        if (!wrapped) fail(`Unsupported SQL construct (${kind}.${k})`);
      }
    }
  }
}

function walk(node: unknown, ctx: Ctx, depth: number): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, ctx, depth);
    return;
  }
  if (node === null || typeof node !== 'object') return fail('Unexpected parser output');
  if (depth > MAX_DEPTH) fail('SQL is too deeply nested');
  if (++ctx.nodes > MAX_NODES) fail('SQL is too complex');

  const keys = Object.keys(node as Node);
  // Empty object = parser's placeholder for a bare DISTINCT (`distinctClause: [{}]`).
  if (keys.length === 0) return;
  if (keys.length !== 1) return fail('Unexpected parser output');
  visit(keys[0], (node as Node)[keys[0]], ctx, depth);
}

/** Validate one node whose type is known (either from its wrapper key or from IMPLIED_KIND). */
function visit(kind: string, body: unknown, ctx: Ctx, depth: number): void {
  if (depth > MAX_DEPTH) fail('SQL is too deeply nested');
  if (++ctx.nodes > MAX_NODES) fail('SQL is too complex');
  const spec = SPECS[kind];
  if (!spec || body === null || typeof body !== 'object') return fail(`SQL construct not allowed: ${kind}`);
  const b = body as Node;
  if (kind === 'SelectStmt') selectPre(b); // specific messages before the generic unknown-field rejection
  checkScalars(kind, b, spec);

  switch (kind) {
    case 'WithClause':
      if (b.recursive) fail('Recursive CTEs are not allowed');
      break;
    case 'CommonTableExpr':
      ctx.cteNames.add(String(b.ctename));
      ctx.qualifiers.add(String(b.ctename));
      strList(b.aliascolnames).forEach((c) => ctx.declaredCols.add(c));
      break;
    case 'ResTarget': {
      if (typeof b.name === 'string') ctx.declaredCols.add(b.name);
      else implicitName(b.val, ctx);
      break;
    }
    case 'ColumnRef': return checkColumnRef(b, ctx);
    case 'A_Expr': {
      if (!ALLOWED_AEXPR_KINDS.has(String(b.kind))) fail(`Operator form not allowed: ${b.kind}`);
      const names = strList(b.name);
      if (names.length !== 1 || !(ALLOWED_OPERATORS.has(names[0]) || isSyntaxOpName(b, names))) {
        fail(`Operator not allowed: ${names.join('.')}`);
      }
      break;
    }
    case 'SubLink': {
      if (!ALLOWED_SUBLINKS.has(String(b.subLinkType))) fail(`Subquery form not allowed: ${b.subLinkType}`);
      if (b.operName !== undefined) {
        const op = strList(b.operName);
        if (op.length !== 1 || !ALLOWED_OPERATORS.has(op[0])) fail(`Operator not allowed: ${op.join('.')}`);
      }
      break;
    }
    case 'SQLValueFunction':
      if (!ALLOWED_SQL_VALUE_FUNCS.has(String(b.op))) fail(`Function not allowed: ${String(b.op).replace('SVFOP_', '').toLowerCase()}`);
      return;
    case 'TypeName': return checkTypeName(b, ctx, depth);
    case 'FuncCall': return checkFuncCall(b, ctx, depth);
    case 'SortBy':
      break;
    case 'RangeVar': {
      if (b.schemaname !== undefined && b.schemaname !== 'public') fail(`Schema not allowed: ${b.schemaname}`);
      const rel = String(b.relname);
      if (b.schemaname === 'public') {
        if (!ctx.allowedTables.has(rel)) fail(`Table not allowed: ${rel}`);
      } else {
        ctx.relNames.add(rel);
      }
      ctx.qualifiers.add(rel);
      break;
    }
    case 'RangeSubselect':
      if (b.lateral) fail('LATERAL is not allowed');
      if (!b.alias) fail('A subquery in FROM must have an alias');
      break;
    case 'JoinExpr':
      if (!ALLOWED_JOINS.has(String(b.jointype))) fail('Only INNER and LEFT joins are allowed');
      if (b.isNatural) fail('NATURAL joins are not allowed');
      strList(b.usingClause).forEach((c) => ctx.colRefs.push([c]));
      break;
    case 'Alias':
      ctx.qualifiers.add(String(b.aliasname));
      strList(b.colnames).forEach((c) => ctx.declaredCols.add(c));
      return;
    case 'A_Const':
      // A_Const with `isnull` or any scalar is fine; arrays/objects are rejected by checkScalars.
      return;
    case 'String': case 'A_Star': case 'Integer': case 'Float': case 'Boolean':
      return;
    case 'CaseExpr':
      break;
    default:
      break;
  }
  walkFields(b, ctx, depth, spec.c ?? [], kind);
}

/** LIKE/ILIKE/IS DISTINCT/NULLIF/BETWEEN/IN carry kind-specific names ("~~", "=", "BETWEEN", "IS DISTINCT FROM"…). */
function isSyntaxOpName(b: Node, names: string[]): boolean {
  const n = names[0];
  switch (b.kind) {
    case 'AEXPR_BETWEEN': case 'AEXPR_NOT_BETWEEN': case 'AEXPR_BETWEEN_SYM': case 'AEXPR_NOT_BETWEEN_SYM':
      return /^(NOT )?BETWEEN( SYMMETRIC)?$/.test(n);
    case 'AEXPR_IN': return n === '=' || n === '<>';
    case 'AEXPR_LIKE': case 'AEXPR_ILIKE': return ALLOWED_OPERATORS.has(n);
    case 'AEXPR_DISTINCT': case 'AEXPR_NOT_DISTINCT': return n === '=';
    case 'AEXPR_NULLIF': return n === '=';
    default: return false;
  }
}

/** The parser emits some child fields as bare bodies (no `{Type: ...}` wrapper); their type is implied by the field. */
const IMPLIED_KIND: Record<string, string> = {
  'SelectStmt.withClause': 'WithClause', 'SelectStmt.larg': 'SelectStmt', 'SelectStmt.rarg': 'SelectStmt',
  'RangeVar.alias': 'Alias', 'RangeSubselect.alias': 'Alias', 'FuncCall.over': 'WindowDef', 'TypeCast.typeName': 'TypeName',
};

function walkFields(b: Node, ctx: Ctx, depth: number, fields: readonly string[], owner: string) {
  for (const f of fields) {
    const v = b[f];
    if (v === undefined || v === null) continue;
    const implied = IMPLIED_KIND[`${owner}.${f}`];
    if (implied) {
      if (Array.isArray(v) || typeof v !== 'object') fail('Unexpected parser output');
      visit(implied, v, ctx, depth + 1);
    } else walk(v, ctx, depth + 1);
  }
}

function implicitName(val: unknown, ctx: Ctx) {
  const v = val as Node | undefined;
  if (!v || typeof v !== 'object') return;
  if (v.FuncCall) {
    const names = strList((v.FuncCall as Node).funcname);
    if (names.length) ctx.declaredCols.add(names[names.length - 1]);
  } else if (v.CaseExpr) ctx.declaredCols.add('case');
  else if (v.CoalesceExpr) ctx.declaredCols.add('coalesce');
  else if (v.MinMaxExpr) {
    ctx.declaredCols.add('greatest');
    ctx.declaredCols.add('least');
  }
  else if (v.SubLink) ctx.declaredCols.add('exists');
  else if (v.TypeCast) implicitName((v.TypeCast as Node).arg, ctx);
}

function selectPre(b: Node) {
  if (b.intoClause !== undefined) fail('SELECT INTO is not allowed');
  if (b.lockingClause !== undefined) fail('Locking clauses (FOR UPDATE/SHARE) are not allowed');
  if (b.valuesLists !== undefined) fail('VALUES lists are not allowed');
  if (b.windowClause !== undefined) fail('Named WINDOW clauses are not allowed');
  if (b.groupDistinct) fail('GROUP BY DISTINCT is not allowed');
  const op = String(b.op);
  if (op !== 'SETOP_NONE' && op !== 'SETOP_UNION') fail('Only UNION ALL set operations are allowed');
  if (op === 'SETOP_UNION' && b.all !== true) fail('Only UNION ALL is allowed (not UNION)');
  const lim = b.limitOption;
  if (lim !== undefined && lim !== 'LIMIT_OPTION_DEFAULT' && lim !== 'LIMIT_OPTION_COUNT') fail('FETCH ... WITH TIES is not allowed');
}

function checkColumnRef(b: Node, ctx: Ctx) {
  const parts: string[] = [];
  for (const f of (b.fields as Node[]) ?? []) {
    if (f.A_Star) {
      parts.push('*');
    } else if (f.String) {
      checkScalars('String', f.String as Node, SPECS.String);
      parts.push(String((f.String as Node).sval));
    } else fail('Unsupported column reference');
  }
  if (!parts.length || parts.slice(0, -1).includes('*')) fail('Unsupported column reference');
  ctx.colRefs.push(parts);
}

function checkTypeName(b: Node, ctx: Ctx, depth: number) {
  if (b.setof || b.pct_type || b.arrayBounds !== undefined) fail('Type form not allowed');
  const names = strList(b.names);
  const base = names.length === 2 && names[0] === 'pg_catalog' ? names[1] : names.length === 1 ? names[0] : '';
  if (!ALLOWED_TYPES.has(base)) fail(`Type not allowed: ${names.join('.')}`);
  walkFields(b, ctx, depth, ['typmods'], 'TypeName');
}

function checkFuncCall(b: Node, ctx: Ctx, depth: number) {
  const names = strList(b.funcname);
  let name: string;
  if (names.length === 1) name = names[0];
  else if (names.length === 2 && names[0] === 'pg_catalog') name = names[1];
  else return fail(`Function not allowed: ${names.join('.')}`);
  if (!ALLOWED_FUNCTIONS.has(name)) fail(`Function not allowed: ${names.join('.')}`);
  if (b.func_variadic) fail('VARIADIC is not allowed');
  if (WINDOW_ONLY.has(name) && !b.over) fail(`${name}() requires an OVER clause`);
  const over = b.over as Node | undefined;
  if (over && (over.name !== undefined || over.refname !== undefined)) fail('Named windows are not allowed');
  walkFields(b, ctx, depth, ['args', 'agg_order', 'agg_filter', 'over'], 'FuncCall');
}

/** Single-pass deferred checks that need the full set of declared names. */
function resolveDeferred(ctx: Ctx) {
  for (const rel of ctx.relNames) {
    if (!ctx.allowedTables.has(rel) && !ctx.cteNames.has(rel)) fail(`Table not allowed: ${rel}`);
  }
  for (const parts of ctx.colRefs) {
    const col = parts[parts.length - 1];
    if (parts.length === 1) {
      if (col !== '*' && !ctx.allColumns.has(col) && !ctx.declaredCols.has(col)) {
        fail(`Column not allowed: ${col}`);
      }
      continue;
    }
    if (parts.length > 3) fail('Unsupported column reference');
    if (parts.length === 3) {
      if (parts[0] !== 'public') fail(`Schema not allowed: ${parts[0]}`);
      if (!ctx.allowedTables.has(parts[1])) fail(`Table not allowed: ${parts[1]}`);
    } else if (!ctx.qualifiers.has(parts[0])) {
      fail(`Unknown table or alias: ${parts[0]}`);
    }
    if (col !== '*' && !ctx.allColumns.has(col) && !ctx.declaredCols.has(col)) fail(`Column not allowed: ${col}`);
  }
}

/**
 * Parse and validate `raw`. Throws SqlGuardError on anything that is not a single, allowlisted,
 * read-only SELECT. Any unexpected exception is converted to a rejection (fail-closed).
 */
export function validateSqlAst(raw: string, grants: Record<string, readonly string[]>): AstValidationResult {
  try {
    if (typeof raw !== 'string' || !raw.trim()) throw new SqlGuardError('SQL is empty');
    if (raw.length > MAX_SQL_LENGTH) throw new SqlGuardError('SQL is too long');
    const sql = raw.trim().replace(/;+\s*$/, '');
    if (/--|\/\*|\*\//.test(sql)) throw new SqlGuardError('SQL comments are not allowed');

    let tree;
    try {
      tree = parseSync(sql);
    } catch (e) {
      if (e instanceof Error && /not.*(loaded|initiali)/i.test(e.message)) throw new SqlGuardError('SQL parser is not ready');
      throw new SqlGuardError(`SQL syntax error: ${(e as Error).message}`);
    }
    const stmts = tree?.stmts;
    if (!Array.isArray(stmts) || stmts.length === 0) throw new SqlGuardError('Unexpected parser output');
    if (stmts.length !== 1) throw new SqlGuardError('Only a single statement is allowed');
    const stmt = stmts[0]?.stmt as Node | undefined;
    if (!stmt || typeof stmt !== 'object') throw new SqlGuardError('Unexpected parser output');
    const top = Object.keys(stmt);
    if (top.length !== 1 || top[0] !== 'SelectStmt') {
      throw new SqlGuardError(`Only SELECT queries are allowed (got ${top[0] ?? 'nothing'})`);
    }

    const allowedTables = new Set(Object.keys(grants));
    const allColumns = new Set<string>();
    for (const cols of Object.values(grants)) cols.forEach((c) => allColumns.add(c));
    const ctx: Ctx = {
      allowedTables, allColumns, nodes: 0, cteNames: new Set(), relNames: new Set(),
      qualifiers: new Set(), declaredCols: new Set(), colRefs: [],
    };
    walk(stmt, ctx, 0);
    resolveDeferred(ctx);
    return { sql, tables: [...ctx.relNames].filter((r) => allowedTables.has(r)) };
  } catch (err) {
    if (err instanceof SqlGuardError) throw err;
    throw new SqlGuardError('SQL could not be validated'); // fail closed on any unexpected exception
  }
}
