/**
 * Cheap caching for vtx's model metadata lookups.
 *
 * Port of ``backend/app/agent/vtx_catalog_cache.py``.
 *
 * Three separate hot spots in vtx's model discovery made the **first** turn of
 * every conversation wait ~6s before the model was even called (profiled with
 * cProfile: 11s of `ConversationRuntime.initialize()`, 10s of it in
 * `get_model`/`find_model`):
 *
 * 1. ``ContextLengthManager.get_limits`` resolves a model's limits by scanning the
 *    whole models.dev table, copying it into a list and normalising every key on
 *    every call. ids from a provider's own cached list never match exactly, so
 *    they always take that path.
 * 2. ``model_fetcher.get_fetched_models`` calls it once per cached model, then
 *    repeats an inline ``any(...)`` scan over the same table for ``is_matched``.
 * 3. ``find_model`` rebuilds every provider's model list from its cache file on
 *    each call, and ``initialize()`` resolves several models.
 *
 * `models.dev` limits are read-only after load, so all three are cacheable.
 * Nothing here changes what a lookup returns — the fast path applies the same
 * predicate, in the same order, to the same table.
 *
 * NOTE(TS port): vtx is a Python-only SDK, so there is no module to monkeypatch
 * at import time. Both installers accept the vtx-internal object to patch
 * explicitly (structurally typed); with no argument they are no-ops. The caching
 * logic itself is ported 1:1 so it can be applied to a compatible object (tests,
 * or a future TS SDK shim) with identical behaviour.
 */

// -- minimal structural types for the vtx internals being patched -------------

export interface TokenLimits {
  context: number;
  output: number;
  [k: string]: unknown;
}

/** Shape of vtx.ai.context_length.context_length_manager. */
export interface VtxContextLengthManager {
  ensure_loaded(): void;
  _limits: Record<string, TokenLimits>;
  _loaded: boolean;
  get_limits(model: string): TokenLimits;
  [k: string]: unknown;
}

export interface VtxModel {
  [k: string]: unknown;
}

/** Shape of a vtx provider object passed to get_fetched_models. */
export interface VtxProvider {
  slug?: string;
  [k: string]: unknown;
}

/** Shape of the vtx.ai.model_fetcher module. */
export interface VtxModelFetcher {
  get_fetched_models(provider: VtxProvider): VtxModel[];
  _cache_path(slug: string): { stat(): { mtimeNs: bigint; size: number } };
  [k: string]: unknown;
}

let _installed = false;

/**
 * Memoise + de-quadratic ``context_length_manager.get_limits`` (idempotent).
 * Mirrors the Python implementation: exact hit → memo → normalised-substring
 * scan over a per-table-size index.
 */
export function install_context_limit_cache(
  manager?: VtxContextLengthManager,
): void {
  if (_installed) return;
  _installed = true;
  if (!manager) return; // no vtx in TS — nothing to patch

  // (len of the limits table) -> (ids in insertion order, normalised ids)
  const index = new Map<number, [string[], string[]]>();
  const memo = new Map<string, TokenLimits>();

  function getLimits(model: string): TokenLimits {
    manager!.ensure_loaded();
    const limits = manager!._limits;
    const size = Object.keys(limits).length;
    const key = JSON.stringify([model, size, manager!._loaded]);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let value: TokenLimits;
    if (model in limits) {
      value = limits[model];
    } else {
      let snapshot = index.get(size);
      if (snapshot === undefined) {
        const ids = Object.keys(limits);
        snapshot = [ids, ids.map((i) => i.toLowerCase().replace(/-/g, ""))];
        index.clear();
        index.set(size, snapshot);
      }
      const [ids, normalised] = snapshot;
      const target = model.toLowerCase().replace(/-/g, "");
      value = { context: 0, output: 0 };
      for (let i = 0; i < ids.length; i++) {
        const mid = normalised[i];
        if (target.includes(mid) || mid.includes(target)) {
          value = limits[ids[i]] ?? value;
          break;
        }
      }
    }

    if (memo.size > 20_000) {
      // A long-lived server with many model ids; start over rather than
      // growing without bound. Either way the work stays bounded.
      memo.clear();
    }
    memo.set(key, value);
    return value;
  }

  manager.get_limits = getLimits;
}

/**
 * Memoise ``vtx.ai.model_fetcher.get_fetched_models`` per provider.
 *
 * ``find_model`` walks the providers and rebuilds each one's list from its
 * cache file; ``initialize()`` resolves several models, so the same lists were
 * rebuilt ~25 times per session. The rebuild is a pure function of the cache
 * file, so cache it against the file's ``(mtime, size)``.
 */
export function install_model_fetch_cache(
  fetcher?: VtxModelFetcher,
): void {
  if (!fetcher) return; // no vtx in TS — nothing to patch

  const original = fetcher.get_fetched_models.bind(fetcher);
  const cache = new Map<string, VtxModel[]>();

  function getFetchedModels(provider: VtxProvider): VtxModel[] {
    const slug = String(provider?.slug ?? "");
    let stat: { mtimeNs: bigint; size: number };
    try {
      stat = fetcher!._cache_path(slug).stat();
    } catch {
      // No cache file: nothing to cache, and the caller gets the empty
      // list it always got.
      return original(provider);
    }
    const signature = JSON.stringify([slug, String(stat.mtimeNs), stat.size]);
    let cached = cache.get(signature);
    if (cached === undefined) {
      cached = original(provider) ?? [];
      if (cache.size > 64) cache.clear();
      cache.set(signature, cached);
    }
    // Callers may sort or filter the result; never hand out the cache itself.
    return [...cached];
  }

  fetcher.get_fetched_models = getFetchedModels;
}

// camelCase aliases for callers that prefer TS convention.
export { install_context_limit_cache as installContextLimitCache };
export { install_model_fetch_cache as installModelFetchCache };
