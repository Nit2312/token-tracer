/**
 * Lean Data Migration: Neon DB Dump -> Google Cloud Firestore
 *
 * Migrates 100% of core metadata and the top 850 most active/recent sessions
 * strictly adhering to the < 1,000 document writes budget with ZERO Firestore reads.
 *
 * Usage:
 *   npx tsx scripts/lean-migrate.ts [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, WriteBatch } from 'firebase-admin/firestore';

const rootDir = process.cwd();

// 1. Initialize Firebase Admin directly
function initFirebase() {
  if (getApps().length) return getFirestore();

  let serviceAccount: any = null;
  const keyPath = path.join(rootDir, 'serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    try {
      serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch {}
  }

  if (serviceAccount) {
    if (typeof serviceAccount.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id || 'token-tracer-97d50',
    });
  } else {
    initializeApp({
      projectId: 'token-tracer-97d50',
    });
  }

  return getFirestore();
}

// 2. Parse PSQL text dump
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

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('====================================================');
  console.log('🚀 LEAN FIRESTORE MIGRATION (< 1,000 WRITES BUDGET)');
  console.log(`Mode: ${isDryRun ? '🔍 DRY RUN (Simulating only)' : '⚡ LIVE WRITE'}`);
  console.log('====================================================\n');

  const dumpPath = path.join(rootDir, 'db_dump.txt');
  if (!fs.existsSync(dumpPath)) {
    console.error('❌ db_dump.txt not found in project root!');
    process.exit(1);
  }

  console.log('📖 Reading db_dump.txt...');
  const dumpContent = fs.readFileSync(dumpPath, 'utf8');
  const collections = parsePsqlDump(dumpContent);

  // 1. Prepare Core Metadata (100% migrated)
  const teams = collections['teams'] || [];
  const members = collections['members'] || [];
  const teamMembers = collections['team_members'] || [];
  const users = collections['users'] || [];
  const memberKeys = collections['member_keys'] || [];
  const pricing = collections['model_pricing'] || [];

  // 2. Prepare Sessions (Top 850 most recent sessions)
  const allSessions = collections['sync_sessions'] || [];
  allSessions.sort((a, b) => {
    const tsA = a.ended_at || a.started_at || a.synced_at || '';
    const tsB = b.ended_at || b.started_at || b.synced_at || '';
    return String(tsB).localeCompare(String(tsA));
  });
  const targetSessions = allSessions.slice(0, 850);

  // 3. Prepare Pipeline Health Events (Top 50 most recent events)
  const allEvents = collections['ingest_events'] || [];
  allEvents.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const targetEvents = allEvents.slice(0, 50);

  const plan: Array<{ col: string; docs: any[] }> = [
    { col: 'teams', docs: teams },
    { col: 'members', docs: members },
    { col: 'team_members', docs: teamMembers },
    { col: 'users', docs: users },
    { col: 'member_keys', docs: memberKeys },
    { col: 'model_pricing', docs: pricing },
    { col: 'sync_sessions', docs: targetSessions },
    { col: 'ingest_events', docs: targetEvents },
  ];

  let totalOperations = 0;
  console.log('📊 Migration Plan Breakdown:');
  console.log('----------------------------------------------------');
  for (const item of plan) {
    console.log(`  • ${item.col.padEnd(20)}: ${String(item.docs.length).padStart(4)} writes`);
    totalOperations += item.docs.length;
  }
  console.log('----------------------------------------------------');
  console.log(`🎯 TOTAL PLANNED WRITES : ${totalOperations} (Budget limit: 1,000)\n`);

  if (totalOperations > 1000) {
    console.error('❌ Planned writes exceed the 1,000 budget! Aborting.');
    process.exit(1);
  }

  if (isDryRun) {
    console.log('✔ Dry run complete. No data was written to Firestore.');
    console.log('Run without --dry-run to execute live migration:');
    console.log('  npx tsx scripts/lean-migrate.ts');
    return;
  }

  const db = initFirebase();

  // Execute in batches of 400
  let writtenCount = 0;
  let currentBatch = db.batch();
  let opsInCurrentBatch = 0;

  console.log('⚡ Executing live batch writes to Firestore...');

  for (const item of plan) {
    for (const doc of item.docs) {
      const docRef = db.collection(item.col).doc(String(doc.id));
      currentBatch.set(docRef, doc, { merge: true });
      opsInCurrentBatch++;
      writtenCount++;

      if (opsInCurrentBatch >= 400) {
        process.stdout.write(`  Writing batch (${opsInCurrentBatch} ops)... `);
        await currentBatch.commit();
        console.log('✔ Done');
        currentBatch = db.batch();
        opsInCurrentBatch = 0;
      }
    }
  }

  if (opsInCurrentBatch > 0) {
    process.stdout.write(`  Writing final batch (${opsInCurrentBatch} ops)... `);
    await currentBatch.commit();
    console.log('✔ Done');
  }

  console.log('\n====================================================');
  console.log(`🎉 SUCCESS: ${writtenCount} records written to Firestore in under 1,000 writes!`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
