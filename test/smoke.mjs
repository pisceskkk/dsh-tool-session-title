/**
 * Pure-Node smoke test for @deepseek-ai/dsh-tool-session-title.
 *
 * Runs without DSH: `@deepseek-ai/dsh-tools` is redirected by
 * `module.registerHooks` to an in-memory stub module, and every tool definition
 * the plugin hands to `defineTool` is captured RAW (SCHEMA-RULES R8) and linted
 * against the author-schema DSL rules in ../design/SCHEMA-RULES.md — before the
 * runtime's own schema compiler would ever see it.
 *
 * The plugin uses a plain static `import { defineTool } from
 * '@deepseek-ai/dsh-tools'`. The resolve hook intercepts that specifier, so the
 * production module needs no test-only branch and no in-tree stub file.
 *
 * Usage: node test/smoke.mjs
 * Exit code: 0 when every case passes, 1 otherwise.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { registerHooks } from 'node:module';

// ---------------------------------------------------------------------------
// dsh-tools stub (SCHEMA-RULES R8: record the raw options, then pass through)
// ---------------------------------------------------------------------------

/**
 * In-memory stub module: records each raw `options` object, then returns it
 * unchanged so the plugin sees an ordinary tool definition. The recorder is a
 * process global because a `load` hook cannot hand back ESM exports, and
 * module-level bindings of a data-URL module are unreachable from here. Using
 * the global keeps the stub honest: whatever the plugin calls is what the
 * linter later reads.
 */
const STUB_SOURCE = `
globalThis.__dshStubCalls ??= [];
export const calls = globalThis.__dshStubCalls;
export function defineTool(options) {
  calls.push(options);
  return options;
}
`;

const STUB_URL = `data:text/javascript;base64,${Buffer.from(STUB_SOURCE, 'utf8').toString('base64')}`;
globalThis.__dshStubCalls = [];

// Redirect import declarations of the tools package to the in-memory stub.
// Registered before the plugin module is imported, so its static import is
// resolved by this hook.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const plugin = await import('../src/lib/index.js');
assert.equal(typeof plugin.apply, 'function', 'plugin did not export apply()');

/**
 * Recorded `options` for one `apply()` run.
 * @returns the raw author options captured since the last reset.
 */
function capturedOptions() {
  const calls = globalThis.__dshStubCalls;
  assert.ok(Array.isArray(calls), 'the registerHooks stub must own the capture array');
  return calls;
}

// ---------------------------------------------------------------------------
// Author-schema linter (SCHEMA-RULES R2-R5, R7)
// ---------------------------------------------------------------------------

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];

/** Report one author-DSL violation in the same shape the runtime uses. */
class AuthorSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthorSchemaError';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertOnlyKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) {
      throw new AuthorSchemaError(`${path}.${key} is not supported by the value schema DSL`);
    }
  }
}

/**
 * Validate one author-authored schema node.
 * @param {unknown} spec candidate node.
 * @param {string} path diagnostic location, e.g. `output.schema.properties.title`.
 * @param {{ allowRequired?: boolean }} [options] `required` is only legal on a
 *   object property node and only as the literal `true`.
 */
function lintAuthorSchema(spec, path, options = {}) {
  const { allowRequired = false } = options;
  if (!isPlainObject(spec)) {
    throw new AuthorSchemaError(`${path} must be a value schema object`);
  }
  // R5: `type` and `oneOf` are mutually exclusive node kinds.
  if (Object.hasOwn(spec, 'type') && Object.hasOwn(spec, 'oneOf')) {
    throw new AuthorSchemaError(`${path} cannot declare both type and oneOf`);
  }
  // R3: an object node never carries a `required` array; the compiler rejects
  // it outright. Keep the runtime's wording for this specific mistake.
  if (Array.isArray(spec.required)) {
    throw new AuthorSchemaError(`${path}.required is not supported by the value schema DSL`);
  }
  // R1: property-level `required` is the literal true, never false.
  if (Object.hasOwn(spec, 'required') && spec.required !== true) {
    throw new AuthorSchemaError(
      `${path}.required must be true when present (got ${JSON.stringify(spec.required)})`,
    );
  }
  const annotationKeys = allowRequired ? [...ANNOTATION_KEYS, 'required'] : [...ANNOTATION_KEYS];

  // R5: oneOf is a node kind of its own; branches are value nodes.
  if (Object.hasOwn(spec, 'oneOf')) {
    assertOnlyKeys(spec, path, [...annotationKeys, 'oneOf']);
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
      throw new AuthorSchemaError(`${path}.oneOf must be an array of at least two value schemas`);
    }
    spec.oneOf.forEach((branch, index) => {
      lintAuthorSchema(branch, `${path}.oneOf[${index}]`, { allowRequired: false });
    });
    return;
  }

  const type = spec.type;
  if (type === 'json') {
    assertOnlyKeys(spec, path, [...annotationKeys, 'type']);
    return;
  }
  if (type === 'object') {
    assertOnlyKeys(spec, path, [...annotationKeys, 'type', 'properties', 'additionalProperties']);
    // R4: every object node states its openness explicitly.
    if (typeof spec.additionalProperties !== 'boolean') {
      throw new AuthorSchemaError(`${path}.additionalProperties must be explicitly true or false`);
    }
    // R3 (defensive): still rejected here if a future edit loosens the check
    // at the top of this function.
    if (Object.hasOwn(spec, 'required') && spec.required !== true) {
      throw new AuthorSchemaError(`${path}.required is not supported by the value schema DSL`);
    }
    if (Object.hasOwn(spec, 'properties')) {
      if (!isPlainObject(spec.properties)) {
        throw new AuthorSchemaError(`${path}.properties must be an object of value schemas`);
      }
      for (const [key, child] of Object.entries(spec.properties)) {
        lintAuthorSchema(child, `${path}.properties.${key}`, { allowRequired: true });
      }
    }
    return;
  }
  if (type === 'array') {
    assertOnlyKeys(spec, path, [...annotationKeys, 'type', 'items']);
    if (Object.hasOwn(spec, 'items')) {
      lintAuthorSchema(spec.items, `${path}.items`, { allowRequired: false });
    }
    return;
  }
  if (SCALAR_TYPES.includes(type)) {
    assertOnlyKeys(spec, path, [...annotationKeys, 'type', 'enum', 'const']);
    if (Object.hasOwn(spec, 'enum') && (!Array.isArray(spec.enum) || spec.enum.length === 0)) {
      throw new AuthorSchemaError(`${path}.enum must be a non-empty array of scalar values`);
    }
    return;
  }
  throw new AuthorSchemaError(
    `${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`,
  );
}

