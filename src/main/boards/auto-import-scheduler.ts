/**
 * Per-project background auto-import scheduler. Mirrors prRefreshScheduler's
 * lifecycle contract (see src/main/pr/pr-refresh-scheduler.ts): Kangentic focuses
 * one project at a time, so this keeps a single active timer that opening/switching
 * to a project (re)arms and switching away / closing tears down.
 *
 * Timer-leak safety (identical to the PR scheduler):
 *  - the `setInterval` is created OUTSIDE `runWithProjectLogContext`; each tick
 *    wraps its work inside it,
 *  - the interval is `.unref()`'d so it never blocks a clean Electron quit, and
 *  - it is explicitly cleared on project switch/delete and on shutdown.
 *
 * Difference from PR refresh: auto-import is opt-in and its work (shelling out to
 * gh/az and creating rows) is heavier, so a project whose interval is Off does
 * ZERO work - no timer AND no on-open sweep. Only an armed interval sweeps: once
 * immediately on open (so a just-opened project imports promptly) and then on the
 * interval.
 */

import { runWithProjectLogContext } from '../diagnostics/project-log-context';
import { runAutoImportForProject } from './auto-import';
import type { IpcContext } from '../ipc/ipc-context';
import type { Project } from '../../shared/types';

let activeTimer: NodeJS.Timeout | null = null;
let activeProjectId: string | null = null;

/** Read the per-project auto-import interval (minutes); null/<=0 means "off". */
function readIntervalMinutes(context: IpcContext, projectPath: string): number | null {
  try {
    return context.configManager.getEffectiveConfig(projectPath).boards.autoImportIntervalMinutes;
  } catch {
    return null;
  }
}

/** Run one sweep, tagged with the project's log context, guarded against a stale switch. */
function sweep(context: IpcContext, project: Project): void {
  if (context.currentProjectId !== project.id) return;
  runWithProjectLogContext(project.name, () => {
    void runAutoImportForProject(context, project).catch((error) => {
      console.error('[auto-import] sweep failed:', error);
    });
  });
}

export const autoImportScheduler = {
  /**
   * (Re)arm auto-import for `project`. Called on every PROJECT_OPEN (cold restart
   * AND warm switch-back) and after a config change so a new interval takes effect
   * without reopening. When the interval is Off, this does nothing beyond tearing
   * down any prior timer.
   */
  startForProject(context: IpcContext, project: Project): void {
    // Tear down any prior project's timer first (single active-project model).
    autoImportScheduler.stop();
    activeProjectId = project.id;

    const minutes = readIntervalMinutes(context, project.path);
    if (minutes == null || minutes <= 0) return; // Off: no timer, no on-open sweep.

    // Armed: a deferred immediate sweep (kept off the PROJECT_OPEN critical path)
    // so a just-opened project imports promptly, then the periodic timer.
    setImmediate(() => sweep(context, project));

    activeTimer = setInterval(() => sweep(context, project), minutes * 60_000);
    // Never let the timer block a clean quit; it is also explicitly cleared on
    // switch/delete/shutdown.
    activeTimer.unref();
  },

  /**
   * Stop the active timer. With a `projectId`, no-ops unless that project owns
   * the active timer (so deleting a non-focused project never kills the focused
   * project's timer). With no argument, always stops (shutdown / unconditional).
   */
  stop(projectId?: string): void {
    if (projectId != null && projectId !== activeProjectId) return;
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
    activeProjectId = null;
  },
};
