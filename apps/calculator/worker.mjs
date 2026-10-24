// Runs in its own Node process started by index.ts under the permission model; the job
// arrives as one IPC message and the result leaves as one.
import { constants } from 'node:fs';
import { loadPyodide } from 'pyodide';

// The permission model refuses process.binding, but Pyodide's NODEFS reads only the file
// flag constants from it at startup; hand those over and nothing else.
process.binding = (name) => {
  if (name === 'constants') return { fs: constants };
  throw new Error(`process.binding(${name}) is not available.`);
};

const MAX_OUTPUT_BYTES = 65_536;
let stdout = '';
const workerData = await new Promise(resolve => process.once('message', resolve));
try {
  const pyodide = await loadPyodide({ stdout: text => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error('Output exceeded 64 KiB.');
    stdout += text + '\n';
  }, stderr: () => {} });
  // No host filesystem is mounted. Input reaches Python as JSON, never source interpolation.
  pyodide.globals.set('request_json', JSON.stringify(workerData));
  process.send({ type: 'ready' });
  const result = pyodide.runPython(`
import ast, builtins, json
request = json.loads(request_json)
tree = ast.parse(request['code'])
allowed_modules = {'math', 'statistics', 'decimal', 'fractions'}
# Frames and module links reach the host without underscores. Blocking them is only a
# first fence; the process permissions in index.ts are the real boundary.
blocked_attributes = {'sys', 'modules', 'os', 'importlib', 'builtins', 'gi_frame', 'gi_code', 'cr_frame', 'cr_code', 'ag_frame', 'ag_code', 'f_back', 'f_globals', 'f_locals', 'f_builtins', 'f_code', 'tb_frame', 'tb_next', 'co_consts', 'js', 'pyodide', 'pyodide_js'}
for node in ast.walk(tree):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        names = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module]
        if any(name not in allowed_modules for name in names):
            raise ValueError('Only math, statistics, decimal and fractions imports are available.')
    if isinstance(node, ast.Name) and node.id.startswith('_'):
        raise ValueError('Private names are not available.')
    if isinstance(node, ast.Attribute) and (node.attr.startswith('_') or node.attr in blocked_attributes):
        raise ValueError('Private attributes are not available.')
    if isinstance(node, ast.Name) and node.id in blocked_attributes:
        raise ValueError('That name is not available.')
safe_names = ('abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'float', 'int', 'len', 'list', 'max', 'min', 'pow', 'print', 'range', 'round', 'set', 'sorted', 'str', 'sum', 'tuple', 'zip')
safe_builtins = {name: getattr(builtins, name) for name in safe_names}
def limited_import(name, *args, **kwargs):
    if name not in allowed_modules:
        raise ValueError('This import is not available.')
    return builtins.__import__(name, *args, **kwargs)
safe_builtins['__import__'] = limited_import
scope = dict(request['inputs'])
scope['__builtins__'] = safe_builtins
exec(compile(tree, '<calculation>', 'exec'), scope, scope)
json.dumps({name: scope[name] for name in request['outputs']}, allow_nan=False)
`);
  if (Buffer.byteLength(result) > MAX_OUTPUT_BYTES) throw new Error('Values exceeded 64 KiB.');
  process.send({ status: 'completed', values: JSON.parse(result), stdout });
} catch (error) {
  const message = String(error?.message ?? 'Calculation failed').slice(-2000);
  process.send({ status: 'failed', values: {}, stdout, error: { code: 'calculation_error', message } });
}
