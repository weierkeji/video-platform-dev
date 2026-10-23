import type { ActionChoice, Project } from '../core/model';

export function ActionSelect({
  project,
  sceneId,
  label,
  inherit,
  value,
  onChange,
}: {
  project: Project;
  sceneId: string;
  label: string;
  inherit: string;
  value?: ActionChoice | null;
  onChange: (value: ActionChoice | null) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value ? value.actionId || '@base' : '@inherit'}
        onChange={(event) =>
          onChange(
            event.target.value === '@inherit'
              ? null
              : { actionId: event.target.value === '@base' ? null : event.target.value },
          )
        }
      >
        <option value="@inherit">{inherit}</option>
        <option value="@base">项目动画</option>
        {(project.animationActions || [])
          .filter((a) => a.sceneId === sceneId)
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
      </select>
    </label>
  );
}
