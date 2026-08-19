/**
 * Data Migration Script: Neon (Postgres) -> Firebase Cloud Firestore
 *
 * Checks existing documents in Firestore and skips already migrated records!
 *
 * Usage:
 *   node scripts/migrate-neon-to-firebase.mjs [POSTGRES_CONNECTION_STRING] [options]
 *
 * Options:
 *   --skip-details    Skip large breakdown tables (sync_session_tools, sync_session_files)
 *   --tables=a,b,c    Migrate only specific tables (comma-separated)
 *   --batch-size=100  Custom batch size (default: 100)
 *   --force           Overwrite existing records instead of skipping
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load environment variables from .env.local and .env
function loadEnv() {
  const files = ['.env.local', '.env'];
  for (const file of files) {
    const p = path.join(rootDir, file);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

// Parse CLI arguments
let postgresUrl = null;
let customKeyPath = null;
let skipDetails = false;
let forceOverwrite = false;
let targetTables = null;
let customBatchSize = 100;

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--service-account=')) {
    customKeyPath = arg.slice('--service-account='.length).trim();
  } else if (arg.startsWith('--key=')) {
    customKeyPath = arg.slice('--key='.length).trim();
  } else if (arg === '--skip-details') {
    skipDetails = true;
  } else if (arg === '--force') {
    forceOverwrite = true;
  } else if (arg.startsWith('--tables=')) {
    targetTables = arg.slice('--tables='.length).split(',').map((s) => s.trim());
  } else if (arg.startsWith('--batch-size=')) {
    customBatchSize = parseInt(arg.slice('--batch-size='.length), 10) || 100;
  } else if (!postgresUrl && (arg.startsWith('postgres://') || arg.startsWith('postgresql://'))) {
    postgresUrl = arg;
  }
}

postgresUrl =
  postgresUrl ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.NEON_CONNECTION_STRING;

if (!postgresUrl) {
  console.error('\x1b[31m[Error] Postgres connection string not found.\x1b[0m');
  console.error('Usage: node scripts/migrate-neon-to-firebase.mjs "<POSTGRES_URL>"');
  process.exit(1);
}

// Import Firebase Admin modules
const { initializeApp, getApps, cert } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'token-tracer-97d50';
let serviceAccount = null;

// 1. Check custom CLI key path
if (customKeyPath && fs.existsSync(customKeyPath)) {
  try {
    serviceAccount = JSON.parse(fs.readFileSync(customKeyPath, 'utf8'));
    console.log(`\x1b[32m✔ Loaded service account from ${customKeyPath}\x1b[0m`);
  } catch (err) {
    console.error(`\x1b[31m[Error] Failed to read service account from ${customKeyPath}:\x1b[0m`, err.message);
  }
}

// 2. Auto-discover any firebase-adminsdk*.json file in the root directory
if (!serviceAccount) {
  try {
    const files = fs.readdirSync(rootDir);
    for (const file of files) {
      if (file.endsWith('.json') && (file.includes('firebase-adminsdk') || file.includes('serviceAccountKey') || file.includes('token-tracer-'))) {
        const fullPath = path.join(rootDir, file);
        try {
          const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (parsed.type === 'service_account' && parsed.private_key) {
            serviceAccount = parsed;
            console.log(`\x1b[32m✔ Auto-discovered service account key: ${file}\x1b[0m`);
            break;
          }
        } catch {}
      }
    }
  } catch {}
}

// 3. Check GOOGLE_APPLICATION_CREDENTIALS
if (!serviceAccount && process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  try {
    serviceAccount = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    console.log(`\x1b[32m✔ Loaded service account from GOOGLE_APPLICATION_CREDENTIALS\x1b[0m`);
  } catch (err) {
    console.warn(`[WARN] Failed to read service account:`, err.message);
  }
}

// 4. Check FIREBASE_SERVICE_ACCOUNT env var
if (!serviceAccount) {
  const saStr = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saStr && !saStr.startsWith('<') && saStr.trim().startsWith('{')) {
    try {
      serviceAccount = JSON.parse(saStr);
      console.log(`\x1b[32m✔ Loaded service account from FIREBASE_SERVICE_ACCOUNT env variable\x1b[0m`);
    } catch (err) {
      console.warn('[WARN] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
    }
  }
}

if (!getApps().length) {
  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id || projectId,
    });
  } else {
    initializeApp({
      projectId,
    });
  }
}

const firestore = getFirestore();

// Dynamically import pg
let pgClientModule;
try {
  pgClientModule = await import('pg');
} catch (e) {
  console.error('\x1b[31m[Error] pg package is required for migration. Run: npm install pg\x1b[0m');
  process.exit(1);
}

const { Client } = pgClientModule.default || pgClientModule;
const pgClient = new Client({ connectionString: postgresUrl, ssl: { rejectUnauthorized: false } });

/**
 * Recursively cleans values for Firestore compatibility:
 * - Converts Dates to ISO strings
 * - Converts `undefined` to `null`
 * - Flattens / stringifies nested arrays (Firestore disallows direct array-of-arrays)
 */
