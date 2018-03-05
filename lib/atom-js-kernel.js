'use babel';

import vm from 'vm';

// TODO Autocomplete? Limited use without this...
// TODO New context per editor
//  - Else `const x = 3` fails if you ever run it twice
//  - Pass in globals to each new context
//  - https://nodejs.org/api/vm.html
// TODO No way to kill AtomJsKernel since it's not hydrogen
//  - Have to restart the atom window!
// TODO Any way to format like chrome dev console?
//  - Workaround: automatically log in dev console
export class AtomJsKernel {
  execute(code, onResult) {
    let result, e, ok;
    try {
      result = vm.runInThisContext(code);
      ok = true;
    } catch (_e) {
      e = _e;
      ok = false;
    }
    if (ok) {
      console.info('AtomJsKernel: ok\n', `\n${code}\n`, result);
      onResult({
        output_type: 'execute_result',
        data: {
          'text/plain': result, // Don't .toString(), in case we can get fancier behavior somewhere
        },
      });
      onResult({
        stream: 'status',
        data: 'ok',
      });
    } else {
      console.error('AtomJsKernel: error\n', `\n${code}\n`, e); // (How to format nicely?)
      onResult({
        output_type: 'error',
        ename: typeof(e),
        evalue: e.toString(),
        traceback: e.stack.split('\n'),
      });
      onResult({
        stream: 'status',
        data: 'error',
      });
    }
  }
}