/**
 * Lint an implicit parameter property map (R1): object of value schemas whose
 * properties may carry `required: true`.
 * @param {unknown} spec the tool's `parameters`.
 * @param {string} [path] diagnostic root.
 */
function lintParameterMap(spec, path = 'parameters') {
  if (!isPlainObject(spec)) {
    throw new AuthorSchemaError(`${path} must be an object of value schemas`);
  }
  for (const [key, child] of Object.entries(spec)) {
    lintAuthorSchema(child, `${path}.${key}`, { allowRequired: true });
  }
}

// ---------------------------------------------------------------------------
// Harness: fake ctx, fake session, case runner
// ---------------------------------------------------------------------------

const PROMPT_SECTION_NAME = 'tool:set_session_title';
const PROMPT_SECTION_ORDER = 2305;

/**
 * Build a fresh plugin context backed by simple fakes.
 * @param {object} [overrides]
 * @param {Record<string, unknown>} [overrides.titles] name -> snapshot.
 * @param {object|null} [overrides.sessionTitleConfig] service config.
 * @param {boolean} [overrides.withoutService] omit ctx.sessionTitle entirely.
 * @param {boolean} [overrides.renameThrows] make rename throw.
 */
function createHarness(overrides = {}) {
  const tools = new Map();
  const sections = [];
  const renameCalls = [];
  const state = {
    titles: new Map(Object.entries(overrides.titles ?? {})),
    renameThrows: overrides.renameThrows ?? false,
  };

  const sessionTitle = overrides.withoutService === true
    ? undefined
    : {
      config: overrides.sessionTitleConfig === undefined
        ? { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }
        : overrides.sessionTitleConfig,
      get(session) {
        return state.titles.get(session.id);
      },
      rename(session, title) {
        renameCalls.push({ session, title });
        if (state.renameThrows) {
          throw new Error(`session "${session.id}" is not live in this store`);
        }
        const snapshot = { title, source: { kind: 'user' }, eventSeq: 7 };
        state.titles.set(session.id, snapshot);
        return snapshot;
      },
    };

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
      },
      get(toolName, _scope) {
        return tools.get(toolName);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    ...(sessionTitle === undefined ? {} : { sessionTitle }),
  };

  // Clear any capture from an earlier run, then apply; read the capture after.
  globalThis.__dshStubCalls.length = 0;
  plugin.apply(ctx, undefined);
  const calls = capturedOptions();
  return {
    ctx,
    tools,
    sections,
    renameCalls,
    state,
    /** Raw author options from this run, in registration order. */
    definitions: [...calls],
  };
}

/** Make a fake live session. */
function makeSession(id, header = {}) {
  return { id, header };
}

/** Tool execution context for a given session. */
function execFor(session) {
  return { agent: session === undefined ? undefined : { session } };
}