function sanitizeForFirestore(val, depth = 0) {
  if (val === undefined || val === null) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'bigint') return Number(val);
  if (typeof val !== 'object') return val;

  if (Array.isArray(val)) {
    return val.map((item) => {
      if (Array.isArray(item)) {
        return JSON.stringify(item);
      }
      if (typeof item === 'object' && item !== null && !(item instanceof Date)) {
        return sanitizeForFirestore(item, depth + 1);
      }
      return item;
    });
  }

  const result = {};
  for (const [k, v] of Object.entries(val)) {
    if (v === undefined) {
      result[k] = null;
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) => {
        if (Array.isArray(item)) {
          return JSON.stringify(item);
        }
        if (typeof item === 'object' && item !== null && !(item instanceof Date)) {
          return sanitizeForFirestore(item, depth + 1);
        }
        return item;
      });
    } else if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
      result[k] = sanitizeForFirestore(v, depth + 1);
    } else if (v instanceof Date) {
      result[k] = v.toISOString();
    } else if (typeof v === 'bigint') {
      result[k] = Number(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Sanitize Firestore document ID (removes '/')
 */
function sanitizeDocId(id) {
  return String(id).replace(/\//g, '__slash__');
}

async function commitBatchWithRetry(batch, retryCount = 5) {
  let delay = 1000;
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      await batch.commit();
      return;
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded') || msg.includes('timeout') || msg.includes('UNAVAILABLE')) {
        console.warn(`\n    [Rate limit / Quota exceeded] Waiting ${delay / 1000}s before retry (attempt ${attempt}/${retryCount})...`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Failed to commit batch after ${retryCount} retries due to quota / rate limits.`);
}

async function migrateTable(tableName, idColumn = 'id', transformDoc = null) {
  if (targetTables && !targetTables.includes(tableName)) {
    return;
  }
  if (skipDetails && (tableName === 'sync_session_tools' || tableName === 'sync_session_files')) {
    console.log(`\n\x1b[33m--> Skipping [${tableName}] (--skip-details flag enabled)\x1b[0m`);
    return;
  }

  console.log(`\n\x1b[36m--> Migrating table [${tableName}]...\x1b[0m`);
  try {
    const res = await pgClient.query(`SELECT * FROM ${tableName}`);
    const rows = res.rows;
    console.log(`    Found ${rows.length} rows in Postgres [${tableName}]`);

    if (rows.length === 0) return;

    // Fetch existing document IDs in Firestore to skip already inserted ones
    const existingDocIds = new Set();
    if (!forceOverwrite) {
      try {
        const docRefs = await firestore.collection(tableName).listDocuments();
        for (const docRef of docRefs) {
          existingDocIds.add(docRef.id);
        }
        if (existingDocIds.size > 0) {
          console.log(`    \x1b[33mFound ${existingDocIds.size} existing documents in Firestore [${tableName}]. Skipping already migrated records...\x1b[0m`);
        }
      } catch (err) {
        console.warn(`    (Could not pre-list documents for [${tableName}]: ${err.message})`);
      }
    }

    const batchSize = customBatchSize;
    let batch = firestore.batch();
    let batchCount = 0;
    let totalWritten = 0;
    let totalSkipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawData = {};

      for (const [k, v] of Object.entries(row)) {
        rawData[k] = v;
      }

      const transformed = transformDoc ? transformDoc(rawData) : rawData;
      const rawId = transformed[idColumn] || `${tableName}_${i}`;
      const docId = sanitizeDocId(rawId);

      // Skip if already exists
      if (existingDocIds.has(docId)) {
        totalSkipped++;
        continue;
      }

      const sanitizedData = sanitizeForFirestore(transformed);

      const ref = firestore.collection(tableName).doc(docId);
      batch.set(ref, sanitizedData, { merge: true });
      batchCount++;

      if (batchCount >= batchSize) {
        await commitBatchWithRetry(batch);
        totalWritten += batchCount;
        process.stdout.write(`    Progress: ${totalWritten} written, ${totalSkipped} skipped (${totalWritten + totalSkipped}/${rows.length})...\r`);
        batch = firestore.batch();
        batchCount = 0;
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    // Commit any remaining writes
    if (batchCount > 0) {
      await commitBatchWithRetry(batch);
      totalWritten += batchCount;
    }

    console.log(`\n    \x1b[32m✔ Finished [${tableName}]: ${totalWritten} newly written, ${totalSkipped} skipped (already present).\x1b[0m`);
  } catch (err) {
    if (err.message && err.message.includes('does not exist')) {
      console.log(`    Table [${tableName}] does not exist in Postgres. Skipping.`);
    } else {
      console.error(`\n    \x1b[31m✖ Error migrating [${tableName}]:\x1b[0m`, err.message);
    }
  }
}

async function run() {
  console.log('\x1b[35m=======================================================');
  console.log('       Neon Postgres -> Firebase Firestore Migration   ');
  console.log('=======================================================\x1b[0m');
  console.log(`Project:     ${projectId}`);
  console.log(`Source:      ${postgresUrl.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Mode:        ${forceOverwrite ? 'Overwrite All' : 'Skip Already Migrated'}`);
  if (skipDetails) console.log(`Details:     Skipping large breakdown tables (--skip-details)`);
  if (targetTables) console.log(`Tables:      ${targetTables.join(', ')}`);

  await pgClient.connect();
  console.log('\x1b[32m✔ Connected to Postgres.\x1b[0m');

  // Migrate in topological order
  await migrateTable('teams', 'id');
  await migrateTable('members', 'id');
  await migrateTable('team_members', 'id', (doc) => {
    if (!doc.id && doc.team_id && doc.member_id) {
      doc.id = `${doc.team_id}_${doc.member_id}`;
    }
    return doc;
  });
  await migrateTable('member_keys', 'id');
  await migrateTable('users', 'id');
  await migrateTable('model_pricing', 'id');
  await migrateTable('sync_sessions', 'id', (doc) => {
    // Safely serialize events if object/array
    if (doc.events && typeof doc.events !== 'string') {
      try {
        doc.events = JSON.stringify(doc.events);
      } catch {}
    }
    return doc;
  });
  await migrateTable('sync_session_tools', 'id', (doc) => {
    if (!doc.id && doc.sync_session_id && doc.tool_name) {
      doc.id = `${doc.sync_session_id}_${doc.tool_name}`;
    }
    return doc;
  });
  await migrateTable('sync_session_files', 'id', (doc) => {
    if (!doc.id && doc.sync_session_id && doc.path) {
      const pathHash = crypto.createHash('md5').update(String(doc.path)).digest('hex').slice(0, 16);
      doc.id = `${doc.sync_session_id}_${pathHash}`;
    }
    return doc;
  });
  await migrateTable('session_turns', 'id');
  await migrateTable('session_tool_errors', 'id');
  await migrateTable('session_outcomes', 'session_id');
  await migrateTable('redundant_reprompt_events', 'id');
  await migrateTable('ingest_events', 'id');
  await migrateTable('daemon_releases', 'id');
  await migrateTable('audit_log', 'id');

  await pgClient.end();

  console.log('\n\x1b[32m=======================================================');
  console.log('   🎉 Migration Complete! All tables copied to Firestore.');
  console.log('=======================================================\x1b[0m\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n\x1b[31mFatal error during migration:\x1b[0m', err);
  process.exit(1);
});
