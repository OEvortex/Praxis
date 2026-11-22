// Port of deeptutor/services/memory/snapshot/diff.py — pure diff between two
// snapshot states. A state is {entity_id: fingerprint}.
import type { ChangeEntry } from "./entity.js";

export function diff_snapshots(
  prev: Record<string, string>,
  curr: Record<string, string>,
  opts: {
    label_map?: Record<string, string>;
    prev_label_map?: Record<string, string> | null;
  } = {},
): ChangeEntry[] {
  const labelMap = opts.label_map ?? {};
  const prevLabelMap = opts.prev_label_map ?? {};
  const ts = new Date().toISOString();
  const out: ChangeEntry[] = [];
  const prevKeys = new Set(Object.keys(prev));
  const currKeys = new Set(Object.keys(curr));

  for (const entityId of [...currKeys].filter((k) => !prevKeys.has(k)).sort()) {
    out.push({
      ts,
      kind: "added",
      entity_id: entityId,
      label: labelMap[entityId] ?? entityId,
      prev_fingerprint: null,
      new_fingerprint: curr[entityId],
    });
  }
  for (const entityId of [...prevKeys].filter((k) => !currKeys.has(k)).sort()) {
    out.push({
      ts,
      kind: "removed",
      entity_id: entityId,
      label: prevLabelMap[entityId] || entityId,
      prev_fingerprint: prev[entityId],
      new_fingerprint: null,
    });
  }
  for (const entityId of [...prevKeys].filter((k) => currKeys.has(k)).sort()) {
    if (prev[entityId] !== curr[entityId]) {
      out.push({
        ts,
        kind: "modified",
        entity_id: entityId,
        label: labelMap[entityId] ?? entityId,
        prev_fingerprint: prev[entityId],
        new_fingerprint: curr[entityId],
      });
    }
  }
  return out;
}
