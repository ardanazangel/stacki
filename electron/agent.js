// Chat panel backend — runs any CLI coding harness the user already has
// installed, non-interactively, with the open Astro project as its cwd.
// The harness edits files itself; the existing src/ watcher reflects those
// edits back into the app, so nothing here touches the page model.
//
// ponytail: one-shot `spawn` per message instead of a real PTY. No native
// deps, but no TUI and no mid-run approval prompts — every harness runs with
// its "don't ask" flag. Upgrade path: node-pty + xterm.js.

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

// Chatter the CLIs print regardless: not events, not worth a line in the panel.
const NOISE = /^(Reading additional input from stdin|warning: `--full-auto`)/;

// Neither CLI can list its models. What each one *can* tell us is what this
// machine actually runs: the model named in its config, and the models past
// sessions recorded. That beats a hardcoded list, which goes stale the day a
// provider ships a new name.
//
// Session logs are the expensive part — 250MB of them is not unusual — so the
// walk is bounded three ways: newest files first, only the head of each, and
// a total byte budget. It stops early once it has a plausible catalog.
const HOME = os.homedir();

const SCAN_HEAD = 256 * 1024; // per file
const SCAN_BUDGET = 8 << 20; // total bytes read
const SCAN_ENOUGH = 8; // models after which the rest adds nothing

function headOf(file, bytes = SCAN_HEAD) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Newest first. Session filenames are dated for some CLIs and random UUIDs
// for others, so mtime is the only ordering that holds for both.
function newestFirst(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, String(f));
      try {
        return { full, at: fs.statSync(full).mtimeMs };
      } catch {
        return { full, at: 0 };
      }
    })
    .sort((a, b) => b.at - a.at)
    .map((e) => e.full);
}

function scanModels({ config, configRe, sessions, sessionRe, skip }) {
  const found = new Set();
  const keep = (m) => m && !skip?.test(m) && found.add(m);
  try {
    for (const m of fs.readFileSync(config, 'utf8').matchAll(configRe)) keep(m[1]);
  } catch {
    /* no config yet */
  }
  try {
    let budget = SCAN_BUDGET;
    for (const file of newestFirst(sessions)) {
      if (budget <= 0 || found.size >= SCAN_ENOUGH) break;
      const head = headOf(file, Math.min(SCAN_HEAD, budget));
      budget -= head.length;
      for (const m of head.matchAll(sessionRe)) keep(m[1]);
    }
  } catch {
    /* no sessions yet */
  }
  return [...found];
}

const codexModels = () =>
  scanModels({
    config: path.join(HOME, '.codex', 'config.toml'),
    configRe: /^\s*model\s*=\s*"([^"]+)"/gm,
    sessions: path.join(HOME, '.codex', 'sessions'),
    sessionRe: /"model"\s*:\s*"([^"]+)"/g,
  });

// Claude logs a turn per line and tags internal turns as <synthetic>, which
// is not a model anyone can pick.
const claudeModels = () =>
  scanModels({
    config: path.join(HOME, '.claude', 'settings.json'),
    configRe: /"model"\s*:\s*"([^"]+)"/g,
    sessions: path.join(HOME, '.claude', 'projects'),
    sessionRe: /"model"\s*:\s*"(claude-[^"]+)"/g,
    skip: /^<|^default$/,
  });

