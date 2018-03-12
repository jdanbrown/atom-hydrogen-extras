'use babel'

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const hydrogen = {
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
};

// This is what we typically want
export function kernelForEditor(editor) {
  return kernelForPath((editor.buffer.file || {}).path);
}

// This is what hydrogen provides
export function kernelForPath(path) {
  return hydrogen.store.kernelMapping.get(path);
}

// This is another thing hydrogen provides, but prefer to use kernelForEditor/kernelForPath, to
// avoid weird UX race conditions
export function currentKernel() {
  return hydrogen.store.kernel;
}
