import { FolderInput } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import { useProjectRelocation } from '../../../hooks/useProjectRelocation';
import { SettingRow, INPUT_CLASS, Select, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

/** Preset cadences for the background auto-import sweep. "off" (the default)
 *  disables it entirely - no timer and no on-open sweep. The cadences are longer
 *  than the PR-refresh presets because importing shells out to gh/az and creates
 *  rows, so it is heavier and less time-sensitive. */
const AUTO_IMPORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '30', label: 'Every 30 minutes' },
  { value: '60', label: 'Every hour' },
];

/**
 * General per-project settings. Project Location is unlike every other
 * per-project row, editing the project row in the global DB (via the
 * projects IPC surface) rather than the project's config overrides.
 */
export function GeneralTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  const projectSettingsPath = useConfigStore((state) => state.projectSettingsPath);
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);

  // Settings can target a non-current project (sidebar gear icon); resolve
  // by the path the panel was opened for, falling back to the current project.
  const activePath = projectSettingsPath || currentProject?.path;
  const project = projects.find((candidate) => candidate.path === activePath)
    ?? currentProject;

  const { requestMove, relocationDialog } = useProjectRelocation((updated) => {
    // The settings panel and its project switcher are keyed by path; re-key
    // them so the panel keeps pointing at the relocated project.
    openProjectSettings(updated.path, updated.name, 'general');
  });

  return (
    <>
      {project && (
        <SettingRow {...settingProps('project.location')}>
          <div className="flex items-center gap-2">
            {/* `INPUT_CLASS` rather than a hand-rolled shell: this is read-only,
                but it is still a value FIELD sitting in a row with a button, and
                it was the last control left on the pre-unification `bg-surface`
                + `border-edge` pairing. Borrowing the shared class means it
                cannot drift again. The focus utilities in it are inert on a div. */}
            <div
              className={`${INPUT_CLASS} flex-1 min-w-0 truncate`}
              title={project.path}
              data-testid="project-location-path"
            >
              {project.path}
            </div>
            <button
              type="button"
              onClick={() => requestMove(project)}
              data-testid="project-location-move"
              className="flex-shrink-0 inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-edge-input text-fg-muted hover:text-fg hover:border-edge-hover transition-colors"
            >
              <FolderInput size={14} />
              <span>Move...</span>
            </button>
          </div>
        </SettingRow>
      )}
      <SettingRow {...settingProps('boards.autoImportIntervalMinutes')}>
        <Select
          value={config.boards.autoImportIntervalMinutes == null ? 'off' : String(config.boards.autoImportIntervalMinutes)}
          onChange={(event) => {
            const raw = event.target.value;
            updateProject({ boards: { autoImportIntervalMinutes: raw === 'off' ? null : parseInt(raw, 10) } });
          }}
        >
          {AUTO_IMPORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
      </SettingRow>
      {relocationDialog}
    </>
  );
}