// The aliases Claude documents for --model ('opus', 'sonnet', …). They change
// with the CLI, so they're read from its own help rather than pinned here.
// Everything after "full name" is an example of a versioned name, not an alias.
function parseClaudeAliases(help) {
  const flat = help.replace(/\s+/g, ' ');
  const block = flat.match(/--model <model>(.*?)(?:-[a-zA-Z-]+ [<[]|$)/)?.[1] || '';
  const aliases = block.split('full name')[0].match(/'[a-z0-9][a-z0-9.-]*'/g) || [];
  return aliases.map((a) => a.slice(1, -1));
}

// The rest of the catalog: the models the harness's provider currently ships,
// from the models.dev index (the same public catalog other agents use). Local
// history only knows what this machine has already run — this is how a model
// released yesterday shows up in the dropdown.
//
// The index is one 3MB document for 170+ providers, so it's reduced to ids on
// the way in and cached for a day. Offline, or if it moves, the local sources
// still stand on their own: this never throws and never blocks a run.
const CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_FILE = path.join(os.tmpdir(), 'stacki-models.json');
const CATALOG_TTL = 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT = 10000;

// Coding harnesses can only drive models that take tool calls and answer in
// text — image and embedding models would just be dead entries in the list.
const usable = (m) => m?.tool_call && m.modalities?.output?.includes('text');

// And only what's current: a provider's catalog keeps every model it ever
// shipped, so without this the dropdown fills with retired names (o3,
// claude-opus-4-1, dated duplicates of models already listed). Anything
// published or revised in the last six months counts as current; if a
// provider has shipped nothing in that window, its newest per family stands
// in, so the list is never empty.
const FRESH_DAYS = 183;
const dateOf = (m) => String(m.last_updated || m.release_date || '');

function currentModels(models) {
  const cutoff = new Date(Date.now() - FRESH_DAYS * 86400000).toISOString().slice(0, 10);
  const fresh = models.filter((m) => dateOf(m) >= cutoff);
  if (fresh.length) return fresh;
  const newest = new Map();
  for (const m of models) {
    const key = m.family || m.id;
    if (dateOf(m) >= dateOf(newest.get(key) || {})) newest.set(key, m);
  }
  return [...newest.values()];
}

function reduceCatalog(data) {
  const out = {};
  for (const [provider, entry] of Object.entries(data || {})) {
    const models = currentModels(Object.values(entry?.models || {}).filter(usable))
      .sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
      .map((m) => m.id);
    if (models.length) out[provider] = models;
  }
  return out;
}

let catalogPromise = null;

async function catalog() {
  try {
    const stat = fs.statSync(CATALOG_FILE);
    if (Date.now() - stat.mtimeMs < CATALOG_TTL) {
      return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    }
  } catch {
    /* not fetched yet, or unreadable */
  }
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT) });
  if (!res.ok) throw new Error(`models.dev: ${res.status}`);
  const reduced = reduceCatalog(await res.json());
  try {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(reduced));
  } catch {
    /* no cache, just a fetch per app run */
  }
  return reduced;
}

async function catalogModels(provider) {
  if (!provider) return [];
  // One fetch per app run at most, however many harnesses ask.
  catalogPromise = catalogPromise || catalog().catch(() => ({}));
  return (await catalogPromise)[provider] || [];
}

// Claude only streams structured events in print mode, and only with
// --verbose alongside.
const CLAUDE_JSON = ['--output-format', 'stream-json', '--verbose'];

const summarise = (name, input = {}) => {
  const target = input.file_path || input.path || input.pattern || input.command || '';
  return target ? `${name} ${String(target).split('\n')[0].slice(0, 120)}` : name;
};

// {"type":"assistant","message":{"content":[{type:'text'|'thinking'|'tool_use'}]}}
// plus a final {"type":"result"} that repeats the answer, so it's dropped.
function parseClaude(evt) {
  const out = [];
  if (evt.type === 'assistant') {
    for (const block of evt.message?.content || []) {
      if (block.type === 'text' && block.text) out.push({ kind: 'text', text: block.text });
      else if (block.type === 'thinking' && block.thinking)
        out.push({ kind: 'thinking', text: block.thinking });
      else if (block.type === 'tool_use')
        out.push({ kind: 'tool', text: summarise(block.name, block.input) });
    }
  } else if (evt.type === 'result' && evt.is_error) {
    out.push({ kind: 'text', text: String(evt.result || 'failed') });
  }
  return out;
}

// {"type":"item.completed","item":{"type":"agent_message"|"reasoning"|…}}
function parseCodex(evt) {
  if (evt.type !== 'item.completed') return [];
  const item = evt.item || {};
  if (item.type === 'agent_message') return [{ kind: 'text', text: item.text || '' }];
  if (item.type === 'reasoning') return [{ kind: 'thinking', text: item.text || item.summary || '' }];
  if (item.type === 'command_execution')
    return [{ kind: 'tool', text: `$ ${String(item.command || '').replace(/^\S*sh -l?c /, '')}` }];
  if (item.type === 'file_change' || item.type === 'patch_apply') {
    const files = (item.changes || []).map((c) => c.path).join(', ');
    return [{ kind: 'tool', text: `edit ${files || ''}`.trim() }];
  }
  if (item.type === 'error') return [{ kind: 'text', text: item.message || 'error' }];
  return [];
}

