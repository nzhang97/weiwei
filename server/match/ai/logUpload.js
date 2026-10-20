// 提交给AI学习 → GitHub: uploads submitted action logs to a dedicated branch of a (private) GitHub repo so
// matches played on any device reach one place for AI training.
//
// Configured only through environment variables (put them in <repo>/.env, which is git-ignored):
//   AI_LOG_GITHUB_TOKEN   fine-grained token with "Contents: Read and write" on the repo (required to upload)
//   AI_LOG_GITHUB_REPO    owner/name                      (default nzhang97/weiwei)
//   AI_LOG_GITHUB_BRANCH  branch that holds only the logs  (default ai-logs; created as an orphan branch if missing)
//   AI_LOG_DEVICE         label stored in the file name    (default: the machine's host name)
//
// Files land at training/<YYYY-MM>/<logId>__<device>.json. Logs that fail to upload (offline, GitHub down) are
// queued in <trainingDir>/upload-queue.json and retried on the next submit and at server start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://api.github.com';
const QUEUE_FILE = 'upload-queue.json';
const SAFE = /[^0-9A-Za-z_-]+/g;

/** @returns {null | { token: string, repo: string, branch: string, device: string }} */
export function uploadConfig(env = process.env) {
  const token = String(env.AI_LOG_GITHUB_TOKEN || '').trim();
  if (!token) return null;
  const repo = String(env.AI_LOG_GITHUB_REPO || 'nzhang97/weiwei').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const branch = String(env.AI_LOG_GITHUB_BRANCH || 'ai-logs').trim() || 'ai-logs';
  const device = (String(env.AI_LOG_DEVICE || os.hostname() || 'device').replace(SAFE, '-').replace(/^-+|-+$/g, '') || 'device').slice(0, 40);
  return { token, repo, branch, device };
}

/** Repo path for a log: training/<YYYY-MM>/<id>__<device>.json (month from the id's yyyymmdd prefix, else today). */
export function remotePath(id, device, now = new Date()) {
  const m = /^(\d{4})(\d{2})\d{2}-/.exec(id);
  const ym = m ? `${m[1]}-${m[2]}` : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `training/${ym}/${id}__${device}.json`;
}

async function gh(cfg, method, url, body, fetchImpl, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${API}${url}`, {
      method,
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'stronghold-protocol-server',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* empty body */ }
    return { status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Create cfg.branch as an orphan branch holding a README (the logs never mix with the code history). */
async function createBranch(cfg, fetchImpl, timeoutMs) {
  const readme = '# AI training logs\n\nMatches submitted for AI training from any device (see server/match/ai/logUpload.js).\n';
  const tree = await gh(cfg, 'POST', `/repos/${cfg.repo}/git/trees`,
    { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: readme }] }, fetchImpl, timeoutMs);
  if (tree.status !== 201) return false;
  const commit = await gh(cfg, 'POST', `/repos/${cfg.repo}/git/commits`,
    { message: 'Start AI training log branch', tree: tree.json.sha, parents: [] }, fetchImpl, timeoutMs);
  if (commit.status !== 201) return false;
  const ref = await gh(cfg, 'POST', `/repos/${cfg.repo}/git/refs`,
    { ref: `refs/heads/${cfg.branch}`, sha: commit.json.sha }, fetchImpl, timeoutMs);
  return ref.status === 201 || ref.status === 422; // 422: another device created it first
}

/**
 * Upload one log. Already-present files count as success (re-submits are idempotent).
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function uploadLog(cfg, id, text, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (!cfg) return { ok: false, error: 'not configured' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch unavailable' };
  const p = remotePath(id, cfg.device);
  const url = `/repos/${cfg.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
  const body = {
    message: `AI log ${id} from ${cfg.device}`,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: cfg.branch,
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await gh(cfg, 'PUT', url, body, fetchImpl, timeoutMs);
      if (r.status === 200 || r.status === 201) return { ok: true, path: p };
      const msg = String(r.json && r.json.message || '');
      if (r.status === 422 && /sha/i.test(msg)) return { ok: true, path: p, existed: true }; // same file already uploaded
      if ((r.status === 404 || r.status === 422) && /branch/i.test(msg) && attempt === 0) {
        if (await createBranch(cfg, fetchImpl, timeoutMs)) continue;
      }
      if (r.status === 401) return { ok: false, error: 'GitHub token invalid or expired (401)' };
      if (r.status === 403 || r.status === 404) return { ok: false, error: `token has no write access to the repo (${r.status})` };
      return { ok: false, error: `GitHub ${r.status}${msg ? `: ${msg}` : ''}` };
    }
    return { ok: false, error: 'could not create branch' };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'upload timed out' : String(e && e.message || e) };
  }
}

function readQueue(dir) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8'));
    return Array.isArray(q) ? q.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function writeQueue(dir, q) {
  try {
    const f = path.join(dir, QUEUE_FILE);
    if (!q.length) { fs.rmSync(f, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(q, null, 1));
  } catch { /* best effort */ }
}

/** Uploader bound to a training dir: submit(id, text) uploads or queues; flush() retries the queue. */
export function createUploader({ trainingDir, env = process.env, fetchImpl = globalThis.fetch, log = console, timeoutMs } = {}) {
  const cfg = uploadConfig(env);
  let flushing = null;
  const opts = { fetchImpl, timeoutMs };
  const enqueue = (id) => {
    if (!trainingDir) return;
    const q = readQueue(trainingDir);
    if (!q.includes(id)) { q.push(id); writeQueue(trainingDir, q); }
  };
  const dequeue = (id) => {
    if (!trainingDir) return;
    writeQueue(trainingDir, readQueue(trainingDir).filter((x) => x !== id));
  };
  const flush = () => {
    if (!cfg || !trainingDir) return Promise.resolve({ uploaded: 0, left: 0 });
    if (flushing) return flushing;
    flushing = (async () => {
      let uploaded = 0;
      for (const id of readQueue(trainingDir)) {
        let text;
        try { text = fs.readFileSync(path.join(trainingDir, `${id}.json`), 'utf8'); } catch { dequeue(id); continue; }
        const r = await uploadLog(cfg, id, text, opts);
        if (!r.ok) break; // still offline / misconfigured: keep the rest queued
        dequeue(id); uploaded++;
        log.info && log.info(`[ai-log] uploaded queued ${id} → ${cfg.repo}@${cfg.branch}:${r.path}`);
      }
      return { uploaded, left: readQueue(trainingDir).length };
    })().finally(() => { flushing = null; });
    return flushing;
  };
  return {
    configured: !!cfg,
    repo: cfg ? cfg.repo : null,
    branch: cfg ? cfg.branch : null,
    device: cfg ? cfg.device : null,
    async submit(id, text) {
      if (!cfg) return { ok: false, configured: false, error: 'upload not configured on this machine (AI_LOG_GITHUB_TOKEN)' };
      const r = await uploadLog(cfg, id, text, opts);
      if (r.ok) {
        dequeue(id);
        log.info && log.info(`[ai-log] uploaded ${id} → ${cfg.repo}@${cfg.branch}:${r.path}`);
        flush().catch(() => {});
      } else {
        enqueue(id);
        log.warn && log.warn(`[ai-log] upload failed for ${id} (queued for retry): ${r.error}`);
      }
      return { ...r, configured: true };
    },
    flush,
    queued: () => (trainingDir ? readQueue(trainingDir) : []),
  };
}
