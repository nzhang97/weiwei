// 提交给AI学习 → GitHub upload (server/match/logUpload.js), exercised against a fake GitHub API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadConfig, remotePath, uploadLog, createUploader } from '../../server/match/logUpload.js';
import { startServer } from '../../server/index.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ENV = { AI_LOG_GITHUB_TOKEN: 'test-token', AI_LOG_DEVICE: 'desk 1' };

/** Fake GitHub: an in-memory branch → files map; `offline` makes every call throw. */
function fakeGitHub({ branches = ['ai-logs'], offline = false } = {}) {
  const state = { branches: new Set(branches), files: new Map(), calls: [], offline };
  const reply = (status, json) => ({ status, json: async () => json });
  state.fetch = async (url, init) => {
    state.calls.push(`${init.method} ${url.replace('https://api.github.com', '')}`);
    if (state.offline) throw new Error('getaddrinfo ENOTFOUND api.github.com');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if (init.method === 'PUT' && (m = /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url))) {
      const p = m[1].split('/').map(decodeURIComponent).join('/');
      if (!state.branches.has(body.branch)) return reply(404, { message: `Branch ${body.branch} not found` });
      const key = `${body.branch}:${p}`;
      if (state.files.has(key)) return reply(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      state.files.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
      return reply(201, { content: { path: p } });
    }
    if (init.method === 'POST' && url.endsWith('/git/trees')) return reply(201, { sha: 'tree1' });
    if (init.method === 'POST' && url.endsWith('/git/commits')) {
      assert.deepEqual(body.parents, []); // orphan: the log branch never carries the code history
      return reply(201, { sha: 'commit1' });
    }
    if (init.method === 'POST' && url.endsWith('/git/refs')) {
      state.branches.add(body.ref.replace('refs/heads/', ''));
      return reply(201, { ref: body.ref });
    }
    return reply(500, { message: 'unexpected' });
  };
  return state;
}

test('config comes only from env; no token → no upload', () => {
  assert.equal(uploadConfig({}), null);
  const c = uploadConfig(ENV);
  assert.deepEqual({ repo: c.repo, branch: c.branch, device: c.device }, { repo: 'nzhang97/weiwei', branch: 'ai-logs', device: 'desk-1' });
  assert.equal(uploadConfig({ ...ENV, AI_LOG_GITHUB_REPO: 'bad repo' }), null);
  assert.equal(remotePath('20261012-153111_XBXR_m1', 'desk-1'), 'training/2026-10/20261012-153111_XBXR_m1__desk-1.json');
});

test('upload writes the log; re-upload is idempotent; a missing branch is created as an orphan', async () => {
  const gh = fakeGitHub({ branches: [] });
  const cfg = uploadConfig(ENV);
  const r1 = await uploadLog(cfg, '20261012-153111_XBXR_m1', '{"a":1}', { fetchImpl: gh.fetch });
  assert.equal(r1.ok, true);
  assert.ok(gh.branches.has('ai-logs'));
  assert.equal(gh.files.get('ai-logs:training/2026-10/20261012-153111_XBXR_m1__desk-1.json'), '{"a":1}');
  const r2 = await uploadLog(cfg, '20261012-153111_XBXR_m1', '{"a":1}', { fetchImpl: gh.fetch });
  assert.equal(r2.ok, true);
  assert.equal(r2.existed, true);
});

test('offline submits are queued and flushed later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-upl-'));
  try {
    const gh = fakeGitHub({ offline: true });
    fs.writeFileSync(path.join(dir, 'L1.json'), '{"x":1}');
    const up = createUploader({ trainingDir: dir, env: ENV, fetchImpl: gh.fetch, log: quiet });
    const r = await up.submit('L1', '{"x":1}');
    assert.equal(r.ok, false);
    assert.deepEqual(up.queued(), ['L1']);
    gh.offline = false;
    const f = await up.flush();
    assert.deepEqual(f, { uploaded: 1, left: 0 });
    assert.deepEqual(up.queued(), []);
    assert.equal(gh.files.size, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lobby submit reports the upload outcome; test/programmatic servers never upload', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-upl-srv-'));
  const gh = fakeGitHub();
  const uploader = createUploader({ trainingDir: path.join(tmp, 'train'), env: ENV, fetchImpl: gh.fetch, log: quiet });
  const srv = await startServer({ port: 0, host: '127.0.0.1', actionLogDir: path.join(tmp, 'logs'), trainingDir: path.join(tmp, 'train'), logUploader: uploader, quiet: true, log: quiet });
  const plain = await startServer({ port: 0, host: '127.0.0.1', actionLogDir: path.join(tmp, 'logs2'), trainingDir: path.join(tmp, 'train2'), quiet: true, log: quiet });
  try {
    const id = '20261012-000000_TEST_m1';
    srv.lobby._actionLogs = new Map([[id, '{"t":1}']]);
    const r = await srv.lobby.submitActionLog(id);
    assert.equal(r.ok, true);
    assert.equal(r.uploaded, true);
    assert.equal(gh.files.size, 1);
    assert.ok(fs.existsSync(path.join(tmp, 'train', `${id}.json`)));

    assert.equal(plain.lobby.logUploader, null);
    plain.lobby._actionLogs = new Map([[id, '{"t":1}']]);
    const r2 = await plain.lobby.submitActionLog(id);
    assert.equal(r2.ok, true);
    assert.equal(r2.uploadConfigured, false);
  } finally {
    await srv.close();
    await plain.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