// args/resume take (prompt, modelFlags) and splice the model where that CLI
// wants it — subcommand-based ones reject a leading --model. `resume`
// continues the last session in this cwd; omit it and every message starts
// clean. `hasModel` marks harnesses that accept a model at all; `models` is
// the catalog the panel offers — `cmd`/`parse` asks the CLI, `scan` reads what
// this machine has run — and without one the panel falls back to free text.
//
// `parse` turns one line of the CLI's JSON stream into normalised events:
// kind 'text' is the answer, 'thinking' and 'tool' are the work behind it,
// which the panel keeps folded away. A harness without `parse` streams its
// raw output as 'text'.
const HARNESSES = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    args: (p, m) => [...CLAUDE_JSON, '--permission-mode', 'acceptEdits', ...m, '-p', p],
    resume: (p, m) => [
      ...CLAUDE_JSON,
      '--permission-mode',
      'acceptEdits',
      '--continue',
      ...m,
      '-p',
      p,
    ],
    parse: parseClaude,
    hasModel: true,
    modelFlag: (m) => ['--model', m],
    provider: 'anthropic',
    models: { cmd: ['--help'], parse: parseClaudeAliases, scan: claudeModels },
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    // --full-auto is deprecated, and without --skip-git-repo-check codex
    // refuses to touch a project that isn't a trusted git repo.
    args: (p, m) => [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      ...m,
      p,
    ],
    // `exec resume` takes no --sandbox flag — the config override is the way in.
    resume: (p, m) => [
      'exec',
      'resume',
      '--last',
      '--json',
      '-c',
      'sandbox_mode=workspace-write',
      '--skip-git-repo-check',
      ...m,
      p,
    ],
    parse: parseCodex,
    hasModel: true,
    modelFlag: (m) => ['--model', m],
    provider: 'openai',
    models: { scan: codexModels },
  },
];

function which(bin) {
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function listHarnesses() {
  return HARNESSES.map((h) => ({
    id: h.id,
    name: h.name,
    bin: which(h.bin),
    canPickModel: !!h.hasModel,
  })).filter((h) => h.bin);
}

// Asking the CLI costs a process spawn and its answer doesn't change while
// the app is open, so only that half is cached; the local scan is redone
// every time, and picks up a model the user just switched to in the CLI.
const modelCache = new Map();

function askCli(h, harnessId) {
  if (!h.models?.cmd) return Promise.resolve([]);
  if (modelCache.has(harnessId)) return Promise.resolve(modelCache.get(harnessId));
  const bin = which(h.bin);
  if (!bin) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      bin,
      h.models.cmd,
      { env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 4 << 20, timeout: 20000 },
      (err, stdout, stderr) => {
        let out = [];
        try {
          out = h.models.parse(`${stdout || ''}${stderr || ''}`);
        } catch {
          out = [];
        }
        if (out.length) modelCache.set(harnessId, out);
        resolve(out);
      }
    );
  });
}

// Everything this install can offer, in the order people reach for it: the
// aliases the CLI documents, then the models this machine has actually run,
// then the provider's full catalog. Duplicates collapse, and a source that
// fails contributes nothing rather than breaking the list.
async function listModels(harnessId) {
  const h = HARNESSES.find((x) => x.id === harnessId);
  if (!h?.hasModel) return [];
  const [fromCli, fromCatalog] = await Promise.all([
    askCli(h, harnessId),
    catalogModels(h.provider),
  ]);
  const fromDisk = h.models?.scan ? h.models.scan() : [];
  return [...new Set([...fromCli, ...fromDisk, ...fromCatalog])];
}

let current = null; // { proc, id }
let runSeq = 0;

// A clean quit cancels the run, but a crash, a force-quit or a `kill -9`
// never reaches before-quit — and the harness lives in its own process group,
// so it survives the app and keeps writing to the project with nobody
// watching. The live run is recorded on disk and whatever a previous session
// left behind is taken down at startup.
//
// ponytail: the orphan still runs until the next launch, and the check is
// POSIX-only (`ps` to confirm the pid wasn't recycled). Upgrade path: a job
// object on Windows, and a heartbeat the harness wrapper watches.
const LIVE_FILE = path.join(os.tmpdir(), 'stacki-agent-run.json');

const forget = () => {
  try {
    fs.rmSync(LIVE_FILE, { force: true });
  } catch {
    /* nothing to clear */
  }
};

const remember = (pid, bin) => {
  try {
    fs.writeFileSync(LIVE_FILE, JSON.stringify({ pid, bin }));
  } catch {
    /* no record just means no cleanup next time */
  }
};

