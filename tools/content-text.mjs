// Narrow corrections to source descriptions, matching this implementation's established rules.
// Keep numeric blackboards untouched. See docs/ai/AI-AUDIT.md for the evidence and intentional deviations.
export function correctContentDescriptions(files) {
  const amend = (record, fn) => {
    if (!record) return;
    for (const field of ['desc', 'descRaw', 'effectDesc', 'effectDescRaw']) {
      if (typeof record[field] === 'string') record[field] = fn(record[field]);
    }
  };
  for (const [id, before, after] of [['garrison_72_a', 7, 12], ['garrison_72_b', 14, 24]]) {
    amend(files.garrisons?.[id], (text) => text.replace(`至多${before}层`, `至多${after}层`));
  }
  const yanyou = (text) => text
    .replace('其攻击力生命值分别为开战时', '其基础攻击力和生命值分别增加开战时')
    .replace('其攻击力和生命值为【炎】', '其基础攻击力和生命值分别增加开战时【炎】');
  amend(files.bonds?.yanShip, yanyou);
  amend(files.effects?.bondeffect_yan, yanyou);
  return files;
}