/** Capture a rejection and return it, or throw if the call resolved. */
async function rejects(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

const cases = [];

/** Register one smoke case. */
function test(caseName, fn) {
  cases.push({ name: caseName, fn });
}

// ---------------------------------------------------------------------------
// Installer fixture helpers (shared by T16 and T21-T26)
// ---------------------------------------------------------------------------

const fsPromises = await import('node:fs/promises');
const fsSync = await import('node:fs');
const pathMod = await import('node:path');
const { spawnSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/install.ps1', import.meta.url));
const TMP_ROOT = fileURLToPath(new URL('.tmp-install/', import.meta.url));

/**
 * Pick the PowerShell that should run the installer.
 *
 * T16 runs on `pwsh` (PowerShell 7) when present because that is the default
 * user shell; every fixture is also exercised on Windows PowerShell 5.1 by
 * T26 (B2 encoding), and that run is a hard requirement.
 * @param {string} preferred one of 'pwsh' | 'powershell'.
 * @returns {string|null} the executable name, or null when unavailable.
 */
function pickShell(preferred) {
  const probe = spawnSync(preferred, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  return probe.error === undefined ? preferred : null;
}

/** Create a throwaway profile fixture with the given patch text. */
function makeProfile(patchText, name = 'desktop') {
  const profile = pathMod.join(TMP_ROOT, name);
  const modulesDir = pathMod.join(profile, 'node_modules', '@deepseek-ai');
  fsSync.mkdirSync(modulesDir, { recursive: true });
  fsSync.writeFileSync(pathMod.join(profile, 'cordis.patch.yml'), patchText, 'utf8');
  return {
    profile,
    patchFile: pathMod.join(profile, 'cordis.patch.yml'),
    packageDir: pathMod.join(modulesDir, 'dsh-tool-session-title'),
    backups: () => fsSync.readdirSync(profile)
      .filter((entry) => entry.startsWith('cordis.patch.yml.bak.'))
      .map((entry) => pathMod.join(profile, entry)),
  };
}

/** Run install.ps1 against a fixture; returns { status, stdout, stderr }. */
function runInstaller(shell, profile, ...args) {
  const result = spawnSync(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, ...args, '-ProfilePath', profile],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    stderr: result.stderr ?? '',
  };
}

const cleanTmpRoot = () => {
  try { fsSync.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
};

/** Minimal YAML block reader: list-item indent and per-item key lines. */
function yamlLines(text) {
  return text.split('\n');
}

/** Index of the first line matching a regex, or -1. */
function indexOfLine(lines, pattern) {
  return lines.findIndex((line) => pattern.test(line));
}

/** Leading-space count of a non-blank line. */
function indentOf(line) {
  return line.length - line.trimStart(' ').length;
}

/**
 * Assert the plugin entry is the FIRST child of the `- insert:` list at the
 * given item indent, that it has a properly indented `name:` and that the
 * file gained exactly two lines.
 * @returns {{ idLine: number, childIndent: number }}
 */
function assertAnchoredInsert(before, after, expectedChildIndent) {
  const beforeLines = yamlLines(before);
  const afterLines = yamlLines(after);
  assert.equal(afterLines.length, beforeLines.length + 2, 'the edit must add exactly two lines');

  const insertIndex = indexOfLine(afterLines, /^\s*-\s+insert:\s*$/);
  assert.ok(insertIndex >= 0, 'the original insert key must survive');
  assert.match(afterLines[insertIndex + 1], /^ *- id: tool-session-title$/, 'entry must be the first child');
  const childIndent = indentOf(afterLines[insertIndex + 1]);
  assert.equal(childIndent, expectedChildIndent, 'entry indent must match the first existing child');
  assert.equal(
    afterLines[insertIndex + 2],
    `${' '.repeat(childIndent + 2)}name: "@deepseek-ai/dsh-tool-session-title"`,
    'name must sit two spaces deeper than the list marker',
  );
  assert.equal((after.match(/^ *- id: tool-session-title$/gm) ?? []).length, 1);
  return { idLine: insertIndex + 1, childIndent, insertIndex };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test('T1 export shape: name/inject/apply', () => {
  assert.equal(typeof plugin.name, 'string');
  assert.equal(plugin.name, 'tool-session-title');
  assert.ok(Array.isArray(plugin.inject));
  assert.deepEqual([...plugin.inject], ['tools', 'systemPrompt', 'sessionTitle']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.apply.constructor.name, 'Function', 'apply must be a plain synchronous function');
});

test('T2 tool schemas: names, parameters, output', () => {
  const { definitions } = createHarness();
  assert.deepEqual(definitions.map((definition) => definition.name), ['set_session_title', 'get_session_title']);

  const [setOptions, getOptions] = definitions;
  assert.deepEqual(Object.keys(setOptions.parameters), ['title']);
  assert.equal(setOptions.parameters.title.type, 'string');
  assert.equal(setOptions.parameters.title.required, true);
  assert.equal(typeof setOptions.parameters.title.description, 'string');
  assert.ok(setOptions.parameters.title.description.length > 0);
  assert.deepEqual(Object.keys(getOptions.parameters), []);

  assert.equal(setOptions.output.schema.type, 'object');
  assert.equal(setOptions.output.schema.additionalProperties, false);
  assert.equal(setOptions.output.schema.properties.unchanged.required, true);
  assert.equal(setOptions.output.schema.properties.current.required, true);
  assert.equal(getOptions.output.schema.additionalProperties, false);
  assert.equal(getOptions.output.schema.properties.title.required, true);
  assert.equal(getOptions.output.schema.properties.source.required, true);
  assert.deepEqual(
    getOptions.output.schema.properties.source.oneOf[0].enum,
    ['fallback', 'provider', 'user'],
  );
  assert.equal(typeof setOptions.output.render, 'function');
  assert.equal(typeof getOptions.output.render, 'function');
});

test('T3 prompt section registered with fixed name and order 2305', () => {
  const { sections } = createHarness();
  assert.equal(sections.length, 1);
  const [section] = sections;
  assert.equal(section.name, PROMPT_SECTION_NAME);
  assert.equal(section.order, PROMPT_SECTION_ORDER);
  assert.equal(typeof section.text, 'function');
  const text = section.text({ scope: {} });
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

test('T4 prompt section hides when the tool is not visible', () => {
  const hidden = createHarness();
  hidden.tools.delete('set_session_title');
  assert.equal(hidden.sections[0].text({ scope: {} }), '');
  const visible = createHarness();
  assert.ok(visible.sections[0].text({ scope: {} }).length > 0);
});

test('T5 normal set returns previous/current and pins via rename()', async () => {
  const harness = createHarness({ titles: { s1: { title: 'old title', source: { kind: 'provider' } } } });
  const session = makeSession('s1');
  const result = await harness.tools.get('set_session_title').execute(
    { title: 'feat(auth): 支持 SSO' },
    execFor(session),
  );
  assert.equal(result.unchanged, false);
  assert.equal(result.previous, 'old title');
  assert.equal(result.current, 'feat(auth): 支持 SSO');
  assert.equal(harness.renameCalls.length, 1);
  assert.equal(harness.renameCalls[0].title, 'feat(auth): 支持 SSO');

  const fresh = createHarness();
  const first = await fresh.tools.get('set_session_title').execute(
    { title: 'feat(auth): 支持 SSO' },
    execFor(makeSession('s2')),
  );
  assert.equal(first.previous, null);

  const rendered = harness.definitions[0].output.render({}, result);
  assert.ok(Array.isArray(rendered) && rendered.length > 0);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('feat(auth): 支持 SSO'));
});

test('T6 idempotent: same title returns unchanged and skips rename()', async () => {
  const harness = createHarness({ titles: { s1: { title: 'feat(auth): 支持 SSO', source: { kind: 'user' } } } });
  const result = await harness.tools.get('set_session_title').execute(
    { title: 'feat(auth): 支持 SSO' },
    execFor(makeSession('s1')),
  );
  assert.equal(result.unchanged, true);
  assert.equal(result.current, 'feat(auth): 支持 SSO');
  assert.equal(harness.renameCalls.length, 0);
  const rendered = harness.definitions[0].output.render({}, result);
  assert.ok(rendered[0].text.includes('unchanged'));
});

test('T7 oversized title rejected with byte counts', async () => {
  const harness = createHarness();
  const tool = harness.tools.get('set_session_title');
  const tooLong = '`'.repeat(81); // 81 single-byte characters
  const error = await rejects(() => tool.execute({ title: tooLong }, execFor(makeSession('s1'))));
  assert.match(error.message, /^\[E_TITLE_TOO_LONG\] /);
  assert.match(error.message, /81 UTF-8 bytes/);
  assert.match(error.message, /max 80/);
  assert.equal(harness.renameCalls.length, 0);

  // Multi-byte: 27 Chinese characters are 81 bytes.
  const cjk = '标'.repeat(27);
  const cjkError = await rejects(() => tool.execute({ title: cjk }, execFor(makeSession('s1'))));
  assert.match(cjkError.message, /E_TITLE_TOO_LONG/);
  assert.match(cjkError.message, /81 UTF-8 bytes/);

  // Exactly at the limit is accepted.
  await tool.execute({ title: '`'.repeat(80) }, execFor(makeSession('s1')));
});

test('T8 empty title rejected', async () => {
  const harness = createHarness();
  const tool = harness.tools.get('set_session_title');
  for (const title of ['', '   ', '\n\t ']) {
    const error = await rejects(() => tool.execute({ title }, execFor(makeSession('s1'))));
    assert.match(error.message, /^\[E_EMPTY_TITLE\] /);
  }
  assert.equal(harness.renameCalls.length, 0);
});

test('T9 child session rejected', async () => {
  const harness = createHarness();
  const child = makeSession('s1', { parentSession: { id: 'root' } });
  const error = await rejects(() => harness.tools.get('set_session_title').execute(
    { title: 'feat(auth): 支持 SSO' },
    execFor(child),
  ));
  assert.match(error.message, /^\[E_CHILD_SESSION\] /);
  assert.equal(harness.renameCalls.length, 0);
});

test('T10 missing sessionTitle service reports E_SERVICE_UNAVAILABLE', async () => {
  const harness = createHarness({ withoutService: true });
  const session = makeSession('s1');
  const setError = await rejects(() => harness.tools.get('set_session_title').execute(
    { title: 'feat(auth): x' },
    execFor(session),
  ));
  assert.match(setError.message, /^\[E_SERVICE_UNAVAILABLE\] /);
  const getError = await rejects(() => harness.tools.get('get_session_title').execute({}, execFor(session)));
  assert.match(getError.message, /^\[E_SERVICE_UNAVAILABLE\] /);
});

test('T11 get_session_title reports title and source', async () => {
  const harness = createHarness({ titles: { s1: { title: 'feat(auth): 支持 SSO', source: { kind: 'user' } } } });
  const result = await harness.tools.get('get_session_title').execute({}, execFor(makeSession('s1')));
  assert.deepEqual(result, { title: 'feat(auth): 支持 SSO', source: 'user' });
  const rendered = harness.definitions[1].output.render({}, result);
  assert.ok(rendered[0].text.includes('feat(auth): 支持 SSO'));

  const provider = createHarness({ titles: { s9: { title: 'auto title', source: { kind: 'provider', provider: 'x' } } } });
  const providerResult = await provider.tools.get('get_session_title').execute({}, execFor(makeSession('s9')));
  assert.equal(providerResult.source, 'provider');
});

test('T12 get_session_title on a titleless session returns nulls', async () => {
  const harness = createHarness();
  const result = await harness.tools.get('get_session_title').execute({}, execFor(makeSession('s1')));
  assert.deepEqual(result, { title: null, source: null });
  const rendered = harness.definitions[1].output.render({}, result);
  assert.equal(rendered[0].type, 'text');
  assert.equal(rendered[0].text, 'No title set.');
});

test('T13 missing exec.agent reports E_NO_AGENT', async () => {
  const harness = createHarness();
  for (const exec of [undefined, {}, { agent: undefined }]) {
    const setError = await rejects(() => harness.tools.get('set_session_title').execute({ title: 'feat(a): x' }, exec));
    assert.match(setError.message, /^\[E_NO_AGENT\] /);
    const getError = await rejects(() => harness.tools.get('get_session_title').execute({}, exec));
    assert.match(getError.message, /^\[E_NO_AGENT\] /);
  }
  assert.equal(harness.renameCalls.length, 0);
});

test('T14 maxTitleBytes comes from ctx.sessionTitle.config', async () => {
  const harness = createHarness({ sessionTitleConfig: { fallbackMaxWords: 5, fallbackMaxBytes: 10, maxTitleBytes: 20 } });
  const tool = harness.tools.get('set_session_title');
  const error = await rejects(() => tool.execute({ title: 'x'.repeat(21) }, execFor(makeSession('s1'))));
  assert.match(error.message, /^\[E_TITLE_TOO_LONG\] /);
  assert.match(error.message, /21 UTF-8 bytes/);
  assert.match(error.message, /max 20/);

  const ok = await tool.execute({ title: 'x'.repeat(20) }, execFor(makeSession('s1')));
  assert.equal(ok.current, 'x'.repeat(20));

  // Unreadable config falls back to 80 bytes.
  const noConfig = createHarness({ sessionTitleConfig: null });
  const fallbackError = await rejects(() => noConfig.tools.get('set_session_title').execute(
    { title: 'x'.repeat(81) },
    execFor(makeSession('s1')),
  ));
  assert.match(fallbackError.message, /max 80/);
});

test('T15 prompt text toggles with tool visibility', () => {
  const harness = createHarness();
  const section = harness.sections[0];
  const visible = section.text({ scope: {} });
  assert.notEqual(visible, '');
  assert.ok(visible.includes('set_session_title'));
  assert.ok(visible.includes('get_session_title'));

  harness.tools.delete('set_session_title');
  assert.equal(section.text({ scope: {} }), '');

  // Token budget: the guidance stays within the 400-character target.
  assert.ok(visible.length <= 400, `prompt section is ${visible.length} chars, expected <= 400`);

  // N4: every original naming constraint must survive the edit.
  for (const required of ['≤80 字节', '≤50 字符', '不以句号结尾', 'pin', '每个主题只设一次', '子会话不设标题', '工具不存在则静默跳过']) {
    assert.ok(visible.includes(required), `prompt section must state "${required}"`);
  }
  assert.equal(visible.endsWith('。'), false, 'prompt section must not end with a full stop');
});

test('T16 install.ps1: -WhatIf writes nothing, install is idempotent, -Rollback restores', () => {
  const installScript = fsSync.readFileSync(SCRIPT_PATH, 'utf8');
  const fixturePatch = [
    '# fixture patch',
    '- id: existing-plugin',
    '  config:',
    '    a: 1',
    '- insert:',
    '    # keep this comment',
    '    - id: magpie-mcp-magpie',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '',
  ].join('\n');

  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch);
    const { profile, patchFile, packageDir, backups } = fixture;

    // --- WhatIf: validate + print, write nothing ---
    const whatIf = runInstaller(shell, profile, '-WhatIf');
    assert.equal(whatIf.status, 0, `${shell} -WhatIf failed:\n${whatIf.stdout}\n${whatIf.stderr}`);
    assert.match(whatIf.stdout, /WhatIf: no files were written/);
    assert.equal(fsSync.readFileSync(patchFile, 'utf8'), fixturePatch, '-WhatIf modified cordis.patch.yml');
    assert.deepEqual(backups(), [], '-WhatIf created a backup');
    assert.equal(fsSync.existsSync(packageDir), false, '-WhatIf copied the package');

    // --- real install ---
    const install = runInstaller(shell, profile);
    assert.equal(install.status, 0, `${shell} install failed:\n${install.stdout}\n${install.stderr}`);
    const after = fsSync.readFileSync(patchFile, 'utf8');
    assertAnchoredInsert(fixturePatch, after, 4);
    assert.equal((after.match(/-\s+insert:/g) ?? []).length, 1, 'must not create a second insert block');
    assert.ok(after.includes('# keep this comment'), 'existing comments must survive');
    assert.equal(fsSync.existsSync(pathMod.join(packageDir, 'package.json')), true);
    assert.equal(fsSync.existsSync(pathMod.join(packageDir, 'lib', 'index.js')), true);
    assert.equal(backups().length, 1, 'exactly one backup after the first install');
    assert.equal(fsSync.readFileSync(backups()[0], 'utf8'), fixturePatch, 'backup must hold the original');

    // --- re-run: idempotent ---
    const again = runInstaller(shell, profile);
    assert.equal(again.status, 0, `${shell} re-install failed:\n${again.stdout}\n${again.stderr}`);
    assert.equal(fsSync.readFileSync(patchFile, 'utf8'), after, 're-install must not change the patch file');
    assert.equal(backups().length, 1, 'an idempotent re-run must not add a backup');

    // --- rollback ---
    const rollback = runInstaller(shell, profile, '-Rollback');
    assert.equal(rollback.status, 0, `${shell} -Rollback failed:\n${rollback.stdout}\n${rollback.stderr}`);
    assert.equal(fsSync.readFileSync(patchFile, 'utf8'), fixturePatch, '-Rollback must restore the backup');
    assert.equal(fsSync.existsSync(packageDir), false, '-Rollback must remove the package');
  } finally {
    cleanTmpRoot();
  }

  // Product constraints a behavior run cannot observe.
  for (const marker of ['[switch]$WhatIf', '[switch]$Rollback', '[switch]$Force', '[string]$ProfilePath', '$PSScriptRoot']) {
    assert.ok(installScript.includes(marker), `install.ps1 must declare ${marker}`);
  }
  // B2: the patch file may only be touched through .NET file APIs.
  for (const banned of [/\bGet-Content\b/i, /\bSet-Content\b/i, /\bOut-File\b/i, /\bAdd-Content\b/i]) {
    assert.doesNotMatch(installScript, banned, `install.ps1 must not use ${banned}`);
  }
  assert.match(installScript, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(installScript, /\[System\.IO\.File\]::WriteAllText/);
  assert.match(installScript, /New-Object System\.Text\.UTF8Encoding\(\$false\)/);
});

test('T17 linter self-test: known violations fail, valid schemas pass', () => {
  const violations = [
    ['object-level required array', { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } }, /required is not supported/],
    ['missing additionalProperties', { type: 'object', properties: { a: { type: 'string' } } }, /additionalProperties must be explicitly true or false/],
    ['non-boolean additionalProperties', { type: 'object', additionalProperties: 'no', properties: {} }, /additionalProperties must be explicitly true or false/],
    ['required: false', { type: 'object', additionalProperties: false, properties: { a: { type: 'string', required: false } } }, /required must be true/],
    ['type and oneOf together', { type: 'string', oneOf: [{ type: 'string' }, { type: 'null' }] }, /cannot declare both type and oneOf/],
    ['oneOf with one branch', { oneOf: [{ type: 'string' }] }, /at least two value schemas/],
    ['unknown key', { type: 'string', pattern: '^a' }, /pattern is not supported/],
    ['bad type', { type: 'float' }, /type must be/],
    ['non-object node', 'string', /must be a value schema object/],
    ['array node missing additionalProperties', { type: 'object', additionalProperties: false, properties: { xs: { type: 'array', items: { type: 'object', properties: {} } } } }, /additionalProperties/],
  ];
  for (const [label, spec, pattern] of violations) {
    assert.throws(() => lintAuthorSchema(spec, 'sample'), pattern, `linter missed: ${label}`);
  }
  // Design 4.1's `required: ['current']` form must be rejected too.
  assert.throws(
    () => lintAuthorSchema({
      type: 'object',
      properties: { current: { type: 'string' } },
      required: ['current'],
      additionalProperties: false,
    }, 'design4.1'),
    /required is not supported/,
  );
  // A valid node passes.
  lintAuthorSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      keep: { type: 'string', required: true, description: 'ok' },
      opt: { oneOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }] },
      list: { type: 'array', items: { type: 'number' } },
      any: { type: 'json' },
    },
  }, 'valid');
});