function killOrphan() {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  } catch {
    return; // nothing recorded: the last run ended cleanly
  }
  forget();
  if (!rec?.pid || isWin) return;
  try {
    // The pid may have been recycled since; only kill it if it is still the
    // harness we spawned.
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(rec.pid)], {
      encoding: 'utf8',
    });
    if (!cmd.includes(rec.bin)) return;
    process.kill(-rec.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

killOrphan();

// Esc has to stop the run now. A harness shells out for its tools, and those
// children inherit the pipes: signalling only the parent leaves them holding
// stdout open, so the run reads as still busy long after it was cancelled.
// Hence the whole process group, with SIGKILL close behind SIGTERM.
function cancel() {
  if (!current) return { ok: false };
  const { proc } = current;
  current = null;
  const signal = (sig) => {
    try {
      if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: true });
      else process.kill(-proc.pid, sig); // negative pid = the group
    } catch {
      try {
        proc.kill(sig); // group already gone, or never made one
      } catch {
        /* already dead */
      }
    }
  };
  signal('SIGTERM');
  const hard = setTimeout(() => signal('SIGKILL'), 2000);
  proc.once('close', () => clearTimeout(hard));
  forget();
  return { ok: true };
}

// Undo support: src/ is copied aside before each run, so a harness that goes
// wrong can be rolled back. Plain file copies, not git — the project may not
// be a repo, and the user's index and stashes stay untouched.
//
// ponytail: only src/ is covered. A harness that rewrites astro.config.mjs or
// package.json can't be undone from here. Upgrade path: snapshot the whole
// project minus node_modules/dist/.git, or commit to a hidden git ref.
const SNAP_DIR = path.join(os.tmpdir(), 'stacki-undo');
const SNAP_KEEP = 8;
const SNAP_MAX_BYTES = 40 << 20;

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    try {
      total += fs.statSync(path.join(e.parentPath || e.path, e.name)).size;
    } catch {
      /* vanished mid-walk */
    }
    if (total > SNAP_MAX_BYTES) return total;
  }
  return total;
}

function snapshot(cwd) {
  const src = path.join(cwd, 'src');
  if (!fs.existsSync(src)) return null;
  try {
    if (dirSize(src) > SNAP_MAX_BYTES) return null; // too big to be worth it
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.cpSync(src, path.join(SNAP_DIR, id), { recursive: true });
    // Keep the last few; the temp dir shouldn't grow without bound.
    const old = fs.readdirSync(SNAP_DIR).sort().slice(0, -SNAP_KEEP);
    for (const d of old) fs.rmSync(path.join(SNAP_DIR, d), { recursive: true, force: true });
    return id;
  } catch {
    return null; // no snapshot just means no undo, never a failed run
  }
}

// What the run changed, snapshot vs disk. Only text files, only src/.
//
// ponytail: +/- counts come from a multiset comparison of lines, not a real
// LCS diff, so moved lines read as unchanged. Good enough for a summary;
// upgrade path is a proper diff if anyone needs hunks with context.
const DIFF_MAX_FILES = 40;
const DIFF_MAX_BYTES = 512 * 1024;
const DIFF_PREVIEW_LINES = 8;

function listFiles(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(root, path.join(e.parentPath || e.path, e.name)));
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > DIFF_MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function lineDelta(before, after) {
  const counts = new Map();
  for (const l of before.split('\n')) counts.set(l, (counts.get(l) || 0) + 1);
  const added = [];
  for (const l of after.split('\n')) {
    const n = counts.get(l) || 0;
    if (n > 0) counts.set(l, n - 1);
    else added.push(l);
  }
  const removed = [];
  for (const [l, n] of counts) for (let i = 0; i < n; i++) removed.push(l);
  return { added, removed };
}

