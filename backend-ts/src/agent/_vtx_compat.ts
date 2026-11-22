/**
 * Compatibility shim for vtx's tool-schema slimming.
 *
 * Port of ``backend/app/agent/_vtx_compat.py``.
 *
 * ``vtx.agent.tools._slim_schema`` strips every dict key named ``"title"``
 * wherever it appears — meant to remove pydantic's ``"title": "<Label>"``
 * annotations, but it also deletes a *parameter* literally named ``title``
 * from ``properties``, so the model never sees that argument and every call
 * fails validation (``notes``/``video``/``note_create`` were all affected).
 *
 * The Python module monkeypatches ``vtx.agent.tools._slim_schema`` at import
 * time. There is no vtx SDK in TypeScript, so this module exports the corrected
 * ``slimSchema`` implementation plus ``installVtxCompat`` which applies the same
 * monkeypatch to a supplied vtx-tools-like module object (used by tests / a
 * future SDK shim). Safe to call more than once.
 */

export const SCHEMA_DROP_KEYS: ReadonlySet<string> = new Set([
  "title",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "default",
  "$schema",
]);

type Json = Record<string, unknown> | unknown[] | unknown;

function isDict(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/**
 * Corrected version of vtx's ``_slim_schema``: keeps property *names* intact
 * and only slims each property's schema. Mirrors the Python shim exactly —
 * including the anyOf-null collapse — but recurses into ``properties`` values
 * instead of dropping keys wholesale.
 */
export function slimSchema(node: Json): Json {
  if (isDict(node)) {
    const anyOf = node.anyOf;
    if (Array.isArray(anyOf)) {
      const nonNull = anyOf.filter(
        (s) => !(isDict(s) && s.type === "null"),
      );
      if (nonNull.length === 1 && isDict(nonNull[0])) {
        const merged: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          if (k !== "anyOf") merged[k] = v;
        }
        Object.assign(merged, nonNull[0]);
        return slimSchema(merged);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (SCHEMA_DROP_KEYS.has(key)) continue;
      if (key === "properties" && isDict(value)) {
        // Keys here are argument names the model must see verbatim —
        // slim each property's schema, never the name itself.
        const props: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(value)) {
          props[name] = slimSchema(sub as Json);
        }
        out[key] = props;
      } else {
        out[key] = slimSchema(value as Json);
      }
    }
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((item) => slimSchema(item as Json));
  }
  return node;
}

/** Aliases matching the Python private name for drop-in parity. */
export const _slim_schema = slimSchema;
export const slim_schema = slimSchema;

/**
 * Apply the shim to a vtx-tools-like module: replaces its ``_slim_schema``
 * (and ``slimSchema`` if present) with the corrected implementation.
 *
 * In the Python backend this ran as an import side effect against the real
 * vtx package. In TS there is no vtx module, so callers pass the target
 * explicitly; with no argument this is a no-op.
 */
export function installVtxCompat(target?: {
  _slim_schema?: unknown;
  slimSchema?: unknown;
  [k: string]: unknown;
}): void {
  if (!target) return;
  target._slim_schema = slimSchema;
  if ("slimSchema" in target) target.slimSchema = slimSchema;
}
