/**
 * Developer utility: analyse a repository and print a human-readable summary.
 *
 *   npx tsx scripts/analyze.ts <path> [--json out.json] [--index] [--explain]
 */
import path from 'node:path';
import fs from 'node:fs';
import { analyzeRepo } from '../src/core/analysis/analyzeRepo.js';
import { buildIndex } from '../src/core/index/indexer.js';
import { loadConfig, ensureDirs } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { RepoService } from '../src/core/service.js';
import { repoExplainer } from '../src/core/explain/generate.js';
import { exportExplainer } from '../src/core/explain/exportHtml.js';
import { askRepo } from '../src/core/chat/chat.js';
import { buildRepoDigest } from '../src/core/explain/digest.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const question = args.includes('--ask') ? args[args.indexOf('--ask') + 1] : null;

if (!target) {
  console.error('usage: tsx scripts/analyze.ts <path> [--json file] [--ask "question"] [--explain]');
  process.exit(1);
}

const root = path.resolve(target);
const started = Date.now();

const model = await analyzeRepo(root, {
  onProgress: (message, pct) => process.stderr.write(`  [${String(pct).padStart(3)}%] ${message}\n`),
});

console.log(`\n=== ${model.repo.name} (${model.repo.path}) ===`);
console.log(`files ${model.stats.fileCount} · source ${model.stats.sourceFileCount} · loc ${model.stats.loc} · components ${model.stats.componentCount} · depth ${model.stats.maxDepth}`);
console.log(`git: ${model.git.isRepo ? `${model.git.branch} @ ${model.git.headShort}, ${model.git.commitCount} commits, ${model.git.contributors.length} contributors` : 'no'}`);
console.log(`stack: ${model.stack.primaryLanguage} | ${model.stack.frameworks.join(', ')} | pm: ${model.stack.packageManagers.join(', ')} | tests: ${model.stack.testFrameworks.join(', ')} | ci: ${model.stack.ci.join(', ')}`);
console.log(`languages: ${model.stack.languages.slice(0, 6).map((l) => `${l.language}(${l.loc})`).join(', ')}`);

console.log('\nComponents:');
for (const c of [...model.components].sort((a, b) => b.importance - a.importance).slice(0, 15)) {
  console.log(`  ${c.importance.toFixed(2)} ${c.ancillary ? '[aux]' : '     '} ${c.name.padEnd(22)} ${c.kind.padEnd(9)} ${String(c.loc).padStart(7)} loc  ${c.oneLiner.slice(0, 70)}`);
  if (c.dependsOn.length) console.log(`        -> ${c.dependsOn.slice(0, 6).join(', ')}`);
}

console.log('\nEntrypoints:');
for (const e of model.entrypoints.slice(0, 12)) console.log(`  ${e.kind.padEnd(14)} ${e.path}  (${e.reason})`);

console.log('\nExternal services:');
for (const s of model.externalServices.slice(0, 12)) console.log(`  ${s.category.padEnd(14)} ${s.name}  ${s.evidence.length} file(s)`);

console.log('\nData flows:');
for (const f of model.dataFlows) console.log(`  ${f.name}: ${f.summary}`);

console.log(`\nRoutes (${model.routes.length}):`);
for (const r of model.routes.slice(0, 20)) console.log(`  ${r.method.padEnd(7)} ${r.path.padEnd(38)} ${r.framework.padEnd(18)} ${r.file}:${r.line} -> ${r.handler ?? '?'}`);

const resolved = model.calls.filter((c) => c.resolved).length;
const unreachable = model.symbols.filter((s) => !s.reachable && !s.entry).length;
console.log(`\nCall graph: ${model.symbols.length} symbols, ${model.calls.length} call edges (${resolved} resolved, ${((resolved / Math.max(1, model.calls.length)) * 100).toFixed(0)}%)`);
console.log(`  entry symbols: ${model.symbols.filter((s) => s.entry).length} · unreachable: ${unreachable}`);
const fanIn = [...model.symbols].sort((a, b) => b.callerCount - a.callerCount).slice(0, 8);
console.log('  most-called symbols:');
for (const s of fanIn) console.log(`    ${String(s.callerCount).padStart(4)} callers  ${s.name}  (${s.path}:${s.line})`);

console.log(`\nHotspots (churn x size), ${model.hotspots.length}:`);
for (const h of model.hotspots.slice(0, 12)) console.log(`  ${String(h.score).padStart(7)}  ${String(h.commits).padStart(4)} commits  ${String(h.loc).padStart(6)} loc  ${h.path}`);

