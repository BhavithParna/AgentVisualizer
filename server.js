#!/usr/bin/env node
// Agent Visualizer: live view of Claude Code sessions and their subagents.
// Reads the transcripts Claude Code already writes under ~/.claude/projects (read-only).
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const PORT = +flag('port', process.env.PORT || 4517);
const HOURS = +flag('hours', 24);
const TICK = 1000, KEEP = 40, CHUNK = 4 << 20;
const WANT = ['"type":"assistant"', '"type":"user"', '"type":"ai-title"'];

class Tail {
  constructor(p) { this.p = p; this.off = 0; this.rest = null; this.mtime = 0; }
  read(onEntry) {
    let st; try { st = fs.statSync(this.p); } catch { return; }
    this.mtime = st.mtimeMs;
    if (st.size < this.off) { this.off = 0; this.rest = null; }
    if (st.size === this.off) return;
    const fd = fs.openSync(this.p, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - this.off));
      while (this.off < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - this.off), this.off);
        if (n <= 0) break;
        this.off += n;
        const chunk = buf.subarray(0, n);
        let start = 0, i;
        while ((i = chunk.indexOf(10, start)) !== -1) {
          let line = chunk.subarray(start, i);
          if (this.rest) { line = Buffer.concat([this.rest, line]); this.rest = null; }
          start = i + 1;
          if (!line.length || !WANT.some(w => line.includes(w))) continue;
          try { onEntry(JSON.parse(line.toString('utf8'))); } catch {}
        }
        if (start < n) {
          const tail = Buffer.from(chunk.subarray(start));
          this.rest = this.rest ? Buffer.concat([this.rest, tail]) : tail;
        }
      }
    } finally { fs.closeSync(fd); }
  }
}

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = p => String(p || '').split('/').filter(Boolean).pop() || '';

function summarize(name, inp) {
  if (!inp || typeof inp !== 'object') return '';
  const pick =
    name === 'Bash' ? (inp.description || '') :   // never show a raw shell command
    name === 'Monitor' ? (inp.description || '') :
    /^(Read|Edit|Write|NotebookEdit)$/.test(name) ? base(inp.file_path || inp.notebook_path) :
    /^(Grep|Glob)$/.test(name) ? inp.pattern :
    /^(Agent|Task)$/.test(name) ? inp.description :
    name === 'Skill' ? inp.skill :
    name === 'WebSearch' ? inp.query :
    name === 'WebFetch' ? inp.url :
    name === 'ToolSearch' ? inp.query :
    (inp.description || inp.message || Object.values(inp).find(v => typeof v === 'string'));
  return clip(pick, 140);
}

const CATS = ['say', 'think', 'read', 'search', 'edit', 'run', 'agent'];
const cat = n => /^(Read|ToolSearch|Skill)$/.test(n) ? 2 : /^(Grep|Glob|WebSearch|WebFetch)$/.test(n) ? 3 :
  /^(Edit|Write|NotebookEdit)$/.test(n) ? 4 : /^(Agent|Task|Workflow|SendMessage|SubagentHandback)$/.test(n) ? 6 : 5;
const WINDOW = 11 * 60e3;

const newState = () => ({
  model: null, effort: null, started: 0, last: 0, out: 0, ctx: 0, tools: 0, errors: 0,
  stop: null, prompt: '', task: '', title: '', cwd: '', activity: [], hist: [], cats: [0, 0, 0, 0, 0, 0, 0], brief: '', taskRaw: '', files: new Map(), _msgs: new Map(),
});

