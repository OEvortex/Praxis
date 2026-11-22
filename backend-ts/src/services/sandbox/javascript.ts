// Port of services/sandbox/javascript.mjs — evaluate a self-contained JS
// expression in a capability-free WebAssembly VM (quickjs-emscripten).
//
// The expression may return a string or a Promise<string>. Only the result
// string crosses the boundary: no host callbacks, module loader, Node/browser
// objects, filesystem, environment, sockets or subprocess APIs are registered.
// Function() and eval stay inside the guest. This is separate from shell
// sandbox selection: a language VM does not grant permission to execute
// arbitrary host commands.
//
// The caller owns a disposable subprocess for a hard wall-clock deadline and
// cancellation. Interpreter limits also bound guest memory, stack and
// execution.
//
// TODO: `QuickJS` is the quickjs-emscripten module object; type it loosely
// until the dependency is added to package.json.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface QuickJSLike {
  newRuntime(): QuickJSRuntime;
}

export interface QuickJSRuntime {
  setMemoryLimit(bytes: number): void;
  setMaxStackSize(bytes: number): void;
  setInterruptHandler(handler: (() => boolean) | undefined): void;
  newContext(): QuickJSContext;
  hasPendingJob(): boolean;
  executePendingJobs(maxJobs?: number): QuickJSExecResult;
  dispose(): void;
}

export interface QuickJSContext {
  evalCode(code: string, filename?: string): QuickJSResult;
  getPromiseState(handle: QuickJSHandle): QuickJSPromiseState;
  typeof(handle: QuickJSHandle): string;
  getProp(obj: QuickJSHandle, key: string): QuickJSHandle;
  getNumber(handle: QuickJSHandle): number;
  getString(handle: QuickJSHandle): string;
  dump(handle: QuickJSHandle): any;
  dispose(): void;
}

export interface QuickJSHandle {
  dispose(): void;
  error?: QuickJSHandle;
  value?: QuickJSHandle;
  notAPromise?: boolean;
}

export interface QuickJSResult {
  error?: QuickJSHandle;
  value?: QuickJSHandle;
}

export interface QuickJSPromiseState {
  type: string; // "fulfilled" | "rejected" | "pending"
  value?: QuickJSHandle;
  error?: QuickJSHandle;
  notAPromise?: boolean;
}

export interface QuickJSExecResult {
  error?: QuickJSHandle;
}

export interface EvaluateOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxOutputChars?: number;
}

export async function evaluateJavaScript(
  QuickJS: QuickJSLike,
  source: string,
  {
    timeoutMs = 180000,
    memoryLimitBytes = 128 * 1024 * 1024,
    maxOutputChars = 64000,
  }: EvaluateOptions = {},
): Promise<string> {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  let handle: QuickJSHandle | undefined;
  const unwrap = (result: QuickJSResult): QuickJSHandle => {
    if (result.error) {
      // Error serialization also executes only in the bounded guest interpreter.
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(error?.message || String(error));
    }
    return result.value as QuickJSHandle;
  };
  try {
    handle = unwrap(context.evalCode(source, "sandbox.js"));
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() >= deadline) throw new Error("JavaScript execution timed out");
      const state = context.getPromiseState(handle);
      if (state.type === "rejected") {
        const error = context.dump(state.error as QuickJSHandle);
        (state.error as QuickJSHandle).dispose();
        throw new Error(error?.message || String(error));
      }
      if (state.type === "fulfilled") {
        try {
          if (context.typeof(state.value as QuickJSHandle) !== "string") {
            throw new Error("Sandbox must return a string");
          }
          const length = context.getProp(state.value as QuickJSHandle, "length");
          try {
            if (context.getNumber(length) > maxOutputChars) {
              throw new Error("Sandbox output limit exceeded");
            }
          } finally {
            length.dispose();
          }
          return context.getString(state.value as QuickJSHandle);
        } finally {
          if (!state.notAPromise) (state.value as QuickJSHandle).dispose();
        }
      }
      if (!runtime.hasPendingJob()) throw new Error("Sandbox promise did not settle");
      const jobs = runtime.executePendingJobs(1);
      if (jobs.error) {
        const error = context.dump(jobs.error);
        jobs.error.dispose();
        throw new Error(error?.message || String(error));
      }
    }
  } finally {
    handle?.dispose();
    context.dispose();
    runtime.dispose();
  }
}