test('T18 every captured tool lints: parameters and output.schema', () => {
  const harness = createHarness();
  // Guard against an empty capture: linting nothing would pass vacuously.
  assert.equal(harness.definitions.length, 2, 'expected exactly two captured tool definitions');
  const capturedNames = harness.definitions.map((definition) => definition.name);
  assert.deepEqual([...capturedNames].sort(), ['get_session_title', 'set_session_title']);
  for (const definition of harness.definitions) {
    lintParameterMap(definition.parameters, `${definition.name}.parameters`);
    lintAuthorSchema(definition.output.schema, `${definition.name}.output.schema`);
  }
  // Sanity: the linter itself rejects a deliberately broken output schema that
  // mirrors the most likely real mistake (object-level required array).
  assert.throws(
    () => lintAuthorSchema({
      type: 'object',
      required: ['current'],
      additionalProperties: false,
      properties: { current: { type: 'string' } },
    }, 'broken.output.schema'),
    AuthorSchemaError,
  );
});

test('T19 rename() failure surfaces as E_SESSION_NOT_LIVE', async () => {
  const harness = createHarness({ renameThrows: true });
  const error = await rejects(() => harness.tools.get('set_session_title').execute(
    { title: 'feat(auth): x' },
    execFor(makeSession('s1')),
  ));
  assert.match(error.message, /^\[E_SESSION_NOT_LIVE\] /);
});

