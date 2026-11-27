/**
 * Node.js version pin: `.nvmrc`, `package.json` engines.node and the @types/node major must agree, the pin must be a form Vercel accepts
 * (major-only, never an open range that would auto-upgrade), and the Node running the tests must satisfy it and every direct dependency's
 * engines range — otherwise a green run says nothing about the version that will be deployed. DB-free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const nvmrc = read('.nvmrc').trim();
const pinnedMajor = Number(nvmrc.split('.')[0]);

// ── a deliberately small semver-range evaluator (no dependency): the syntax engines.node ranges really use. Unknown syntax THROWS. ──
type V = [number, number, number];
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const wild = (x: string | undefined) => x === undefined || x === 'x' || x === '*';
/** Parses ONE comparator (throws on syntax it does not understand) and returns the test to run against a version. */
function comparator(raw: string): (v: V) => boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(raw);
  if (!m) throw new Error(`unsupported engines syntax: "${raw}"`);
  const [, op = '=', maj, min, pat] = m;
  const base: V = [Number(maj), wild(min) ? 0 : Number(min), wild(pat) ? 0 : Number(pat)];
  switch (op) {
    case '>=': return (v) => cmp(v, base) >= 0;
    case '>': return (v) => cmp(v, base) > 0;
    case '<=': return (v) => cmp(v, base) <= 0;
    case '<': return (v) => cmp(v, base) < 0;
    case '^': return (v) => cmp(v, base) >= 0 && v[0] === base[0];
    case '~': return (v) => cmp(v, base) >= 0 && v[0] === base[0] && (wild(min) || v[1] === base[1]);
    default: return (v) => v[0] === base[0] && (wild(min) || v[1] === base[1]) && (wild(pat) || v[2] === base[2]);
  }
}
export function satisfies(version: string, range: string): boolean {
  const v = version.split('.').map(Number) as V;
  // Parse EVERY comparator of EVERY alternative first, so unsupported syntax throws even when an earlier comparator would have short-circuited.
  const alts = range.split('||').map((alt) => alt.replace(/(>=|<=|>|<|\^|~)\s+/g, '$1').trim().split(/\s+/).filter(Boolean).map(comparator));
  return alts.some((tests) => tests.every((t) => t(v)));
}

describe('the range evaluator used below', () => {
  it('handles the syntax found in this dependency tree and refuses what it does not understand', () => {
    assert.ok(satisfies('24.14.1', '^20.19.0 || ^22.13.0 || >=24'));
    assert.ok(satisfies('22.13.0', '^20.19.0 || ^22.13.0 || >=24')); assert.ok(!satisfies('22.12.9', '^20.19.0 || ^22.13.0 || >=24')); assert.ok(!satisfies('21.0.0', '^20.19.0 || ^22.13.0 || >=24'));
    assert.ok(satisfies('24.14.1', '>=20.9.0')); assert.ok(satisfies('24.14.1', '>= 20')); assert.ok(satisfies('24.1.0', '20 || >=22')); assert.ok(!satisfies('19.9.9', '>=20'));
    assert.ok(satisfies('24.5.0', '24.x')); assert.ok(!satisfies('25.0.0', '24.x')); assert.ok(satisfies('24.3.0', '~24.3.0') && !satisfies('24.4.0', '~24.3.0'));
    assert.throws(() => satisfies('24.0.0', '1.2.3 - 2.3.4'), /unsupported engines syntax/); // a hyphen range: the FIRST token fails, the bad one comes later
    assert.throws(() => satisfies('24.0.0', '>=99 foo'), /unsupported engines syntax/);
    assert.throws(() => satisfies('24.0.0', '24.x || @@'), /unsupported engines syntax/); // a later alternative is validated even though an earlier one matches
  });
});

describe('Node.js version pin', () => {
  it('.nvmrc is a plain version number (no "v" prefix, no aliases such as lts/*)', () => {
    assert.match(nvmrc, /^\d+(\.\d+){0,2}$/);
  });
  it('engines.node is a major-only range (N.x): Vercel then selects exactly that major, and an open range cannot auto-upgrade', () => {
    assert.match(pkg.engines?.node ?? '', /^\d+\.x$/);
  });
  it('.nvmrc, engines.node and the @types/node major all name the same Node major', () => {
    const engines = Number((pkg.engines!.node as string).split('.')[0]);
    const types = Number(/(\d+)/.exec(pkg.devDependencies?.['@types/node'] ?? pkg.dependencies?.['@types/node'] ?? '')?.[1]);
    assert.deepEqual({ nvmrc: pinnedMajor, engines, types }, { nvmrc: engines, engines, types: engines });
  });
  it('the Node.js running these tests satisfies the pin (use `nvm use`; a run on another major proves nothing about the deployed version)', () => {
    assert.ok(satisfies(process.versions.node, pkg.engines!.node as string), `running Node ${process.versions.node}, pinned ${pkg.engines!.node} — run "nvm use"`);
    assert.equal(Number(process.versions.node.split('.')[0]), pinnedMajor);
  });
  it('the running Node satisfies the engines range of every direct dependency (including Next.js)', () => {
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    let checked = 0; const failures: string[] = [];
    for (const name of names) {
      const file = path.join(root, 'node_modules', name, 'package.json');
      if (!fs.existsSync(file)) continue;
      const range = (JSON.parse(fs.readFileSync(file, 'utf8')) as { engines?: { node?: string } }).engines?.node;
      if (!range) continue;
      checked++;
      if (!satisfies(process.versions.node, range)) failures.push(`${name} requires node ${range}`);
    }
    assert.ok(checked >= 5, `expected several dependencies to declare engines, found ${checked}`);
    assert.deepEqual(failures, []);
    const next = JSON.parse(read('node_modules/next/package.json')) as { engines: { node: string } };
    assert.ok(satisfies(`${pinnedMajor}.0.0`, next.engines.node), `Next.js requires node ${next.engines.node}`);
  });
  it('no other tool-version file or container/CI definition pins a different Node major', () => {
    const candidates: Array<[string, RegExp]> = [['.node-version', /^v?(\d+)/m], ['.tool-versions', /^nodejs\s+v?(\d+)/m], ['Dockerfile', /FROM\s+node:(\d+)/i]];
    for (const [file, re] of candidates) {
      if (!fs.existsSync(path.join(root, file))) continue;
      assert.equal(Number(re.exec(read(file))?.[1]), pinnedMajor, `${file} pins a different Node major than .nvmrc`);
    }
    const wf = path.join(root, '.github', 'workflows');
    if (fs.existsSync(wf)) for (const f of fs.readdirSync(wf)) {
      const text = read(`.github/workflows/${f}`);
      for (const m of text.matchAll(/node-version:\s*['"]?(\d+)/g)) assert.equal(Number(m[1]), pinnedMajor, `.github/workflows/${f} uses a different Node major`);
      if (/setup-node/.test(text)) assert.match(text, /node-version-file:\s*['"]?\.nvmrc|node-version:\s*['"]?\d+/, `.github/workflows/${f}: setup-node must use .nvmrc or the pinned major`);
    }
  });
  it('the README documents the pinned version and where it is pinned', () => {
    const readme = read('README.md');
    assert.ok(readme.includes(`Node.js ${pinnedMajor}.x`)); assert.ok(readme.includes('.nvmrc')); assert.ok(readme.includes('engines'));
  });
});
