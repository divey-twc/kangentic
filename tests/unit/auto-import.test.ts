/**
 * Unit tests for the auto-import sweep orchestration (runAutoImportForProject):
 * enumerating saved sources, silently skipping an unavailable/unauthenticated CLI
 * or a stub adapter without aborting the other sources, paging fetch until
 * hasNextPage is false, and broadcasting a backlog refresh ONLY when something new
 * actually landed. The DB, repositories, registry, source store, the shared create
 * loop, and the broadcast are all mocked - this pins the orchestration, not the
 * create loop (which is covered where it runs against a real DB).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

const listMock = vi.fn<() => unknown[]>();
vi.mock('../../src/main/boards/shared/source-store', () => ({
  ImportSourceStore: class {
    list() { return listMock(); }
  },
}));

const getProjectDbMock = vi.fn(() => ({}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (...args: unknown[]) => getProjectDbMock(...args),
}));

const findByExternalIdsMock = vi.fn(() => new Set<string>());
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    findByExternalIds(...args: unknown[]) { return (findByExternalIdsMock as (...a: unknown[]) => Set<string>)(...args); }
  },
}));

const requireStableMock = vi.fn();
vi.mock('../../src/main/boards/board-registry', () => ({
  boardRegistry: { requireStable: (...args: unknown[]) => requireStableMock(...args) },
}));

const importIssuesToBacklogMock = vi.fn(async () => ({ imported: 0, skippedDuplicates: 0, skippedAttachments: 0, items: [] }));
vi.mock('../../src/main/boards/shared/import-runner', () => ({
  importIssuesToBacklog: (...args: unknown[]) => importIssuesToBacklogMock(...args),
}));

const broadcastMock = vi.fn();
vi.mock('../../src/main/pop-out/window-broadcast', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
}));

import { runAutoImportForProject } from '../../src/main/boards/auto-import';

const PROJECT: Project = { id: 'p1', path: '/mock/p1', name: 'p1' } as Project;
const CONTEXT = { mainWindow: {} } as unknown as IpcContext;

function makeSource(id: string, source = 'github_issues') {
  return { id, source, repository: `org/${id}`, label: id, url: `https://x/${id}`, createdAt: '' };
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    checkCli: vi.fn(async () => ({ available: true, authenticated: true })),
    fetch: vi.fn(async () => ({ issues: [], totalCount: 0, hasNextPage: false })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  importIssuesToBacklogMock.mockResolvedValue({ imported: 0, skippedDuplicates: 0, skippedAttachments: 0, items: [] });
  findByExternalIdsMock.mockReturnValue(new Set());
});

describe('runAutoImportForProject', () => {
  it('does nothing when there are no saved sources', async () => {
    listMock.mockReturnValue([]);

    await runAutoImportForProject(CONTEXT, PROJECT);

    expect(requireStableMock).not.toHaveBeenCalled();
    expect(importIssuesToBacklogMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('skips a source whose CLI is unavailable or unauthenticated, without fetching', async () => {
    listMock.mockReturnValue([makeSource('a')]);
    const adapter = makeAdapter({ checkCli: vi.fn(async () => ({ available: false, authenticated: false })) });
    requireStableMock.mockReturnValue(adapter);

    await runAutoImportForProject(CONTEXT, PROJECT);

    expect(adapter.fetch).not.toHaveBeenCalled();
    expect(importIssuesToBacklogMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('a stub/bad source (requireStable throws) never aborts the sweep for the others', async () => {
    listMock.mockReturnValue([makeSource('stub', 'jira'), makeSource('ok')]);
    const okAdapter = makeAdapter({
      fetch: vi.fn(async () => ({ issues: [{ externalId: '1' }], totalCount: 1, hasNextPage: false })),
    });
    requireStableMock.mockImplementation((source: string) => {
      if (source === 'jira') throw new Error('not implemented');
      return okAdapter;
    });
    importIssuesToBacklogMock.mockResolvedValue({ imported: 1, skippedDuplicates: 0, skippedAttachments: 0, items: [] });

    await runAutoImportForProject(CONTEXT, PROJECT);

    // The good source is still imported despite the stub throwing first.
    expect(importIssuesToBacklogMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(CONTEXT.mainWindow, IPC.BACKLOG_CHANGED_BY_AGENT, 'p1');
  });

  it('pages fetch until hasNextPage is false and imports the combined issues', async () => {
    listMock.mockReturnValue([makeSource('a')]);
    const fetch = vi.fn()
      .mockResolvedValueOnce({ issues: [{ externalId: '1' }], totalCount: 2, hasNextPage: true })
      .mockResolvedValueOnce({ issues: [{ externalId: '2' }], totalCount: 2, hasNextPage: false });
    requireStableMock.mockReturnValue(makeAdapter({ fetch }));
    importIssuesToBacklogMock.mockResolvedValue({ imported: 2, skippedDuplicates: 0, skippedAttachments: 0, items: [] });

    await runAutoImportForProject(CONTEXT, PROJECT);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toMatchObject({ page: 1, state: 'open' });
    expect(fetch.mock.calls[1][0]).toMatchObject({ page: 2, state: 'open' });
    const [, , , , issuesArg] = importIssuesToBacklogMock.mock.calls[0] as unknown[];
    expect(issuesArg).toEqual([{ externalId: '1' }, { externalId: '2' }]);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast when nothing new was imported', async () => {
    listMock.mockReturnValue([makeSource('a')]);
    requireStableMock.mockReturnValue(makeAdapter({
      fetch: vi.fn(async () => ({ issues: [{ externalId: '1' }], totalCount: 1, hasNextPage: false })),
    }));
    importIssuesToBacklogMock.mockResolvedValue({ imported: 0, skippedDuplicates: 1, skippedAttachments: 0, items: [] });

    await runAutoImportForProject(CONTEXT, PROJECT);

    expect(importIssuesToBacklogMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
