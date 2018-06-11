'use babel';

// TODO package.json so we don't break if these packages aren't installed
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);

const {HydrogenNotebooks} = require('./hydrogen-notebook');
const {markdownNotebooks} = require('./markdown-notebook');
const {packageName} = require('./util');

//
// module
//

const module = {

  // TODO Expose as user-editable module config
  _config: {
    trackOutput: false, // TODO I've wanted this as a setting
    unsetPYTHONSTARTUP: false, // TODO I've wanted this as a setting (e.g. work vs. personal)
    highlightCells: true,
    showCellTimesOver: 1, // Seconds
    skipHtml: false, // For dev
  },

  activate() {
    console.debug('hydrogen-extras: activate');
    this.disposables = new CompositeDisposable();
    this.notebookModules = {
      hydrogenNotebooks: new HydrogenNotebooks(this._config),
      markdownNotebooks,
    };
    Object.values(this.notebookModules).forEach(x => x.activate());

    window.notebooks = module.notebookModules.hydrogenNotebooks; // XXX dev
  },

  deactivate() {
    Object.values(this.notebookModules).forEach(x => x.deactivate());
    this.disposables.dispose();
    console.debug('hydrogen-extras: deactivate');
  },

  // 'keystroke ...' keymaps automatically work only for the user's ~/.atom/keymap.cson keymaps. We have to manually
  // register them for our own package keymap/* keymaps.
  consumeKeystroke(keystroke) {
    atom.packages.getLoadedPackage(packageName).getKeymapPaths().forEach(path => {
      this.disposables.add(
        keystroke.registerKeystrokeCommandsFromFile(path),
      );
    });
  },


};
export default module;
window.notebookModule = module; // XXX dev
