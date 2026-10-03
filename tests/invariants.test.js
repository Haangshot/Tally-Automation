/**
 * Architectural invariants.
 *
 * These assert properties of the codebase rather than the behaviour of a
 * function. They exist because the rules they cover are the ones a future
 * change is most likely to erode quietly: nothing breaks, no test goes red,
 * and a safety property is simply gone.
 *
 * See docs/TEST-TECHNIQUES.md, technique 1.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TallyReader } from '../src/tally/reads.js';
import { CachedReader } from '../src/tally/cache.js';
import { TOOLS } from '../src/agent/tools.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every .js file under src/, with its contents. */
function sourceFiles(dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.js')) {
      out.push({ rel: path.relative(SRC, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('architectural invariants', () => {
  const files = sourceFiles();

  test('the suite can see the source at all', () => {
    // A file walk that silently returns nothing would make every assertion
    // below vacuously true, which is the one way this file could lie.
    assert.ok(files.length > 20, `expected to find source files, found ${files.length}`);
    assert.ok(files.some((f) => f.rel === 'tally/writes.js'));
  });

  test('Import XML is built in exactly one module', () => {
    // The whole safety model rests on there being a single trusted generator.
    // If a second module learns to build an Import envelope, every guarantee
    // about validation and approval routes around it.
    const builders = files.filter((f) => /TALLYREQUEST>\s*Import/i.test(f.text));
    assert.deepEqual(
      builders.map((f) => f.rel),
      ['tally/writes.js'],
      'Import XML must only ever be built by src/tally/writes.js',
    );
  });

  test('nothing outside the write module builds a voucher payload', () => {
    // Belt and braces for the invariant above. An Import envelope carries its
    // masters and vouchers inside <TALLYMESSAGE>; a module that learns to emit
    // one has begun building writes, whatever it calls the surrounding request.
    const emitters = files.filter((f) => /<TALLYMESSAGE/i.test(f.text));
    assert.deepEqual(emitters.map((f) => f.rel), ['tally/writes.js'],
      'only src/tally/writes.js may construct a TALLYMESSAGE element');

    // And every XML builder must live there, so there is one place to review.
    const builders = files.filter((f) => /function\s+build\w*Xml\s*\(/.test(f.text));
    assert.deepEqual(builders.map((f) => f.rel), ['tally/writes.js'],
      'every build*Xml function must be defined in src/tally/writes.js');
  });

  test('no tool reachable by the model can write, approve or retry', () => {
    // Duplicated deliberately from agent.test.js: this is the invariant that
    // would be most catastrophic to lose, and it costs nothing to assert twice.
    const forbidden = /approve|reject|post|delete|import|execute|retry|raw|xml|tdl|cancel|alter/i;
    for (const tool of TOOLS) {
      assert.ok(!forbidden.test(tool.name), `tool "${tool.name}" names a forbidden capability`);
    }
    // Every non-read tool must be a stager, and stagers must say so.
    for (const tool of TOOLS) {
      if (tool.name.startsWith('stage_')) {
        assert.equal(tool.stages, true, `${tool.name} must be marked as staging`);
      }
    }
  });

  test('every tool re-validates its arguments rather than trusting the model', () => {
    // The JSON schema is a hint to the model, not a guarantee to us.
    for (const tool of TOOLS) {
      assert.ok(tool.zod, `${tool.name} must carry a Zod schema`);
      assert.equal(typeof tool.run, 'function', `${tool.name} must have an implementation`);
    }
  });

  test('the cached reader exposes every method the plain reader has', () => {
    // A method missing here does not fail loudly — it fails at staging time,
    // with "reader.listGodowns is not a function". That is exactly what
    // happened when the pass-through list was maintained by hand.
    const reader = new TallyReader();
    const cached = new CachedReader(reader);

    const missing = [];
    for (let obj = Object.getPrototypeOf(reader); obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
      for (const name of Object.getOwnPropertyNames(obj)) {
        if (name === 'constructor' || name.startsWith('#')) continue;
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (!desc || typeof desc.value !== 'function') continue;
        if (typeof cached[name] !== 'function') missing.push(name);
      }
    }
    assert.deepEqual(missing, [], 'every TallyReader method must be reachable through CachedReader');
  });

  test('staging and approval read through different readers', () => {
    // The staging cache must never answer a question asked at approval time:
    // a stale "yes, that ledger exists" is precisely the wrong answer.
    const service = readFileSync(path.join(SRC, 'actions', 'service.js'), 'utf8');
    assert.match(service, /stagingReader/, 'ActionService must hold a separate staging reader');
    assert.match(
      service,
      /#validate\([^)]*reader\s*=\s*this\.reader/,
      'validation must default to the uncached reader',
    );
  });

  test('values reaching Tally are escaped by trusted code', () => {
    // Anything interpolated into markup must go through esc(). This is the
    // boundary that stops a ledger named `</LEDGERNAME><DELETE>` becoming a
    // Tally instruction.
    //
    // Only lines that actually build a tag are checked: the same
    // interpolation inside a thrown error message is not a markup hazard, and
    // treating it as one trains people to ignore this test.
    const writes = readFileSync(path.join(SRC, 'tally', 'writes.js'), 'utf8');
    const offenders = writes.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /<[A-Z][A-Z0-9_.]*/.test(line))
      .filter(({ line }) => /\$\{\s*(payload|p)\.[A-Za-z0-9_.]+\s*\}/.test(line));

    assert.deepEqual(
      offenders.map(({ n, line }) => `${n}: ${line.trim()}`),
      [],
      'payload fields must be wrapped in esc() before entering XML',
    );
  });

  test('the OpenAI key is read from the environment in exactly one place', () => {
    // Every other module goes through config.OPENAI_API_KEY, which is what
    // redact() knows about. A module reading process.env directly would be
    // holding a copy of the key that redaction never sees.
    const offenders = files.filter((f) => (
      /process\.env\.OPENAI_API_KEY/.test(f.text) && f.rel !== 'config.js'
    ));
    assert.deepEqual(offenders.map((f) => f.rel), [],
      'only config.js may read process.env.OPENAI_API_KEY');

    // And no source file may contain something shaped like a key.
    for (const f of files) {
      assert.ok(!/\bsk-[A-Za-z0-9_-]{20,}/.test(f.text), `${f.rel} appears to contain an API key`);
    }
  });

  test('money is not summed with bare floating-point addition in accounting paths', () => {
    // Not a ban on arithmetic — a check that the modules which total money
    // import the exact-decimal helpers rather than reducing with +.
    const accounting = files.filter((f) => /validation\/rules\.js|actions\/service\.js/.test(f.rel));
    assert.ok(accounting.length >= 1, 'expected to find the accounting modules');
    for (const f of accounting) {
      const reducesWithPlus = /reduce\(\s*\((\w+),\s*(\w+)\)\s*=>\s*\1\s*\+/.test(f.text);
      if (reducesWithPlus) {
        assert.match(f.text, /core\/decimal\.js/,
          `${f.rel} totals values with + and must import the exact-decimal helpers`);
      }
    }
  });
});