test('T20 defineTool stub is wired into the plugin (no false green)', () => {
  const harness = createHarness();
  // Both tools went through the registerHooks stub (not the real package).
  assert.deepEqual(harness.definitions.map((definition) => definition.name), ['set_session_title', 'get_session_title']);
  assert.equal(globalThis.__dshStubCalls.length, 2, 'exactly two defineTool() calls must be captured');
  // ...and the stub keeps the author form (R8), not a compiled schema.
  const [setOptions] = harness.definitions;
  assert.equal(setOptions.parameters.title.type, 'string');
  assert.equal(setOptions.parameters.title.required, true);
  assert.equal(setOptions.output.schema.properties.unchanged.required, true);
  // No test-only fallback may survive in production code.
  const pluginSource = fsSync.readFileSync(fileURLToPath(new URL('../src/lib/index.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(pluginSource, /\.smoke/, 'production code must not reference a test stub');
  assert.doesNotMatch(pluginSource, /loadDshTools|dshToolsForTests/, 'production code must not lazy-load dsh-tools');
  assert.match(pluginSource, /import \{ defineTool \} from '@deepseek-ai\/dsh-tools';/);
  assert.equal(fsSync.existsSync(fileURLToPath(new URL('../src/lib/.smoke', import.meta.url))), false, 'src/lib/.smoke must be gone');
});

test('T21 sibling key layout: entry inserted at the top of the insert list', async () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');
  const fixturePatch = [
    '- insert:',
    '    - id: old',
    '      name: old-package',
    '  after: another-plugin',
    '',
  ].join('\n');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch);
    const install = runInstaller(shell, fixture.profile);
    assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    const after = fsSync.readFileSync(fixture.patchFile, 'utf8');
    const { childIndent, idLine, insertIndex } = assertAnchoredInsert(fixturePatch, after, 4);
    const lines = yamlLines(after);
    assert.equal(idLine, insertIndex + 1, 'entry must directly follow "- insert:"');

    // The sibling key survives with unchanged indent and stays a sibling.
    const afterLine = indexOfLine(lines, /^\s*after: another-plugin$/);
    assert.ok(afterLine > idLine, 'the sibling key must still follow the insert list');
    assert.equal(indentOf(lines[afterLine]), 2, 'sibling key indent must be unchanged');
    // The old entry (list item + its name) is intact and still inside the list.
    const oldLine = indexOfLine(lines, /^ {4}- id: old$/);
    assert.ok(oldLine > idLine, 'the old item must stay after the new one');
    assert.equal(lines[oldLine + 1], '      name: old-package');
    assert.equal(indentOf(lines[oldLine]), childIndent, 'old item keeps the child indent');
    assert.equal(fsSync.existsSync(fixture.packageDir), true);
  } finally {
    cleanTmpRoot();
  }
});

