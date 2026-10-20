#!/usr/bin/env node
// Download every match log uploaded with 提交给AI学习 (server/match/ai/logUpload.js) from the GitHub log branch into
// logs/ai_training/remote/<month>/. Files already present locally are skipped.
//
//   node tools/ai/fetch-ai-logs.mjs            (token from AI_LOG_GITHUB_TOKEN or GITHUB_TOKEN, also read from .env)
//
// Env: AI_LOG_GITHUB_REPO (default nzhang97/weiwei), AI_LOG_GITHUB_BRANCH (default ai-logs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  const vars = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
  for (const [k, v] of Object.entries(vars)) if (!process.env[k]) process.env[k] = v;
} catch { /* no .env */ }

const token = process.env.AI_LOG_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.AI_LOG_GITHUB_REPO || 'nzhang97/weiwei';
const branch = process.env.AI_LOG_GITHUB_BRANCH || 'ai-logs';
const outDir = path.join(ROOT, 'logs', 'ai_training', 'remote');
if (!token) { console.error('Set AI_LOG_GITHUB_TOKEN (or GITHUB_TOKEN) in the environment or .env'); process.exit(1); }

async function gh(url) {
  const r = await fetch(`https://api.github.com${url}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'stronghold-protocol-tools' },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${url}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const tree = await gh(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
const files = tree.tree.filter((t) => t.type === 'blob' && /^training\/.+\.json$/.test(t.path));
let got = 0;
for (const f of files) {
  const dest = path.join(outDir, ...f.path.replace(/^training\//, '').split('/'));
  if (fs.existsSync(dest)) continue;
  const blob = await gh(`/repos/${repo}/git/blobs/${f.sha}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(blob.content, 'base64'));
  got++;
  console.log(`+ ${path.relative(ROOT, dest)}`);
}
console.log(`${files.length} log(s) on ${repo}@${branch}; downloaded ${got} new into ${path.relative(ROOT, outDir)}`);
