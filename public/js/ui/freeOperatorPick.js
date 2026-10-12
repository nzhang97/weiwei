// 每回合免费自选干员 (room option freeOperatorPick): pick one normal operator of tier ≤ the 调度中心 level (g.freeOperatorPick)
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, TierChip } from './components.js';
import { Img } from './gameComponents.js';
import { chessPortraitUrl } from './assetUrls.js';
import { data } from '../data.js';
import { actions } from './gameActions.js';
import { t } from '../../../shared/i18n.js';

export function FreeOperatorPickModal({ open, onClose, priv, editable }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = priv?.freeOperatorPick;
  const options = pick?.options || [];
  useEffect(() => { if (open) { setQuery(''); setSelected(null); } }, [open]);
  useEffect(() => { if (open && (!editable || !pick?.enabled || pick.used)) onClose(); }, [open, editable, pick?.enabled, pick?.used]);
  const eligible = options.includes(selected);
  const confirm = async () => {
    if (busy || !eligible || !editable || pick?.used) return;
    setBusy(true);
    try { if (await actions.freeOperatorPick(selected)) onClose(); } finally { setBusy(false); }
  };
  const rows = options.map(id => { const c = data.lookup('chess', id); return c ? { ...c, id } : null; }).filter(Boolean)
    .filter(c => !query.trim() || c.name.includes(query.trim()))
    .sort((a,b) => a.tier - b.tier || a.name.localeCompare(b.name, 'zh-CN'));
  return html`<${Modal} open=${open && editable && pick?.enabled && !pick.used} title=${t('免费自选干员')}
    onClose=${onClose} width="8rem" class="free-pick-modal"
    actions=${html`<${Button} onClick=${onClose}>${t('取消')}<//><${Button} variant="primary" disabled=${busy || !eligible}
      onClick=${confirm}>${busy ? t('领取中…') : t('确认免费领取')}<//>`}>
    <p>${t('每回合可领取一次。当前基地等级：{lv}，可选择同级或更低等级的普通干员。', { lv: priv?.shop?.level ?? '' })}</p>
    <input class="free-pick-search" aria-label=${t('搜索干员')} placeholder=${t('搜索干员名称')} value=${query}
      onInput=${ev => setQuery(ev.currentTarget.value)} />
    <div class="free-pick-list">
      ${rows.map(c => html`<button type="button" key=${c.id} class=${`free-pick-card ${selected === c.id ? 'is-selected' : ''}`}
        aria-pressed=${selected === c.id} disabled=${busy} onClick=${() => setSelected(c.id)}>
        <${Img} src=${chessPortraitUrl(data.get('assets'), c)} /><span>${c.name}</span><${TierChip} tier=${c.tier} size="sm" />
      </button>`)}
      ${rows.length ? null : html`<p>${t('暂无符合条件的干员。')}</p>`}
    </div>
  <//>`;
}

