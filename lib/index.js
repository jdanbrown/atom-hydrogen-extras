'use babel';

// TODO package.json so we don't break if these packages aren't installed
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);

const {HydrogenNotebooks} = require('./hydrogen-notebook');
const {markdownNotebooks} = require('./markdown-notebook');

//
// module
//

const module = {

  // TODO Expose as user-editable module config
  _config: {
    trackOutput: true,
    unsetPYTHONSTARTUP: true,
    highlightCells: true,
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

};
export default module;
window.notebookModule = module; // XXX dev