test('T22 comment layout: comments survive and the entry leads the list', async () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');
  const fixturePatch = [
    '# top-level comment before the block',
    '- insert:',
    '    # comment between the key and the first item',
    '    - id: old',
    '      # comment inside the old item',
    '      name: old-package',
    '# trailing comment after the block',
    '',
  ].join('\n');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch);
    const install = runInstaller(shell, fixture.profile);
    assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    const after = fsSync.readFileSync(fixture.patchFile, 'utf8');
    const { insertIndex, idLine } = assertAnchoredInsert(fixturePatch, after, 4);
    const lines = yamlLines(after);
    // Our entry is before every pre-existing comment inside the block.
    assert.equal(idLine, insertIndex + 1);
    assert.equal(lines[idLine + 1], `${' '.repeat(6)}name: "@deepseek-ai/dsh-tool-session-title"`);
    assert.match(lines[idLine + 2], /^    # comment between the key and the first item$/);
    for (const comment of [
      '# top-level comment before the block',
      '    # comment between the key and the first item',
      '      # comment inside the old item',
      '# trailing comment after the block',
    ]) {
      assert.ok(after.includes(`${comment}\n`), `comment must survive: ${comment}`);
    }
    assert.ok(after.indexOf('- id: tool-session-title') < after.indexOf('- id: old'), 'entry must precede the old item');
    assert.match(after, /^      name: old-package$/m, 'the old item must keep its own name');
  } finally {
    cleanTmpRoot();
  }
});

test('T23 rollback without a backup: exit non-zero, nothing deleted', async () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');
  const fixturePatch = [
    '- insert:',
    '    - id: magpie-mcp-magpie',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '',
  ].join('\n');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch);
    const install = runInstaller(shell, fixture.profile);
    assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    const installedText = fsSync.readFileSync(fixture.patchFile, 'utf8');
    for (const backup of fixture.backups()) fsSync.rmSync(backup, { force: true });
    assert.deepEqual(fixture.backups(), []);

    const rollback = runInstaller(shell, fixture.profile, '-Rollback');
    assert.notEqual(rollback.status, 0, 'rollback without a backup must fail');
    assert.match(rollback.stdout, /No backup found/);
    assert.equal(fsSync.existsSync(fixture.packageDir), true, 'the package directory must survive');
    assert.equal(fsSync.readFileSync(fixture.patchFile, 'utf8'), installedText, 'the patch must be unchanged');
    assert.deepEqual(fixture.backups(), [], 'a refused rollback must not create files');
  } finally {
    cleanTmpRoot();
  }
});

