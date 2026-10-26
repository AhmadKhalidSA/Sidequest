// Python stepping for the "trace" board op. Runs in a Worker started by
// sandbox.html (opaque origin, CSP: no network). The overlay page reads the
// Pyodide files from node_modules and hands them over in the init message;
// a fetch shim serves them here, so nothing is ever downloaded. Each job runs
// the learner's code under sys.settrace with a step cap and records the line,
// the variables and the output at every step. The sandbox terminates this
// worker if a job runs past its time budget (an endless C-level loop).
'use strict';

const INDEX = 'https://sandbox.invalid/pyodide/';
let py = null;

setInterval(() => postMessage({ type: 'beat' }), 250);

const TRACER = `
import sys, builtins, io, json, traceback, time

class _SqStepLimit(BaseException):
    pass

def _sq_short(v):
    try:
        r = repr(v)
    except Exception:
        r = '<?>'
    return r if len(r) <= 60 else r[:57] + '...'

def _sq_vars(d):
    out = {}
    for k, v in d.items():
        if k.startswith('__') or callable(v) or type(v).__name__ == 'module':
            continue
        out[k] = _sq_short(v)
    return out

def _sq_trace(src, max_steps=400, stdin=()):
    steps, buf, feed = [], io.StringIO(), list(stdin)
    g = {'__name__': '__main__', '__builtins__': builtins}
    def _input(prompt=''):
        buf.write(str(prompt))
        line = str(feed.pop(0)) if feed else ''
        buf.write(line + '\\n')
        return line
    g['input'] = _input
    try:
        code = compile(src, '<lesson>', 'exec')
    except SyntaxError as e:
        return json.dumps({'steps': [], 'error': 'SyntaxError: %s' % e.msg, 'errline': e.lineno, 'output': ''})
    def snap(frame, event, ret=None):
        if len(steps) >= max_steps:
            raise _SqStepLimit()
        st = {'line': frame.f_lineno, 'o': len(buf.getvalue()), 'g': _sq_vars(g)}
        if frame.f_code.co_name != '<module>':
            st['fn'] = frame.f_code.co_name
            st['l'] = _sq_vars(frame.f_locals)
        if event == 'return':
            st['ret'] = _sq_short(ret)
        steps.append(st)
    def tracer(frame, event, arg):
        if frame.f_code.co_filename != '<lesson>':
            return None
        if event == 'line':
            snap(frame, event)
        elif event == 'return' and frame.f_code.co_name != '<module>':
            snap(frame, event, arg)
        return tracer
    err = errline = None
    truncated = False
    old_out, old_sleep = sys.stdout, time.sleep
    sys.stdout, time.sleep = buf, (lambda s=0: None)
    sys.settrace(tracer)
    try:
        exec(code, g)
    except _SqStepLimit:
        truncated = True
    except BaseException as e:
        tb = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == '<lesson>']
        errline = tb[-1].lineno if tb else None
        err = '%s: %s' % (type(e).__name__, e)
    finally:
        sys.settrace(None)
        sys.stdout, time.sleep = old_out, old_sleep
    steps.append({'line': errline, 'o': len(buf.getvalue()), 'g': _sq_vars(g), 'end': True})
    return json.dumps({'steps': steps, 'error': err, 'errline': errline, 'truncated': truncated, 'output': buf.getvalue()})
`;

async function boot(m) {
  postMessage({ type: 'beat', limit: 60000 });   // compiling ~10 MB of wasm takes a moment
  const files = { 'pyodide.asm.wasm': m.wasm, 'python_stdlib.zip': m.stdlib };
  const types = { 'pyodide.asm.wasm': 'application/wasm', 'python_stdlib.zip': 'application/zip' };
  self.fetch = async (url) => {
    const name = String(url && url.url ? url.url : url).split(/[?#]/)[0].split('/').pop();
    if (!files[name]) throw new TypeError('network access is disabled');
    return new Response(files[name], { status: 200, headers: { 'Content-Type': types[name] } });
  };
  // Pyodide only supports module workers; this classic worker loads its
  // ES module source as a plain script, so hide importScripts from its check.
  self.importScripts = undefined;
  const asm = String(m.asm)
    .replace(/import\.meta\.url/g, JSON.stringify(`${INDEX}pyodide.asm.mjs`))
    .replace(/export\s+default\s+_createPyodideModule\s*;?/, 'self.__sqCreatePyodide = _createPyodideModule;');
  (0, eval)(asm);
  (0, eval)(String(m.loader));
  py = await self.loadPyodide({
    indexURL: INDEX, lockFileContents: m.lock, createPyodideModule: self.__sqCreatePyodide,
    stdout: () => {}, stderr: () => {}, jsglobals: {}, fullStdLib: false, checkAPIVersion: false,
  });
  py.runPython(TRACER);
  postMessage({ type: 'ready' });
  postMessage({ type: 'beat', limit: 3000 });
}

function run(job) {
  postMessage({ type: 'beat', limit: Math.min(15000, Math.max(1000, job.ms || 6000)) });
  let res;
  try {
    py.globals.set('_sq_src', String(job.code || ''));
    py.globals.set('_sq_max', Math.max(1, Math.min(2000, job.maxSteps || 400)));
    py.globals.set('_sq_in', py.toPy((job.stdin || []).map(String)));
    res = JSON.parse(py.runPython('_sq_trace(_sq_src, _sq_max, _sq_in)'));
  } catch (e) {
    res = { steps: [], error: String(e && e.message ? e.message : e).split('\n').filter(Boolean).pop(), output: '' };
  }
  postMessage({ type: 'beat', limit: 3000 });
  postMessage({ type: 'result', job: job.job, ...res });
}

const queue = [];
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    try { await boot(m); } catch (err) {
      postMessage({ type: 'error', message: `python failed to start: ${err && err.message ? err.message : err}` });
      return;
    }
    for (const j of queue.splice(0)) run(j);
  } else if (m.type === 'msg' && m.data) {
    if (py) run(m.data); else queue.push(m.data);
  }
};