function diffRun(snapshotId, cwd) {
  const from = path.join(SNAP_DIR, String(snapshotId || ''));
  const src = path.join(cwd || '', 'src');
  if (!snapshotId || !fs.existsSync(from) || !fs.existsSync(src)) return [];
  const before = new Set(listFiles(from));
  const after = new Set(listFiles(src));
  const files = [];
  for (const rel of new Set([...before, ...after])) {
    const old = before.has(rel) ? readText(path.join(from, rel)) : null;
    const now = after.has(rel) ? readText(path.join(src, rel)) : null;
    if (old === now) continue;
    const status = !before.has(rel) ? 'added' : !after.has(rel) ? 'deleted' : 'modified';
    // One side unreadable (binary or oversized): report it, skip the counts.
    if (old === null && now === null) {
      files.push({ path: rel, status, added: 0, removed: 0, preview: [] });
      continue;
    }
    const { added, removed } = lineDelta(old || '', now || '');
    if (!added.length && !removed.length) continue;
    const preview = [
      ...removed.slice(0, DIFF_PREVIEW_LINES).map((text) => ({ sign: '-', text })),
      ...added.slice(0, DIFF_PREVIEW_LINES).map((text) => ({ sign: '+', text })),
    ];
    files.push({ path: rel, status, added: added.length, removed: removed.length, preview });
    if (files.length >= DIFF_MAX_FILES) break;
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Undo only what the run touched. `files` is the change list recorded when the
// run finished; without it we'd also undo edits the user made afterwards to
// other files, which the run never touched.
function revert({ snapshotId, cwd, files }) {
  const from = path.join(SNAP_DIR, String(snapshotId || ''));
  const src = path.join(cwd || '', 'src');
  if (!snapshotId || !fs.existsSync(from)) return { ok: false, error: 'That snapshot is gone' };
  if (!cwd || !fs.existsSync(src)) return { ok: false, error: 'No project open' };
  const changed = Array.isArray(files) && files.length ? files : diffRun(snapshotId, cwd);
  if (!changed.length) return { ok: false, error: 'Nothing to revert' };
  try {
    for (const f of changed) {
      const target = path.join(src, f.path);
      const source = path.join(from, f.path);
      if (f.status === 'added') {
        fs.rmSync(target, { force: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
    }
    return { ok: true, files: changed.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Streams stdout/stderr to the renderer as they arrive; resolves when the
// process exits. `send` is main.js's window emitter.
function run(send, { harnessId, prompt, cwd, resume, model }) {
  const h = HARNESSES.find((x) => x.id === harnessId);
  if (!h) return Promise.resolve({ ok: false, error: `Unknown harness: ${harnessId}` });
  const bin = which(h.bin);
  if (!bin) return Promise.resolve({ ok: false, error: `${h.name} is not on your PATH` });
  if (!cwd || !fs.existsSync(cwd)) return Promise.resolve({ ok: false, error: 'No project open' });
  if (current) cancel();

  const flags = model && h.hasModel ? h.modelFlag(model) : [];
  const argv = resume && h.resume ? h.resume(prompt, flags) : h.args(prompt, flags);
  const snapshotId = snapshot(cwd);
  const runId = ++runSeq;
  let proc;
  try {
    // stdin closed, not piped: codex treats an open pipe as extra prompt input.
    proc = spawn(bin, argv, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin, // its own process group, so cancel can take the tools down too
    });
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e.message || e) });
  }
  current = { proc, id: runId };
  remember(proc.pid, bin);

  return new Promise((resolve) => {
    const push = (kind, text) => {
      if (text && current?.id === runId) send('agent:chunk', { runId, kind, text });
    };

    // JSON harnesses emit one event per line; a chunk can split a line in two.
    let pending = '';
    const onStdout = (buf) => {
      if (!h.parse) return push('text', buf.toString());
      pending += buf.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          // Not an event: a warning or a banner the CLI printed anyway.
          if (!NOISE.test(line)) push('tool', line.trim());
          continue;
        }
        for (const e of h.parse(evt)) push(e.kind, e.text);
      }
    };

    proc.stdout.on('data', onStdout);
    // For JSON harnesses stderr is only banners and warnings. For plain ones
    // it can carry the answer itself — some CLIs write everything to stderr
    // when stdout isn't a TTY, and routing that to the notes hides the reply.
    const stderrKind = h.parse ? 'tool' : 'text';
    proc.stderr.on('data', (buf) => {
      const text = buf.toString().trim();
      if (text && !NOISE.test(text)) push(stderrKind, text);
    });
    proc.on('error', (e) => {
      if (current?.id === runId) current = null;
      resolve({ ok: false, error: String(e.message || e) });
    });
    proc.on('close', (code) => {
      const cancelled = current?.id !== runId;
      if (!cancelled) current = null;
      forget();
      // The diff is computed here, once, while the snapshot is certainly still
      // around: the panel gets it with the result instead of asking again.
      const changes = snapshotId ? diffRun(snapshotId, cwd) : [];
      resolve({
        ok: code === 0 && !cancelled,
        code,
        cancelled,
        runId,
        snapshotId: changes.length ? snapshotId : null,
        changes,
      });
    });
  });
}

module.exports = { listHarnesses, listModels, run, cancel, revert };
