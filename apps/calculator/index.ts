import { Worker } from 'node:worker_threads';

const MAX_CODE_BYTES = 32_768;
const MAX_INPUT_BYTES = 65_536;
const EXECUTION_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 30_000;
let busy = false;

export interface CalculationRequest {
  code: string;
  inputs?: Record<string, unknown>;
  outputs?: string[];
  units?: Record<string, string>;
  timeoutMs?: number;
}
export interface CalculationResult {
  status: 'completed' | 'failed';
  values: Record<string, unknown>;
  stdout: string;
  units: Record<string, string>;
  error?: { code: string; message: string };
}

/** Run one bounded calculation in a fresh Python worker. This is not an OS sandbox. */
export async function calculate(request: CalculationRequest): Promise<CalculationResult> {
  const failure = (code: string, message: string): CalculationResult => ({ status: 'failed', values: {}, stdout: '', units: {}, error: { code, message } });
  if (!request || typeof request.code !== 'string' || Buffer.byteLength(request.code) > MAX_CODE_BYTES) return failure('invalid_input', 'Python code must be at most 32 KiB.');
  const inputs = request.inputs ?? {};
  const outputs = request.outputs ?? ['result'];
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Buffer.byteLength(JSON.stringify(inputs)) > MAX_INPUT_BYTES || Object.keys(inputs).some(key => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key))) return failure('invalid_input', 'Inputs must be a small object with plain variable names.');
  if (!Array.isArray(outputs) || outputs.length > 32 || outputs.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key))) return failure('invalid_input', 'Select up to 32 plain output variable names.');
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1)) return failure('invalid_input', 'Timeout must be positive.');
  if (busy) return failure('busy', 'Another calculation is running.');
  busy = true;
  try {
    return await new Promise<CalculationResult>((resolve) => {
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), { execArgv: [], workerData: { code: request.code, inputs, outputs }, env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      let finished = false;
      const finish = (result: CalculationResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void worker.terminate().then(() => resolve(result));
      };
      let timer = setTimeout(() => finish(failure('startup_timeout', 'Python startup timed out.')), STARTUP_TIMEOUT_MS);
      worker.on('message', (message) => {
        if (message.type === 'ready') {
          clearTimeout(timer);
          timer = setTimeout(() => finish(failure('timeout', 'Calculation exceeded its time limit.')), Math.min(request.timeoutMs ?? EXECUTION_TIMEOUT_MS, EXECUTION_TIMEOUT_MS));
        } else finish({ ...message, units: request.units ?? {} });
      });
      worker.on('error', () => finish(failure('worker_error', 'Python worker failed.')));
      worker.on('exit', () => { if (!finished) finish(failure('worker_exit', 'Python worker stopped unexpectedly.')); });
    });
  } finally { busy = false; }
}
