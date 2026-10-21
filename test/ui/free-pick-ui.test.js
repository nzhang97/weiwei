// 每轮自选 — client side (ui/freePick.js; server option SP_FREE_PICK, default off): the shop bar's 自选 ×N button appears only
// when m.private.shop.freePicks is sent, the dialog groups the server's candidates by tier, a tap sends g.freePick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('freePickState: null while the option is off; picks left and candidates when on', async () => {
  const { freePickState } = await import('../../public/js/ui/freePick.js');
  assert.equal(freePickState(null), null);
  assert.equal(freePickState({ shop: { level: 3 } }), null, 'no freePicks key ⇒ off');
  assert.deepEqual(freePickState({ shop: { freePicks: 2, freePickCands: ['a', 'b'] } }), { left: 2, cands: ['a', 'b'] });
  assert.deepEqual(freePickState({ shop: { freePicks: 0 } }), { left: 0, cands: [] });
});

test('groupByTier: ascending tiers, unknown ids dropped', async () => {
  const { groupByTier } = await import('../../public/js/ui/freePick.js');
  const recs = { a: { tier: 2, name: 'A' }, b: { tier: 1, name: 'B' }, c: { tier: 2, name: 'C' } };
  const g = groupByTier(['a', 'b', 'x', 'c'], (id) => recs[id]);
  assert.deepEqual(g.map(([t, l]) => [t, l.map((e) => e.id)]), [[1, ['b']], [2, ['a', 'c']]]);
});

test('a pick sends g.freePick { chessId }', async () => {
  const { net } = await import('../../public/js/net.js');
  const sent = [];
  const prev = net.request;
  net.request = async (t, fields) => { sent.push([t, fields]); return { ok: true }; };
  try {
    const { actions } = await import('../../public/js/ui/gameActions.js');
    assert.equal(await actions.freePick('chess_char_1_01_a'), true);
    assert.deepEqual(sent, [['g.freePick', { chessId: 'chess_char_1_01_a' }]]);
  } finally { net.request = prev; }
});

test('the dialog is mounted at the match screen root, outside the HUD layer (taps must not reach the field)', () => {
  const game = read('public/js/screens/game.js');
  assert.match(game, /import \{ FreePickDialog \} from '\.\.\/ui\/freePick\.js';/);
  const hudStart = game.indexOf('<div class="gm__hud"');
  const dlg = game.indexOf('<${FreePickDialog}');
  const exit = game.indexOf('<${ExitModal}');
  assert.ok(hudStart > 0 && dlg > 0 && exit > 0);
  assert.ok(dlg > hudStart && Math.abs(exit - dlg) < 200, 'mounted beside ExitModal at the screen root');
  const bar = read('public/js/ui/shopBar.js');
  assert.doesNotMatch(bar, /FreePickDialog/, 'the shop bar no longer renders the dialog');
});

test('the shop bar mounts the button; the launcher sets SP_FREE_PICK from a default-off checkbox', () => {
  const bar = read('public/js/ui/shopBar.js');
  assert.match(bar, /import \{ FreePickButton \} from '\.\/freePick\.js';/);
  assert.match(bar, /<\$\{FreePickButton\} priv=\$\{priv\} editable=\$\{editable\} \/>/);
  const launcher = read('启动器.cmd');
  assert.match(launcher, /\$chkFreePick = New-Object System\.Windows\.Forms\.CheckBox/);
  assert.match(launcher, /\$chkFreePick\.Checked = \(\$env:SP_FREE_PICK -match/);
  assert.match(launcher, /if \(\$chkFreePick\.Checked\) \{ \$psi\.EnvironmentVariables\['SP_FREE_PICK'\] = '1' \}/);
});