test('T24 rollback when the backup still registers the plugin: exit non-zero, nothing deleted', async () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');
  const fixturePatch = [
    '- insert:',
    '    - id: magpie-mcp-magpie',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '',
  ].join('\n');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch);
    const install = runInstaller(shell, fixture.profile);
    assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    const installedText = fsSync.readFileSync(fixture.patchFile, 'utf8');
    for (const backup of fixture.backups()) fsSync.rmSync(backup, { force: true });
    assert.ok(installedText.includes('- id: tool-session-title'));

    // The only backup is a post-install copy: it still registers the plugin.
    const unsafeBackup = pathMod.join(fixture.profile, 'cordis.patch.yml.bak.20990101000000-unsafe');
    fsSync.writeFileSync(unsafeBackup, installedText, 'utf8');
    assert.deepEqual(fixture.backups(), [unsafeBackup]);

    const rollback = runInstaller(shell, fixture.profile, '-Rollback');
    assert.notEqual(rollback.status, 0, 'rollback with an unsafe backup must fail');
    assert.match(rollback.stdout, /references tool-session-title|still register/i);
    assert.equal(fsSync.existsSync(fixture.packageDir), true, 'the package directory must survive');
    assert.equal(fsSync.readFileSync(fixture.patchFile, 'utf8'), installedText, 'the patch must be unchanged');
    assert.equal(fsSync.readFileSync(unsafeBackup, 'utf8'), installedText, 'the backup must not be modified');
  } finally {
    cleanTmpRoot();
  }
});

test('T25 -Force with a broken source: old package and patch survive', async () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');
  const fixturePatch = [
    '- insert:',
    '    - id: magpie-mcp-magpie',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '',
  ].join('\n');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch);
    const install = runInstaller(shell, fixture.profile);
    assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    const installedText = fsSync.readFileSync(fixture.patchFile, 'utf8');
    const installedIndex = fsSync.readFileSync(pathMod.join(fixture.packageDir, 'lib', 'index.js'), 'utf8');

    // A source tree that passes the preflight (package.json + lib/index.js
    // exist) but fails mid-copy must be impossible to detect before staging;
    // the closest reproducible failure is a source that vanishes entirely,
    // which still exercises "refuse before touching the old package".
    const missingSource = pathMod.join(TMP_ROOT, 'missing-src');
    const forced = runInstaller(shell, fixture.profile, '-Force', '-SourcePath', missingSource);
    assert.notEqual(forced.status, 0, 'install from a missing source must fail');
    assert.equal(fsSync.existsSync(fixture.packageDir), true, '-Force must not delete the old package');
    assert.equal(
      fsSync.readFileSync(pathMod.join(fixture.packageDir, 'lib', 'index.js'), 'utf8'),
      installedIndex,
      'the old package content must be untouched',
    );
    assert.equal(fsSync.readFileSync(fixture.patchFile, 'utf8'), installedText, 'the patch must be unchanged');

    // Same requirement for an incomplete source (no lib/index.js).
    const incomplete = pathMod.join(TMP_ROOT, 'incomplete-src');
    fsSync.mkdirSync(incomplete, { recursive: true });
    fsSync.writeFileSync(pathMod.join(incomplete, 'package.json'), '{"name":"@deepseek-ai/dsh-tool-session-title"}', 'utf8');
    const incompleteRun = runInstaller(shell, fixture.profile, '-Force', '-SourcePath', incomplete);
    assert.notEqual(incompleteRun.status, 0, 'install from an incomplete source must fail');
    assert.equal(fsSync.existsSync(fixture.packageDir), true);
    assert.equal(fsSync.readFileSync(fixture.patchFile, 'utf8'), installedText);

    // No staging or '.old' leftovers may remain after a refused install.
    const modulesDir = pathMod.dirname(fixture.packageDir);
    const junk = fsSync.readdirSync(modulesDir).filter((entry) => entry.startsWith('.dsh-tool-session-title.'));
    assert.deepEqual(junk, [], `staging leftovers: ${junk.join(', ')}`);
  } finally {
    cleanTmpRoot();
  }
});

