/**
 * Unit tests for the per-project auto-import scheduler: an immediate (deferred)
 * sweep on start when armed, a periodic timer at the configured interval, "Off"
 * arming NOTHING (no timer AND no on-open sweep - the opt-in difference from the
 * PR-refresh scheduler), teardown via stop(), the projectId-scoped stop() no-op,
 * and the per-tick guard that skips a sweep once the project is no longer current.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

// Run the tagged work inline so a sweep's runAutoImportForProject call is observable.
vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: (_name: string, fn: () => void) => fn(),
}));
vi.mock('../../src/main/boards/auto-import', () => ({ runAutoImportForProject: vi.fn(async () => {}) }));

import { runAutoImportForProject } from '../../src/main/boards/auto-import';
import { autoImportScheduler } from '../../src/main/boards/auto-import-scheduler';

const FIFTEEN_MIN = 15 * 60_000;
const mockSweep = vi.mocked(runAutoImportForProject);

/** Minimal context: the scheduler only reads currentProjectId + the boards interval. */
function makeContext(currentProjectId: string, minutes: number | null): IpcContext {
  return {
    currentProjectId,
    configManager: { getEffectiveConfig: () => ({ boards: { autoImportIntervalMinutes: minutes } }) },
  } as unknown as IpcContext;
}

function makeProject(id: string): Project {
  return { id, path: `/mock/repo/${id}`, name: id } as Project;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  autoImportScheduler.stop(); // reset the module singleton between tests
  vi.useRealTimers();
});

describe('autoImportScheduler', () => {
  it('runs an immediate sweep and arms a periodic timer at the configured interval', async () => {
    autoImportScheduler.startForProject(makeContext('p1', 15), makeProject('p1'));

    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN); // immediate sweep + first tick
    expect(mockSweep).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN); // second tick
    expect(mockSweep).toHaveBeenCalledTimes(3);

    expect(mockSweep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'p1' }));
  });

  it('Off (null interval) is fully opt-out: no on-open sweep and no timer', async () => {
    autoImportScheduler.startForProject(makeContext('p1', null), makeProject('p1'));

    await vi.runAllTimersAsync(); // no timer and no deferred sweep were scheduled
    expect(mockSweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour later: still nothing
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('stop() clears the periodic timer', async () => {
    autoImportScheduler.startForProject(makeContext('p1', 15), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);
    expect(mockSweep).toHaveBeenCalledTimes(2);

    autoImportScheduler.stop();
    mockSweep.mockClear();
    await vi.advanceTimersByTimeAsync(3 * FIFTEEN_MIN);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('stop(projectId) only stops when that project owns the active timer', async () => {
    autoImportScheduler.startForProject(makeContext('p1', 15), makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);

    autoImportScheduler.stop('other-project'); // no-op: not the active project
    mockSweep.mockClear();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);
    expect(mockSweep).toHaveBeenCalledTimes(1); // still ticking

    autoImportScheduler.stop('p1'); // now matches
    mockSweep.mockClear();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('switching projects tears down the prior timer and arms the new one', async () => {
    const context = makeContext('p1', 15);
    autoImportScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);

    // Switch: currentProjectId moves to p2, scheduler re-armed for p2.
    (context as { currentProjectId: string }).currentProjectId = 'p2';
    autoImportScheduler.startForProject(context, makeProject('p2'));
    mockSweep.mockClear();

    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN); // p2 immediate + tick; no p1 ticks
    expect(mockSweep).toHaveBeenCalledTimes(2);
    expect(mockSweep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'p2' }));
    expect(mockSweep).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'p1' }));
  });

  it('skips a tick when the project is no longer the current one', async () => {
    const context = makeContext('p1', 15);
    autoImportScheduler.startForProject(context, makeProject('p1'));
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);
    expect(mockSweep).toHaveBeenCalledTimes(2);

    // User switched away but the timer has not been re-armed yet: the guard skips.
    (context as { currentProjectId: string }).currentProjectId = 'somewhere-else';
    mockSweep.mockClear();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN);
    expect(mockSweep).not.toHaveBeenCalled();
  });
});