function ingest(s, e) {
  const ts = Date.parse(e.timestamp) || 0;
  if (e.type === 'ai-title') { s.title = e.aiTitle || e.title || s.title; return; }
  if (ts) { if (!s.started) s.started = ts; if (ts > s.last) s.last = ts; }
  if (e.cwd) s.cwd = e.cwd;
  const m = e.message;
  if (!m) return;
  const push = a => { a.ts = ts; s.activity.push(a); if (s.activity.length > KEEP) s.activity.shift();
    a.c = a.k === 'tool' ? cat(a.name) : a.k === 'think' ? 1 : 0; s.cats[a.c]++; s.hist.push([ts, a.c]); if (s.hist.length > 900) s.hist.splice(0, 300); };
  if (e.type === 'user') {
    const c = m.content;
    if (typeof c === 'string') {
      if (!e.isMeta && !c.startsWith('<')) { if (!s.prompt) { s.prompt = clip(c, 600); s.brief = c.slice(0, 6000); } s.task = clip(c, 240); s.taskRaw = c.slice(0, 6000); s.stop = null; }
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_result' && b.is_error) s.errors++;
        if (b.type === 'text' && !e.isMeta && b.text && !b.text.startsWith('<') && !s.prompt) { s.prompt = clip(b.text, 600); s.brief = b.text.slice(0, 6000); }
      }
    }
    return;
  }
  if (e.type !== 'assistant') return;
  if (m.model && m.model !== '<synthetic>') s.model = m.model;
  if (typeof e.effort === 'string') s.effort = e.effort;
  s.stop = m.stop_reason || s.stop;
  const u = m.usage;
  if (u && m.id) {
    const prev = s._msgs.get(m.id) || 0, cur = u.output_tokens || 0;
    if (cur > prev) { s.out += cur - prev; s._msgs.set(m.id, cur); }
    s.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'tool_use' && /^(Edit|Write|NotebookEdit)$/.test(b.name) && b.input) { const f = base(b.input.file_path || b.input.notebook_path); if (f) { s.files.delete(f); s.files.set(f, ts); } }
    if (b.type === 'tool_use') { s.tools++; push({ k: 'tool', name: b.name, s: summarize(b.name, b.input) }); }
    else if (b.type === 'text' && b.text && b.text.trim()) push({ k: 'text', s: clip(b.text.replace(/\*\*|`/g, ''), 220) });
    else if (b.type === 'thinking') { const l = s.activity[s.activity.length - 1]; if (!l || l.k !== 'think') push({ k: 'think', s: '' }); }
  }
}

// ---- plain-English task summaries: one small Haiku call per agent through the local claude CLI, cached on disk ----
const { spawn } = require('child_process');
const CACHE_DIR = path.join(os.homedir(), '.cache', 'agentscope'), CACHE = path.join(CACHE_DIR, 'summaries-v2.json');
const CLAUDE = args.includes('--no-summaries') ? null : [path.join(os.homedir(), '.local/bin/claude'), path.join(os.homedir(), '.claude/local/claude'),
  '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude', ...(process.env.PATH || '').split(path.delimiter).map(d => path.join(d, 'claude'))].find(p => p && fs.existsSync(p));
const SUMMARY_PROMPT = "You explain an AI agent's technical brief to a busy person glancing at a dashboard. " +
  'Reply with ONLY a JSON object with exactly these four string keys: ' +
  '"summary" (what the agent is doing: at most 2 short sentences, under 30 words, starting with a verb), ' +
  '"why" (why this piece matters to the bigger project, one sentence under 22 words), ' +
  '"makes" (what will exist when it is finished, one sentence under 22 words), ' +
  '"done" (how we will know it worked, one sentence under 22 words). ' +
  'Everyday words only: no file paths, no code, no version numbers, no jargon, no markdown.';
let summaries = {}; try { summaries = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
const pending = new Set(), failed = new Map(); let busy = 0;
function plainSummary(key, brief) {
  if (!CLAUDE || !brief || summaries[key] || pending.has(key) || busy >= 2 || (failed.get(key) || 0) >= 2) return;
  pending.add(key); busy++;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const ch = spawn(CLAUDE, ['-p', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--system-prompt', SUMMARY_PROMPT],
    { cwd: CACHE_DIR, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = ''; const timer = setTimeout(() => ch.kill(), 90e3);
  ch.stdout.on('data', d => out += d);
  ch.on('error', () => {});
  ch.on('close', code => {
    clearTimeout(timer); pending.delete(key); busy--;
    let o = null; try { o = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch {}
    if (code === 0 && o && typeof o.summary === 'string') {
      summaries[key] = { summary: clip(o.summary, 320), why: clip(o.why, 240), makes: clip(o.makes, 240), done: clip(o.done, 240) };
      try { fs.writeFileSync(CACHE, JSON.stringify(summaries)); } catch {}
    }
    else failed.set(key, (failed.get(key) || 0) + 1);
  });
  ch.stdin.on('error', () => {}); ch.stdin.end(brief);
}

const sessions = new Map(); // key: project/sessionId

function discover() {
  const cutoff = Date.now() - HOURS * 3600e3;
  let projects; try { projects = fs.readdirSync(ROOT); } catch { return; }
  for (const proj of projects) {
    const pdir = path.join(ROOT, proj);
    let files; try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const key = proj + '/' + f.slice(0, -6);
      if (sessions.has(key)) continue;
      let st; try { st = fs.statSync(path.join(pdir, f)); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      sessions.set(key, {
        id: f.slice(0, -6), proj, dir: path.join(pdir, f.slice(0, -6)),
        tail: new Tail(path.join(pdir, f)), root: newState(), agents: new Map(),
      });
    }
  }
}

function findAgents(sess) {
  const sub = path.join(sess.dir, 'subagents');
  const add = (dir, wf) => {
    let files; try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
      const id = f.slice(6, -6);
      if (sess.agents.has(id)) continue;
      sess.agents.set(id, {
        id, wf, tail: new Tail(path.join(dir, f)), state: newState(), meta: {},
        metaPath: path.join(dir, f.slice(0, -6) + '.meta.json'),
      });
    }
  };
  add(sub, null);
  let wfs; try { wfs = fs.readdirSync(path.join(sub, 'workflows')); } catch { wfs = []; }
  for (const w of wfs) add(path.join(sub, 'workflows', w), w);
}

function status(done, last, stop, sessionLive, now) {
  if (done) return 'done';
  const age = now - last;
  if (age < 120e3) return 'active';
  if (stop === 'end_turn') return 'done';
  return sessionLive ? 'waiting' : 'stalled';
}

// The plain-language "what is this agent for": the GOAL/TASK section if the brief has one, else its first paragraph.
function goalOf(p) {
  if (!p) return '';
  const m = p.match(/(?:^|\n)\s*(?:GOAL|TASK|OBJECTIVE|MISSION)\s*:\s*([\s\S]*?)(?=\n\s*\n|\s[A-Z][A-Z ]{2,}:\s|$)/);
  return clip((m ? m[1] : p.split(/\n\s*\n/)[0]).replace(/[*#]/g, ''), 700);
}

function pub(s, lite, briefOverride) {
  const from = Date.now() - WINDOW, brief = briefOverride ?? s.brief;
  return { files: [...s.files].slice(-8), hist: s.hist.filter(h => h[0] > from), cats: s.cats, goal: goalOf(brief), brief: lite ? '' : brief,
    model: s.model, effort: s.effort, started: s.started, last: s.last, out: s.out, ctx: s.ctx,
    tools: s.tools, errors: s.errors, activity: lite ? s.activity.slice(-3) : s.activity };
}

function snapshot() {
  discover();
  const now = Date.now(), out = [];
  for (const sess of sessions.values()) {
    sess.tail.read(e => ingest(sess.root, e));
    findAgents(sess);
    let lastAny = Math.max(sess.tail.mtime, sess.root.last);
    for (const a of sess.agents.values()) {
      a.tail.read(e => ingest(a.state, e));
      if (!a.meta.finished) { try { a.meta = JSON.parse(fs.readFileSync(a.metaPath, 'utf8')); } catch {} }
      lastAny = Math.max(lastAny, a.tail.mtime);
    }
    const live = now - lastAny < 15 * 60e3;
    const agents = [], wfKids = new Map();
    for (const a of sess.agents.values()) {
      const m = a.meta, s = a.state, last = Math.max(s.last, a.tail.mtime);
      const st = status(!!m.finished, last, s.stop, live, now);
      if (a.wf) { if (!wfKids.has(a.wf)) wfKids.set(a.wf, []); wfKids.get(a.wf).push({ st, s }); }
      const skey = sess.id + '/' + a.id;
      if (st !== 'done' || now - last < 30 * 60e3) plainSummary(skey, s.brief);
      agents.push({
        summary: summaries[skey]?.summary || '', detail: summaries[skey] || null, summarizing: pending.has(skey),
        id: a.id, parent: m.parentAgentId || a.wf || 'root', desc: m.description || clip(s.prompt, 60) || a.id,
        type: m.agentType || 'agent', phase: m.workflowPhase || null, depth: m.spawnDepth || 1,
        bg: m.requestShape === 'background', status: st, ...pub(s, st === 'done' && now - last > 30 * 60e3), last,
        model: s.model || m.model || null,
      });
    }
    for (const [w, kids] of wfKids) {
      agents.push({
        id: w, parent: 'root', desc: 'workflow ' + w.replace(/^wf_/, ''), type: 'workflow', depth: 1, hub: true,
        status: kids.some(k => k.st === 'active') ? 'active' : kids.some(k => k.st === 'waiting') ? 'waiting' : 'done',
        model: null, effort: null, started: Math.min(...kids.map(k => k.s.started || now)), last: Math.max(...kids.map(k => k.s.last)),
        out: 0, ctx: 0, tools: 0, errors: 0, goal: '', brief: '', files: [], hist: [], cats: [0, 0, 0, 0, 0, 0, 0], activity: [],
      });
    }
    if (now - lastAny > 30 * 60e3) continue;   // every session touched in the last half hour, helpers or not
    const r = sess.root, rlast = Math.max(r.last, sess.tail.mtime);
    out.push({
      key: sess.proj + '/' + sess.id, id: sess.id, project: base(r.cwd) || sess.proj, cwd: r.cwd,
      title: r.title || clip(r.task, 70) || sess.id.slice(0, 8), last: lastAny, live,
      root: { id: 'root', desc: r.title || 'main agent', type: 'main', depth: 0, task: r.task, ...pub(r, false, r.taskRaw), last: rlast,
        status: now - rlast < 120e3 ? 'active' : agents.some(a => a.status === 'active') ? 'waiting' : 'idle' },
      agents,
    });
  }
  out.sort((a, b) => b.last - a.last);
  return { now, hours: HOURS, sessions: out };
}

const clients = new Set();
let lastJson = '';
function tick() {
  let json;
  try { json = JSON.stringify(snapshot()); } catch (e) { console.error(e); return; }
  lastJson = json;
  for (const res of clients) res.write('data: ' + json + '\n\n');
}

const handler = (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (lastJson) res.write('data: ' + lastJson + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(lastJson); return; }
  if (req.url.startsWith('/vendor/')) {
    const f = path.join(__dirname, 'vendor', path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'font/woff2', 'Cache-Control': 'max-age=86400' });
    res.end(fs.readFileSync(f)); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
};

// start({ port, open }) resolves with the URL. If the port is already taken we assume another copy is
// serving (for example the login service) and simply point at it.
function start({ port = PORT, open = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = 'http://localhost:' + port;
    const srv = http.createServer(handler);
    srv.on('error', e => e.code === 'EADDRINUSE' ? resolve({ url, reused: true }) : reject(e));
    srv.listen(port, '127.0.0.1', () => {
      tick(); setInterval(tick, TICK);
      if (open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      resolve({ url, reused: false });
    });
  });
}
module.exports = { start };

if (require.main === module) {
  start({ open: !args.includes('--no-open') }).then(r =>
    console.log(r.reused ? 'Agent Visualizer is already running at ' + r.url : 'Agent Visualizer → ' + r.url));
}
