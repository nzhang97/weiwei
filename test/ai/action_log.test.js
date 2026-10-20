// çŽ©å®¶æ“ä½œè®°å½• (server/match/ai/actionLog.js): every human action with its context, prep snapshots, the result id; the
// lobby keeps / writes it and the HTTP server serves GET /api/actionlog/<id>.json and /api/actionlog/<id>/submit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeMatch } from '../match/harness.js';
import { startServer } from '../../server/index.js';

function play() {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 7 }).start();
  h.toPrep(1);
  const m = h.m, ps = h.ps('p_0');
  ps.funds = 10;
  const slot = ps.shop.slots.findIndex((s) => s && !s.sold && s.kind === 'chess');
  const shopId = ps.shop.slots[slot].id;
  assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.refresh' }), { ok: true });
  m.handle('p_0', { t: 'g.emote', id: 'x' }); // not a decision: not recorded
  m.handle('p_0', { t: 'g.ready', ready: true });
  return { h, m, ps, shopId };
}

test('actions are recorded with their context; snapshots at prep start; the result carries the id', () => {
  const { m, shopId } = play();
  const log = m.actionLog;
  assert.ok(log && log.hasHumans());
  const ts = log.events.map((e) => e.msg.t);
  const at = ts.indexOf('g.buy');
  assert.ok(at >= 0, 'buy recorded: ' + ts.join(','));
  assert.deepEqual(ts.slice(at, at + 3), ['g.buy', 'g.refresh', 'g.ready']);
  assert.ok(!ts.includes('g.emote'), 'emotes are not decisions');
  const buy = log.events[at];
  assert.equal(buy.pre.slot.id, shopId, 'the bought shop card is resolved before the action');
  assert.equal(buy.ok, true);
  assert.equal(buy.round, 1);
  const snap = log.snapshots.find((s) => s.kind === 'prepStart' && s.round === 1);
  assert.ok(snap, 'prep-start snapshot');
  assert.equal(Object.keys(snap.players).length, 1, 'every seat');
  assert.ok(Array.isArray(snap.players.p_0.shop) && snap.players.p_0.shop.length > 0);
  m.finish({ victory: false, reason: 'test' });
  assert.equal(m.lastResultMsg.actionLogId, log.id);
  const json = JSON.parse(JSON.stringify(log.toJSON()));
  assert.equal(json.id, log.id);
  assert.ok(json.snapshots.some((s) => s.kind === 'final'));
});

test('opts.actionLog === false turns recording off', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 7, actionLog: false });
  assert.equal(h.m.actionLog ?? null, null);
});

test('HTTP: download and æäº¤ç»™AIå­¦ä¹ ; bad ids are refused', async () => {
  const { m } = play();
  m.finish({ victory: false, reason: 'test' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-al-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', actionLogDir: path.join(tmp, 'logs'), trainingDir: path.join(tmp, 'train'), quiet: true, log: { info() {}, warn() {}, error() {}, debug() {} } });
  try {
    srv.lobby.saveActionLog(m);
    const id = m.actionLog.id;
    const base = `http://127.0.0.1:${srv.port}`;
    const r1 = await fetch(`${base}/api/actionlog/${id}.json`);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('content-disposition') || '', /attachment/);
    const j = await r1.json();
    assert.equal(j.id, id);
    assert.ok(j.events.length >= 3);
    const r2 = await fetch(`${base}/api/actionlog/${id}/submit`);
    const j2 = await r2.json();
    assert.equal(j2.ok, true);
    assert.ok(fs.existsSync(path.join(tmp, 'train', `${id}.json`)));
    for (const bad of ['nope', '..%2F..%2Fpackage', '20260101-000000_X_m1%2F..']) {
      const r = await fetch(`${base}/api/actionlog/${bad}.json`);
      assert.equal(r.status, 404, bad);
    }
    // the file write lands asynchronously
    for (let i = 0; i < 50 && !fs.existsSync(path.join(tmp, 'logs', `${id}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(tmp, 'logs', `${id}.json`)));
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
