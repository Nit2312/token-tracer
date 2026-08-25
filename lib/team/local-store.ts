/**
 * In-Memory & File Snapshot Fallback Store for Token-Tracer.
 *
 * Automatically provides zero-downtime resilience when Cloud Firestore
 * is paused, exhausts quotas (RESOURCE_EXHAUSTED), or is unreachable.
 */
import fs from 'node:fs';
import path from 'node:path';

type WhereFilterOp =
  | '<'
  | '<='
  | '=='
  | '!='
  | '>='
  | '>'
  | 'array-contains'
  | 'in'
  | 'not-in'
  | 'array-contains-any';

interface Constraint {
  type: 'where' | 'orderBy' | 'limit' | 'limitToLast' | 'startAfter';
  field?: string;
  op?: WhereFilterOp;
  value?: any;
  direction?: 'asc' | 'desc';
  n?: number;
}

const globalStore = globalThis as unknown as {
  _localDbCollections?: Map<string, Map<string, any>>;
  _localDbLoaded?: boolean;
};

function getStore(): Map<string, Map<string, any>> {
  if (!globalStore._localDbCollections) {
    globalStore._localDbCollections = new Map();
    initFallbackStore(globalStore._localDbCollections);
  }
  return globalStore._localDbCollections;
}

function parsePsqlDump(content: string): Record<string, any[]> {
  const collections: Record<string, any[]> = {};
  const sections = content.split(/^###\s+/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const tableName = lines[0].trim();
    if (!tableName || lines.length < 3) continue;

    const headerLine = lines[1];
    const headers = headerLine.split('|').map((h) => h.trim());
    const dataLines = lines.slice(3);
    const records: any[] = [];

    for (const dline of dataLines) {
      if (!dline.trim() || dline.trim().startsWith('(')) continue;
      const parts = dline.split('|').map((p) => p.trim());
      if (parts.length < headers.length) continue;

      const record: Record<string, any> = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        let val: any = parts[i];
        if (val === '' || val === 'null' || val === '<null>') {
          val = null;
        } else if (val === 't' || val === 'true') {
          val = true;
        } else if (val === 'f' || val === 'false') {
          val = false;
        } else if (/^-?\d+$/.test(val)) {
          val = Number(val);
        } else if (/^-?\d+\.\d+$/.test(val)) {
          val = Number(val);
        }
        record[key] = val;
      }
      if (record.id) {
        records.push(record);
      }
    }
    collections[tableName] = records;
  }
  return collections;
}

function initFallbackStore(store: Map<string, Map<string, any>>) {
  const root = process.cwd();
  const dumpPath = path.join(root, 'db_dump.txt');

  if (fs.existsSync(dumpPath)) {
    try {
      const dumpContent = fs.readFileSync(dumpPath, 'utf8');
      const collections = parsePsqlDump(dumpContent);
      for (const [colName, docs] of Object.entries(collections)) {
        const colMap = new Map<string, any>();
        for (const doc of docs) {
          if (doc && doc.id) colMap.set(String(doc.id), { ...doc });
        }
        store.set(colName, colMap);
      }
      console.log(`[local-store] Initialized fallback store with ${Object.keys(collections).length} collections from dump.`);
    } catch (e) {
      console.warn('[local-store] Failed to parse db_dump.txt:', e);
    }
  }
}

export function localGetDoc(collection: string, id: string): any | null {
  const store = getStore();
  const colMap = store.get(collection);
  if (!colMap) return null;
  const doc = colMap.get(id);
  return doc ? { ...doc } : null;
}

export function localSetDoc(collection: string, id: string, data: any, merge = false) {
  const store = getStore();
  if (!store.has(collection)) store.set(collection, new Map());
  const colMap = store.get(collection)!;
  if (merge && colMap.has(id)) {
    colMap.set(id, { ...colMap.get(id), ...data, id });
  } else {
    colMap.set(id, { ...data, id });
  }
}

export function localDeleteDoc(collection: string, id: string) {
  const store = getStore();
  const colMap = store.get(collection);
  if (colMap) colMap.delete(id);
}

export function localQueryCol<T = any>(
  collection: string,
  constraints: Constraint[] = []
): (T & { id: string })[] {
  const store = getStore();
  const colMap = store.get(collection);
  if (!colMap) return [];

  let docs = Array.from(colMap.values()).map((d) => ({ ...d }));

  for (const c of constraints) {
    if (c.type === 'where' && c.field && c.op !== undefined) {
      const { field, op, value } = c;
      docs = docs.filter((d) => {
        const docVal = d[field];
        if (op === '==') return docVal === value;
        if (op === '!=') return docVal !== value;
        if (op === '<') return docVal != null && docVal < value;
        if (op === '<=') return docVal != null && docVal <= value;
        if (op === '>') return docVal != null && docVal > value;
        if (op === '>=') return docVal != null && docVal >= value;
        if (op === 'in') return Array.isArray(value) && value.includes(docVal);
        if (op === 'not-in') return Array.isArray(value) && !value.includes(docVal);
        if (op === 'array-contains') return Array.isArray(docVal) && docVal.includes(value);
        if (op === 'array-contains-any') return Array.isArray(docVal) && Array.isArray(value) && value.some((v) => docVal.includes(v));
        return true;
      });
    } else if (c.type === 'orderBy' && c.field) {
      const field = c.field;
      const asc = (c.direction ?? 'asc') === 'asc';
      docs.sort((a, b) => {
        const va = a[field];
        const vb = b[field];
        if (va === vb) return 0;
        if (va == null) return asc ? -1 : 1;
        if (vb == null) return asc ? 1 : -1;
        if (typeof va === 'string' && typeof vb === 'string') {
          return asc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        return asc ? (va < vb ? -1 : 1) : (va > vb ? -1 : 1);
      });
    }
  }

  // Apply limit
  for (const c of constraints) {
    if (c.type === 'limit' && typeof c.n === 'number' && c.n > 0) {
      docs = docs.slice(0, c.n);
    } else if (c.type === 'limitToLast' && typeof c.n === 'number' && c.n > 0) {
      docs = docs.slice(-c.n);
    }
  }

  return docs as (T & { id: string })[];
}

export function localBatchWrite(
  operations: Array<
    | { type: 'set'; col: string; id: string; data: object; merge?: boolean }
    | { type: 'delete'; col: string; id: string }
  >
) {
  for (const op of operations) {
    if (op.type === 'set') {
      localSetDoc(op.col, op.id, op.data, op.merge);
    } else if (op.type === 'delete') {
      localDeleteDoc(op.col, op.id);
    }
  }
}
