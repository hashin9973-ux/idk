'use strict';

// Benchmark-only synthetic project fixture. It is created under the OS temp directory,
// never reads or writes a user's actual workspace, and is deleted on completion.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createProjectIntelligence } = require('../desktop/project-intelligence');
const { createExecutionScheduler } = require('../desktop/execution-scheduler');

const FIXTURE_FILES = 2000;
const SCHEDULER_TASKS = 256;

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-project-bench-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-project-bench-cache-'));
  let first;
  let warm;
  const scheduler = createExecutionScheduler({ maxActive: 100, maxQueued: 1000 });
  try {
    const sourceRoot = path.join(root, 'src');
    await fs.mkdir(sourceRoot, { recursive: true });
    for (let i = 0; i < FIXTURE_FILES; i++) {
      const current = String(i).padStart(5, '0');
      const previous = String(i - 1).padStart(5, '0');
      const importLine = i > 0 ? "import { BenchmarkSymbol" + previous + " } from './module-" + previous + "';\n" : '';
      const useLine = i > 0 ? 'return BenchmarkSymbol' + previous + '();' : 'return 0;';
      const source = importLine + 'export function BenchmarkSymbol' + current + '() { ' + useLine + ' }\n';
      await fs.writeFile(path.join(sourceRoot, 'module-' + current + '.js'), source, 'utf8');
    }

    first = createProjectIntelligence({
      storageDirectory: storage, watch: false,
      maxFiles: FIXTURE_FILES + 10, maxEntries: FIXTURE_FILES * 3,
      maxTotalBytes: 32 * 1024 * 1024
    });
    const coldStart = performance.now();
    await first.start(root);
    const coldIndexMs = performance.now() - coldStart;
    const indexed = await first.status(root);

    const searchStart = performance.now();
    const search = await first.search(root, { query: 'BenchmarkSymbol01000', kind: 'symbol', maxResults: 10 });
    const symbolSearchMs = performance.now() - searchStart;

    const impactStart = performance.now();
    const impact = await first.impact(root, { path: 'src/module-00000.js' });
    const impactMs = performance.now() - impactStart;

    // Mirror a real worker restart: flush the cache and close the first service
    // before a new process-local index instance restores its persisted metadata.
    await first.stop();
    const persistedCacheFiles = await fs.readdir(storage);
    const normalizedRoot = path.resolve(root).replace(/\\\\/g, '/').toLowerCase();
    const expectedCacheKey = crypto.createHash('sha256').update(normalizedRoot).digest('hex');
    const persistedCacheDetails = await Promise.all(persistedCacheFiles.map(async name => {
      const stat = await fs.stat(path.join(storage, name));
      let header = null;
      if (stat.isFile() && stat.size <= 256 * 1024 * 1024) {
        const data = JSON.parse(await fs.readFile(path.join(storage, name), 'utf8'));
        header = { version: data.version, rootKey: data.rootKey, documents: Array.isArray(data.documents) ? data.documents.length : null, lastFullScanAt: data.lastFullScanAt, generatedAt: data.generatedAt };
      }
      return { name, bytes: stat.size, isFile: stat.isFile(), header };
    }));
    warm = createProjectIntelligence({ storageDirectory: storage, watch: false });
    const warmStart = performance.now();
    const restored = await warm.status(root);
    const warmCacheRestoreMs = performance.now() - warmStart;

    const schedulerStart = performance.now();
    await Promise.all(Array.from({ length: SCHEDULER_TASKS }, (_, i) => scheduler.run(
      { reads: ['benchmark/resource-' + i] },
      async () => new Promise(resolve => setImmediate(resolve)),
      { id: 'benchmark-' + i, tool: 'benchmark-read', priority: 10 }
    )));
    const schedulerElapsedMs = performance.now() - schedulerStart;
    const schedulerStats = scheduler.getState();

    const report = {
      fixture: {
        source: 'synthetic temporary benchmark fixture; not production project data',
        files: FIXTURE_FILES,
        indexedFiles: indexed.filesIndexed,
        indexedSourceBytes: indexed.totalIndexedBytes
      },
      warmCache: {
        filesIndexed: restored.filesIndexed,
        lastFullScanAt: restored.lastFullScanAt,
        error: restored.error,
        cacheWarning: restored.cacheWarning,
        expectedCacheKey,
        expectedCacheName: 'project-index-' + expectedCacheKey + '.json',
        persistedFiles: persistedCacheDetails,
        firstRunCacheWarning: indexed.cacheWarning || null,
        firstRunError: indexed.error || null
      },
      coldIndexMs: Number(coldIndexMs.toFixed(2)),
      warmCacheRestoreMs: Number(warmCacheRestoreMs.toFixed(2)),
      symbolSearch: { elapsedMs: Number(symbolSearchMs.toFixed(2)), resultCount: search.count, scanTruncated: search.scanTruncated },
      impactAnalysis: { elapsedMs: Number(impactMs.toFixed(2)), dependentCount: impact.dependentCount },
      concurrentScheduler: {
        tasks: SCHEDULER_TASKS,
        elapsedMs: Number(schedulerElapsedMs.toFixed(2)),
        tasksPerSecond: Number((SCHEDULER_TASKS / (schedulerElapsedMs / 1000)).toFixed(1)),
        maxActive: schedulerStats.maxActive,
        completed: schedulerStats.completed,
        averageQueueWaitMs: schedulerStats.averageQueueWaitMs,
        averageExecutionMs: schedulerStats.averageExecutionMs
      }
    };
    console.log(JSON.stringify(report, null, 2));
    if (indexed.filesIndexed !== FIXTURE_FILES || restored.filesIndexed !== FIXTURE_FILES || search.count < 1 || impact.dependentCount !== FIXTURE_FILES - 1 || schedulerStats.completed !== SCHEDULER_TASKS) {
      throw new Error('Benchmark fixture invariant failed: ' + JSON.stringify({ indexedFiles: indexed.filesIndexed, restoredFiles: restored.filesIndexed, warmCacheError: restored.error, warmCacheWarning: restored.cacheWarning, searchCount: search.count, impactDependents: impact.dependentCount, schedulerCompleted: schedulerStats.completed, schedulerCapacity: schedulerStats.maxActive }));
    }
  } finally {
    await scheduler.stop();
    if (warm) await warm.stop();
    if (first) await first.stop();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