test('T26 UTF-8 fidelity under Windows PowerShell 5.1: Chinese bytes survive', () => {
  const shell = pickShell('powershell');
  assert.ok(shell !== null, 'Windows PowerShell 5.1 (powershell.exe) is required for this case');

  const fixturePatch = [
    '# 配置注释：中文路径与提示词必须原样保留',
    '# profile: C:\\Users\\测试用户\\.dsh\\profiles\\desktop',
    '- id: existing-plugin',
    '  config:',
    '    prompt: "让 agent 主动管理会话标题，规则：<type>(<scope>): <主题>"',
    '    path: "D:\\工作区\\会话标题\\插件"',
    '- insert:',
    '    - id: magpie-mcp-magpie',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '',
  ].join('\n');

  cleanTmpRoot();
  try {
    const fixture = makeProfile(fixturePatch, 'desktop-utf8');
    const originalBytes = fsSync.readFileSync(fixture.patchFile);

    const install = runInstaller(shell, fixture.profile);
    assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);
    const installed = fsSync.readFileSync(fixture.patchFile);
    // No BOM, no replacement characters, no ANSI mojibake.
    assert.notDeepEqual([...installed.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no BOM may be written');
    assert.equal(installed.includes(Buffer.from('\uFFFD', 'utf8')), false, 'no U+FFFD may appear');
    const installedText = installed.toString('utf8');
    for (const line of fixturePatch.split('\n').filter((entry) => entry.length > 0)) {
      assert.ok(installedText.includes(`${line}\n`), `original line must survive byte-for-byte: ${line}`);
    }
    // The entry itself is ASCII and correctly anchored.
    assertAnchoredInsert(fixturePatch, installedText, 4);

    // The backup holds the original bytes exactly.
    const [backup] = fixture.backups();
    assert.ok(backup !== undefined, 'install must create a backup');
    assert.deepEqual([...fsSync.readFileSync(backup)], [...originalBytes], 'backup must byte-match the original');

    // Rollback restores the original bytes exactly.
    const rollback = runInstaller(shell, fixture.profile, '-Rollback');
    assert.equal(rollback.status, 0, `rollback failed:\n${rollback.stdout}\n${rollback.stderr}`);
    assert.deepEqual([...fsSync.readFileSync(fixture.patchFile)], [...originalBytes], 'rollback must restore identical bytes');
  } finally {
    cleanTmpRoot();
  }
});

test('T27 unsafe layouts fail without touching the patch; comment mentions are not registrations', () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');

  cleanTmpRoot();
  try {
    // 1. Inline empty list: no safe anchor, so the install must fail cleanly.
    const inline = makeProfile('plugins: []\n- insert: []\n', 'desktop-inline');
    const inlineRun = runInstaller(shell, inline.profile);
    assert.notEqual(inlineRun.status, 0, 'an inline [] insert block must be a hard failure');
    assert.equal(fsSync.readFileSync(inline.patchFile, 'utf8'), 'plugins: []\n- insert: []\n', 'the patch must be untouched');
    assert.equal(fsSync.existsSync(inline.packageDir), false, 'no package may be created on failure');

    // 2. No insert block at all: hard failure, nothing written.
    const missing = makeProfile('- id: existing-plugin\n  config: { a: 1 }\n', 'desktop-missing');
    const missingRun = runInstaller(shell, missing.profile);
    assert.notEqual(missingRun.status, 0, 'a patch with no insert block must be a hard failure');
    assert.equal(fsSync.readFileSync(missing.patchFile, 'utf8'), '- id: existing-plugin\n  config: { a: 1 }\n');
    assert.equal(fsSync.existsSync(missing.packageDir), false);

    // 3. A comment that merely mentions the plugin id is NOT a registration:
    //    the real entry must still be added.
    const commented = makeProfile([
      '# - id: tool-session-title',
      '- insert:',
      '    - id: magpie-mcp-magpie',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '',
    ].join('\n'), 'desktop-comment');
    const commentedRun = runInstaller(shell, commented.profile);
    assert.equal(commentedRun.status, 0, `install failed:\n${commentedRun.stdout}\n${commentedRun.stderr}`);
    const commentedText = fsSync.readFileSync(commented.patchFile, 'utf8');
    assert.equal((commentedText.match(/^ *- id: tool-session-title$/gm) ?? []).length, 1, 'the real entry must be inserted');

    // 4. The real entry present => idempotent no-op (no new backup, no write).
    const backupCount = commented.backups().length;
    const rerun = runInstaller(shell, commented.profile);
    assert.equal(rerun.status, 0, `re-install failed:\n${rerun.stdout}\n${rerun.stderr}`);
    assert.equal(fsSync.readFileSync(commented.patchFile, 'utf8'), commentedText);
    assert.equal(commented.backups().length, backupCount, 'an idempotent re-run must not add a backup');
  } finally {
    cleanTmpRoot();
  }
});

test('T28 a nested config.name does not skew the inserted entry indentation', () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');

  cleanTmpRoot();
  try {
    const before = [
      '- insert:',
      '    - id: old',
      '      name: old-package',
      '      config:',
      '        name: nested-value',
      '',
    ].join('\n');
    const p = makeProfile(before, 'desktop-nested-name');
    const run = runInstaller(shell, p.profile);
    assert.equal(run.status, 0, `install failed:\n${run.stdout}\n${run.stderr}`);

    const after = fsSync.readFileSync(p.patchFile, 'utf8');
    // The sibling key indentation is 4; a scan for the first `name:` line
    // would find the nested one at 8 and emit a mis-indented entry.
    assertAnchoredInsert(before, after, 4);
    assert.match(after, /^ {8}name: nested-value$/m, 'the nested config.name must survive unchanged');
  } finally {
    cleanTmpRoot();
  }
});

test('T29 a CRLF patch still detects an existing registration', () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');

  cleanTmpRoot();
  try {
    const before = [
      '- insert:',
      '    - id: tool-session-title',
      '      name: "@deepseek-ai/dsh-tool-session-title"',
      '',
    ].join('\r\n');
    const p = makeProfile(before, 'desktop-crlf');
    const run = runInstaller(shell, p.profile);
    assert.equal(run.status, 0, `install failed:\n${run.stdout}\n${run.stderr}`);

    const after = fsSync.readFileSync(p.patchFile, 'utf8');
    assert.equal(
      (after.match(/^ *- id: tool-session-title\r?$/gm) ?? []).length,
      1,
      'a CRLF registration must be detected, not duplicated',
    );
  } finally {
    cleanTmpRoot();
  }
});

test('T30 rollback refuses a backup that references the package under a custom id', () => {
  const shell = pickShell('pwsh') ?? pickShell('powershell');
  assert.ok(shell !== undefined, 'neither pwsh nor powershell is available');

  cleanTmpRoot();
  try {
    const original = [
      '- insert:',
      '    - id: my-custom-title',
      '      name: "@deepseek-ai/dsh-tool-session-title"',
      '',
    ].join('\n');
    const p = makeProfile(original, 'desktop-custom-id');
    fsSync.mkdirSync(p.packageDir, { recursive: true });
    fsSync.writeFileSync(pathMod.join(p.packageDir, 'package.json'), '{"name":"dsh-tool-session-title"}\n', 'utf8');
    // A backup that still points at the package (custom id, so the precise
    // entry matcher cannot see it) must be treated as unsafe.
    fsSync.writeFileSync(`${p.patchFile}.bak.20260101000000-aaaaaaaa`, original, 'utf8');

    const run = runInstaller(shell, p.profile, '-Rollback');
    assert.notEqual(run.status, 0, `rollback must refuse:\n${run.stdout}\n${run.stderr}`);
    assert.ok(fsSync.existsSync(p.packageDir), 'the package must survive a refused rollback');
    assert.equal(fsSync.readFileSync(p.patchFile, 'utf8'), original, 'the patch must be untouched');
  } finally {
    cleanTmpRoot();
  }
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const { name: caseName, fn } of cases) {
  try {
    await fn();
    console.log(`✓ ${caseName}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${caseName}`);
    console.log(`  ${error && error.stack ? error.stack : String(error)}`);
  }
}

const total = cases.length;
if (failures === 0) {
  console.log(`\n✓ ${total} tests passed`);
  process.exit(0);
} else {
  console.log(`\n✗ ${failures} of ${total} tests failed`);
  process.exit(1);
}
