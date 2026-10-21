// 每轮自选 (server option SP_FREE_PICK — the launcher's 「每轮自选干员」 checkbox; default off): one free pick per round,
// unused picks carry over (server/match/player/economy.js freePick). The shop bar shows 自选 ×N while the server sends
// m.private.shop.freePicks (absent ⇒ the option is off: nothing is drawn); the dialog lists the operators the server says a
// pick may take now (shop.freePickCands: the shared pool's operators with a copy left, not banned, tier ≤ the shop level),
// grouped by tier. A tap takes one (g.freePick); the copy comes out of the shared pool like a purchase.
import { useState } from '../../vendor/hooks.module.js';
import { html, Modal, TierChip } from './components.js';
import { Img } from './gameComponents.js';
import { chessPortraitUrl } from './assetUrls.js';
import { actions } from './gameActions.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

/** The picks left (null when the option is off) and the candidate ids of a m.private. */
export function freePickState(priv) {
  const shop = priv?.shop;
  if (!shop || !Number.isInteger(shop.freePicks)) return null;
  return { left: shop.freePicks, cands: Array.isArray(shop.freePickCands) ? shop.freePickCands : [] };
}

/** Candidate ids → [[tier, [records]]] (ascending tier; unknown ids dropped). */
export function groupByTier(ids, lookup = (id) => data.lookup('chess', id)) {
  const byTier = new Map();
  for (const id of ids || []) {
    const c = lookup(id);
    if (!c) continue;
    const tier = c.tier ?? 1;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push({ id, c });
  }
  return [...byTier.entries()].sort((a, b) => a[0] - b[0]);
}

/** The shop bar's 自选 button (nothing when the option is off) and its dialog. */
export function FreePickButton({ priv, editable }) {
  const st = freePickState(priv);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!st) return null;
  const can = editable && st.left > 0;
  const pick = async (id) => {
    if (busy) return;
    setBusy(true);
    const ok = await actions.freePick(id);
    setBusy(false);
    if (ok && st.left - 1 <= 0) setOpen(false);
  };
  const m = data.get('assets');
  const groups = groupByTier(st.cands);
  return html`<button type="button" class=${'toolbtn toolbtn--pick' + (st.left > 0 ? ' has-picks' : '')} disabled=${!can}
      onClick=${() => setOpen(true)} data-testid="free-pick"
      title=${st.left > 0 ? t('每轮自选：免费选择一名不超过商店等级的干员（未使用的次数会保留）') : t('没有可用的自选次数')}>
    <span>${t('自选')}</span><b class="num">×${st.left}</b>
  </button>
  <${Modal} open=${open} onClose=${() => setOpen(false)} title=${t('每轮自选')} micro="FREE PICK" width="min(92vw, 9.6rem)" class="freepick">
    <p class="freepick__hint">${t('剩余次数 {n} · 可选不超过商店等级 {lv} 的干员，从公共牌池中扣除', { n: st.left, lv: priv?.shop?.level ?? 1 })}</p>
    ${groups.length ? groups.map(([tier, list]) => html`<section class="freepick__tier" key=${tier}>
      <${TierChip} tier=${tier} size="sm" />
      <div class="freepick__grid">
        ${list.map(({ id, c }) => html`<button type="button" key=${id} class="freepick__card" disabled=${!can || busy}
            onClick=${() => pick(id)} title=${c.name || id} data-chess=${id}>
          <${Img} src=${chessPortraitUrl(m, c)} class="freepick__art" />
          <span class="freepick__name">${c.name || id}</span>
        </button>`)}
      </div>
    </section>`) : html`<p class="freepick__empty">${t('当前没有可选的干员')}</p>`}
  <//>`;
}
