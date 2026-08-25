/**
 * Firestore database adapter — replaces the Neon/pg layer.
 * Exports named helpers used by every consumer in lib/ and app/api/.
 * The schema is schemaless (Firestore auto-creates collections on first write),
 * so ensureSchema() is a no-op kept for API compatibility.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, getApps, cert, deleteApp, App } from 'firebase-admin/app';
import {
  getFirestore,
  Firestore,
  FieldValue,
  WriteBatch,
  DocumentData,
  Query,
  CollectionReference,
  WhereFilterOp,
} from 'firebase-admin/firestore';
import { firebaseProjectId, firebaseServiceAccount } from './env';

// ── Singleton Firestore instance ──────────────────────────────────────────────

const globalForDb = globalThis as unknown as { _firestoreApp: App | undefined };

function getApp(): App {
  if (globalForDb._firestoreApp) return globalForDb._firestoreApp;

  const projectId = firebaseProjectId() || 'token-tracer-97d50';
  const serviceAccountStr = firebaseServiceAccount();

  let serviceAccount: any = null;
  if (serviceAccountStr && !serviceAccountStr.startsWith('<') && serviceAccountStr.trim().startsWith('{')) {
    try {
      serviceAccount = JSON.parse(serviceAccountStr);
    } catch {
      console.warn('[firebase-admin] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON. Trying local key files.');
    }
  }

  if (!serviceAccount && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (fs.existsSync(credPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        if (parsed.type === 'service_account' && parsed.private_key) {
          serviceAccount = parsed;
        }
      } catch {}
    }
  }

  if (!serviceAccount) {
    const searchDirs = [
      process.cwd(),
      path.resolve(process.cwd(), '..'),
      path.resolve(__dirname, '..'),
      path.resolve(__dirname, '../..'),
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.json') && (file.includes('firebase-adminsdk') || file.includes('serviceAccountKey') || file.includes('token-tracer-'))) {
            const fullPath = path.join(dir, file);
            try {
              const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
              if (parsed.type === 'service_account' && parsed.private_key) {
                serviceAccount = parsed;
                if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                  process.env.GOOGLE_APPLICATION_CREDENTIALS = fullPath;
                }
                break;
              }
            } catch {}
          }
        }
        if (serviceAccount) break;
      } catch {}
    }
  }

  if (serviceAccount && typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  // Clean up any previously uncredentialed default apps (e.g. from hot reload)
  const existingApps = getApps();
  if (existingApps.length > 0) {
    if (serviceAccount) {
      // If we have credentials, delete any existing app that was created without credentials
      for (const app of existingApps) {
        try {
          deleteApp(app);
        } catch {}
      }
    } else {
      globalForDb._firestoreApp = existingApps[0];
      return globalForDb._firestoreApp!;
    }
  }

  if (serviceAccount) {
    globalForDb._firestoreApp = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id || projectId,
    });
  } else {
    globalForDb._firestoreApp = initializeApp({
      projectId,
    });
  }

  return globalForDb._firestoreApp;
}

export function getDb(): Firestore {
  return getFirestore(getApp());
}

// ── ensureSchema — no-op (Firestore is schemaless) ───────────────────────────

export async function ensureSchema(): Promise<void> {
  // Firestore collections are created automatically on first write.
  // This function is kept for compatibility with callers that call it explicitly.
}

// ── Collection reference helper ───────────────────────────────────────────────

export function col(name: string): CollectionReference<DocumentData> {
  return getDb().collection(name);
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/** Get a single document by its ID. Returns null if not found. */
export async function getDocById(
  collection: string,
  id: string,
): Promise<DocumentData | null> {
  const snap = await getDb().collection(collection).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

import { statsCache } from './cache';

/** Query a collection with optional where/orderBy/limit constraints. */
export async function queryCol<T = DocumentData>(
  collection: string,
  constraints: Array<
    | { type: 'where'; field: string; op: WhereFilterOp; value: unknown }
    | { type: 'orderBy'; field: string; direction?: 'asc' | 'desc' }
    | { type: 'limit'; n: number }
    | { type: 'limitToLast'; n: number }
    | { type: 'startAfter'; value: unknown }
  > = [],
): Promise<(T & { id: string })[]> {
  let q: Query<DocumentData> = getDb().collection(collection);
  for (const c of constraints) {
    if (c.type === 'where') q = q.where(c.field, c.op, c.value);
    else if (c.type === 'orderBy') q = q.orderBy(c.field, c.direction ?? 'asc');
    else if (c.type === 'limit') q = q.limit(c.n);
    else if (c.type === 'limitToLast') q = q.limitToLast(c.n);
    else if (c.type === 'startAfter') q = (q as any).startAfter(c.value);
  }
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as T & { id: string }));
}

/** Query a collection with automatic in-memory TTL caching to save Firestore reads. */
export async function getCachedCollection<T = DocumentData>(
  collection: string,
  constraints: Parameters<typeof queryCol>[1] = [],
  ttlSeconds = 300,
): Promise<(T & { id: string })[]> {
  const cacheKey = `col_cache_${collection}_${JSON.stringify(constraints || [])}`;
  return statsCache.getOrSet(cacheKey, ttlSeconds, () => queryCol<T>(collection, constraints));
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/** Create or fully overwrite a document. */
export async function setDocById(
  collection: string,
  id: string,
  data: object,
  merge = false,
): Promise<void> {
  await getDb().collection(collection).doc(id).set(
    { ...data, _updatedAt: FieldValue.serverTimestamp() },
    merge ? { merge: true } : {},
  );
}

/** Add a new document with an auto-generated ID. Returns the new doc ID. */
export async function addDocToCol(
  collection: string,
  data: object,
): Promise<string> {
  const ref = await getDb().collection(collection).add({
    ...data,
    _createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Delete a document by ID. */
export async function deleteDocById(collection: string, id: string): Promise<void> {
  await getDb().collection(collection).doc(id).delete();
}

/** Delete all documents matching constraints (fetches then deletes in batch). */
export async function deleteWhere(
  collection: string,
  constraints: Parameters<typeof queryCol>[1],
): Promise<number> {
  const docs = await queryCol<{ id: string }>(collection, constraints);
  if (!docs.length) return 0;
  const batch = getDb().batch();
  for (const d of docs) {
    batch.delete(getDb().collection(collection).doc(d.id));
  }
  await batch.commit();
  return docs.length;
}

/** Atomically execute multiple sets/deletes in a single WriteBatch. */
export async function batchWrite(
  operations: Array<
    | { type: 'set'; col: string; id: string; data: object; merge?: boolean }
    | { type: 'delete'; col: string; id: string }
  >,
): Promise<void> {
  if (!operations.length) return;
  // Firestore limit is 500 ops per batch; chunk if larger
  const chunkSize = 450;
  for (let i = 0; i < operations.length; i += chunkSize) {
    const chunk = operations.slice(i, i + chunkSize);
    const batch: WriteBatch = getDb().batch();
    for (const op of chunk) {
      const ref = getDb().collection(op.col).doc(op.id);
      if (op.type === 'set') {
        batch.set(ref, { ...op.data, _updatedAt: FieldValue.serverTimestamp() }, op.merge ? { merge: true } : {});
      } else {
        batch.delete(ref);
      }
    }
    await batch.commit();
  }
}

// ── UUID generator helper ─────────────────────────────────────────────────────

export function newUuid(): string {
  return crypto.randomUUID();
}
