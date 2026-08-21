/**
 * Shared "create backlog rows from fetched external issues" loop.
 *
 * This is the single create path behind BOTH the manual import IPC handler
 * (BACKLOG_IMPORT_EXECUTE in src/main/ipc/handlers/backlog.ts) and the background
 * auto-import sweep (src/main/boards/auto-import.ts). Keeping one implementation
 * means the two can never diverge - the same divergent-copy hazard the codebase
 * already guards against for the backlog promote paths.
 *
 * De-duplication is cross-table (BacklogRepository.findByExternalIds unions
 * backlog_tasks + tasks), so re-running the same fetch never double-imports. That
 * idempotency is what makes it safe to drive this loop from a repeating timer.
 */

import type Database from 'better-sqlite3';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { BacklogAttachmentRepository } from '../../db/repositories/backlog-attachment-repository';
import type { BoardAdapter } from './types';
import type { BacklogTask, ExternalIssue, ExternalSource } from '../../../shared/types';

/**
 * The subset of an external issue the create loop consumes. A full `ExternalIssue`
 * (from `adapter.fetch`, the auto-import path) is assignable to it, and it matches
 * `ImportExecuteInput['issues']` (the manual IPC path), so one runner serves both.
 */
export type ImportableIssue = Pick<
  ExternalIssue,
  'externalId' | 'externalUrl' | 'title' | 'body' | 'labels' | 'assignee' | 'fileAttachments'
>;

export interface ImportRunSummary {
  imported: number;
  skippedDuplicates: number;
  skippedAttachments: number;
  items: BacklogTask[];
}

/**
 * Create backlog rows for a batch of already-fetched external issues. Downloads
 * inline images and (where the adapter supports it) file attachments, and skips
 * any issue already present in the backlog or on the board.
 */
export async function importIssuesToBacklog(
  db: Database.Database,
  projectPath: string,
  adapter: BoardAdapter,
  source: ExternalSource,
  issues: ImportableIssue[],
): Promise<ImportRunSummary> {
  const backlogRepo = new BacklogRepository(db);
  const backlogAttachmentRepo = new BacklogAttachmentRepository(db);

  const externalIds = issues.map((issue) => issue.externalId);
  const alreadyImportedIds = backlogRepo.findByExternalIds(source, externalIds);

  const items: BacklogTask[] = [];
  let skippedDuplicates = 0;
  let skippedAttachments = 0;

  for (const issue of issues) {
    if (alreadyImportedIds.has(issue.externalId)) {
      skippedDuplicates++;
      continue;
    }

    // Download inline images from the issue body (source-agnostic).
    const { attachments: inlineAttachments, skippedCount: inlineSkipped } =
      await adapter.downloadImages(issue.body);
    skippedAttachments += inlineSkipped;

    // Download file attachments if the source exposes them (e.g. Azure DevOps).
    const downloadedAttachments = [...inlineAttachments];
    if (adapter.downloadFileAttachments && issue.fileAttachments?.length) {
      const { attachments: fileAttachments, skippedCount: fileSkipped } =
        await adapter.downloadFileAttachments(issue.fileAttachments);
      downloadedAttachments.push(...fileAttachments);
      skippedAttachments += fileSkipped;
    }

    const attachmentMetadata = downloadedAttachments.map((attachment) => ({
      originalUrl: attachment.sourceUrl,
      filename: attachment.filename,
    }));

    const item = backlogRepo.create({
      title: issue.title,
      description: issue.body,
      priority: 0,
      labels: issue.labels,
      assignee: issue.assignee ?? undefined,
      externalId: issue.externalId,
      externalSource: source,
      externalUrl: issue.externalUrl,
      syncStatus: 'imported',
      externalMetadata: attachmentMetadata.length > 0 ? { attachments: attachmentMetadata } : undefined,
    });

    // Persist the downloaded images/files as backlog attachments.
    for (const attachment of downloadedAttachments) {
      backlogAttachmentRepo.add(projectPath, item.id, attachment.filename, attachment.data, attachment.mediaType);
    }

    items.push(backlogRepo.getById(item.id) ?? item);
  }

  return {
    imported: items.length,
    skippedDuplicates,
    skippedAttachments,
    items,
  };
}