console.log(`\nDead-code candidates (${model.deadCode.length}):`);
for (const d of model.deadCode.slice(0, 10)) console.log(`  ${String(d.loc).padStart(5)} loc  ${d.kind.padEnd(9)} ${d.name}  ${d.path}`);

console.log('\nConcepts:');
console.log(`  ${model.concepts.slice(0, 14).map((c) => c.name).join(', ')}`);

const graphNodes = model.graph.nodes.length;
const graphEdges = model.graph.edges.length;
console.log(`\ngraph: ${graphNodes} nodes, ${graphEdges} edges`);
console.log(`warnings: ${model.warnings.length ? model.warnings.join(' | ') : 'none'}`);
console.log(`analysis took ${((Date.now() - started) / 1000).toFixed(1)}s`);

console.log('\n--- digest (first 2500 chars) ---');
console.log(buildRepoDigest(model).slice(0, 2500));

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(model, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}

if (args.includes('--agent')) {
  const cfg = loadConfig({ exportDir: path.join('/tmp', 'repo-explorer-exports') });
  ensureDirs(cfg);
  const store = new Store(cfg);
  const service = new RepoService(cfg, store);
  console.log('\n=== agent run ===');
  const ctx = await service.open(root, {
    force: true,
    onProgress: (message, pct) => process.stderr.write(`  [${String(pct).padStart(3)}%] ${message}\n`),
  });
  console.log(`provider: ${ctx.providerId} / ${ctx.modelName}`);
  const started2 = Date.now();
  const explainer = await repoExplainer(ctx, {
    refresh: process.env.AGENT_REFRESH !== 'false',
    maxSteps: Number(process.env.AGENT_STEPS ?? 6),
    onStatus: (message) => console.log(`  · ${message}`),
    onStep: (step) => {
      console.log(`  [${step.index}] ${step.tool} ${JSON.stringify(step.args)}${step.failed ? '  (failed)' : ''}`);
      if (step.thought) console.log(`       thought: ${step.thought.slice(0, 200)}`);
      console.log(`       -> ${step.summary}`);
    },
  });
  console.log(`\nexplainer: ${explainer.title} [${explainer.provider}/${explainer.model}] degraded=${Boolean(explainer.degraded)}`);
  console.log(`sections: ${explainer.sections.map((s) => s.type).join(', ')}`);
  console.log(`tldr: ${explainer.tldr.slice(0, 400)}`);
  console.log(`next: ${explainer.next.map((n) => n.label).join(', ')}`);
  console.log(`took ${((Date.now() - started2) / 1000).toFixed(1)}s`);
  const { filename, html } = exportExplainer(explainer, model);
  const out = path.join(cfg.exportDir, filename);
  fs.writeFileSync(out, html);
  console.log(`exported ${out} (${(html.length / 1024).toFixed(0)} KB)`);
  process.exit(0);
}

if (args.includes('--index') || args.includes('--explain') || question) {
  const indexStarted = Date.now();
  const index = await buildIndex(root, model, { onProgress: (d, t) => process.stderr.write(`  indexing ${d}/${t}\n`) });
  console.log(`\nindex: ${index.chunkCount} chunks in ${((Date.now() - indexStarted) / 1000).toFixed(1)}s`);
  if (question) {
    const hits = index.search(question, 6);
    console.log('top search hits:');
    for (const hit of hits) console.log(`  ${hit.score.toFixed(2)} ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine} ${hit.chunk.symbol ?? ''}`);
  }

  const cfg = loadConfig({ exportDir: path.join('/tmp', 'repo-explorer-exports') });
  ensureDirs(cfg);
  const store = new Store(cfg);
  const service = new RepoService(cfg, store);
  const ctx = {
    cfg,
    store,
    root,
    model,
    index,
    provider: { id: 'none', label: 'none', local: true } as never,
    providerId: 'none',
    modelName: 'none',
  };

  if (args.includes('--explain')) {
    const explainer = await repoExplainer(ctx as never, { staticOnly: true });
    console.log(`\nstatic explainer: ${explainer.title} — ${explainer.sections.length} sections`);
    for (const section of explainer.sections) {
      const label = 'title' in section ? section.title : '';
      console.log(`  - ${section.type}: ${label}`);
    }
    const { filename, html } = exportExplainer(explainer, model);
    const out = path.join(cfg.exportDir, filename);
    fs.writeFileSync(out, html);
    console.log(`exported ${out} (${(html.length / 1024).toFixed(0)} KB)`);
  }

  if (question) {
    await askRepo(ctx as never, { question });
    console.log('asked (mock provider) ok');
  }
}
