/**
 * Background auto-import sweep. For every saved import source of the open project
 * it re-runs the same fetch-and-create pipeline the manual "Import Tasks" dialog
 * uses, so newly-created upstream issues flow into the backlog on their own. Runs
 * fire-and-forget on a periodic timer (see auto-import-scheduler.ts).
 *
 * Reuses the existing import pipeline unchanged: it pages `adapter.fetch(...)` and
 * calls the shared `importIssuesToBacklog` create loop. De-duplication is
 * cross-table (backlog_tasks + tasks), so a repeated sweep never double-imports.
 *
 * Best-effort and silent per source: a stub adapter, an unavailable/unauthenticated
 * CLI, or a network error skips that source without aborting the others and without
 * surfacing a notification. Only a genuine new item triggers a backlog refresh push.
 */

import { getProjectDb } from '../db/database';
import { BacklogRepository } from '../db/repositories/backlog-repository';
import { boardRegistry } from './board-registry';
import { ImportSourceStore } from './shared/source-store';
import { importIssuesToBacklog } from './shared/import-runner';
import { broadcast } from '../pop-out/window-broadcast';
import { IPC } from '../../shared/ipc-channels';
import type { BoardAdapter } from './shared/types';
import type { ExternalIssue, ExternalSource, ImportSource, Project } from '../../shared/types';
import type { IpcContext } from '../ipc/ipc-context';

/** Page size per fetch round-trip. Matches the manual ImportDialog's chunk size. */
const AUTO_IMPORT_PAGE_SIZE = 30;
/** Hard bound on paging so a misbehaving adapter that never clears hasNextPage
 *  cannot spin the sweep forever. */
const MAX_AUTO_IMPORT_PAGES = 50;

/** Fetch every page of open issues for one saved source. */
async function fetchAllOpenIssues(
  adapter: BoardAdapter,
  source: ImportSource,
  findAlreadyImported: (source: ExternalSource, externalIds: string[]) => Set<string>,
): Promise<ExternalIssue[]> {
  const collected: ExternalIssue[] = [];
  for (let page = 1; page <= MAX_AUTO_IMPORT_PAGES; page++) {
    const result = await adapter.fetch(
      {
        source: source.source,
        repository: source.repository,
        page,
        perPage: AUTO_IMPORT_PAGE_SIZE,
        state: 'open',
      },
      findAlreadyImported,
    );
    collected.push(...result.issues);
    if (!result.hasNextPage) break;
  }
  return collected;
}

/**
 * Sweep every saved import source of `project`, importing any new open issues into
 * the backlog. Assumes `project` is the current project (the scheduler's per-tick
 * guard enforces that before calling).
 */
export async function runAutoImportForProject(context: IpcContext, project: Project): Promise<void> {
  let sources: ImportSource[];
  try {
    sources = new ImportSourceStore(project.path).list();
  } catch {
    return;
  }
  if (sources.length === 0) return;

  let db: ReturnType<typeof getProjectDb>;
  try {
    db = getProjectDb(project.id);
  } catch {
    // Project DB unavailable (e.g. closed mid-switch) - nothing to import.
    return;
  }
  const backlogRepo = new BacklogRepository(db);
  const findAlreadyImported = (source: ExternalSource, externalIds: string[]): Set<string> =>
    backlogRepo.findByExternalIds(source, externalIds);

  let totalImported = 0;
  for (const source of sources) {
    try {
      // requireStable throws for a stub provider - caught below so one bad
      // source never aborts the sweep for the others.
      const adapter = boardRegistry.requireStable(source.source);

      // Best-effort prerequisite gate: a background sweep must stay silent when
      // the CLI is missing or unauthenticated rather than error every tick.
      const prerequisites = await adapter.checkCli();
      if (!prerequisites.available || !prerequisites.authenticated) continue;

      const issues = await fetchAllOpenIssues(adapter, source, findAlreadyImported);
      const summary = await importIssuesToBacklog(db, project.path, adapter, source.source, issues);
      totalImported += summary.imported;
    } catch {
      // Best-effort per source; never let one failure abort the sweep.
    }
  }

  // Refresh the backlog view only when something new actually landed. This is the
  // same data-invalidation push the MCP backlog path uses - NOT a notification
  // (no toast, no desktop alert): the backlog count simply updates without the
  // user reopening the panel.
  if (totalImported > 0) {
    broadcast(context.mainWindow, IPC.BACKLOG_CHANGED_BY_AGENT, project.id);
  }
}
