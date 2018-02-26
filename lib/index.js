'use babel';

import clipboard from 'clipboard';
import {app, nativeImage} from 'electron';
import fs from 'fs';
import path from 'path';
import {File, Point, Range, TextBuffer, TextEditor} from 'atom';
import vm from 'vm';

// TODO package.json so we don't break if these packages aren't installed
const configDir = atom.getConfigDirPath();
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const chance = require(`${atom.packages.resolvePackagePath('random')}/node_modules/chance`).Chance();
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
  utils: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/utils`),
  HydrogenProvider: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/plugin-api/hydrogen-provider`),
};
const stripAnsi = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/strip-ansi`);
const yaml = require(`${atom.packages.resolvePackagePath('docker')}/node_modules/js-yaml`);

const {codeChunksForSelection} = require('./cells');

const packageName = 'hydrogen-extras';

window.hydrogen = hydrogen; // XXX dev

//
// utils
//

// TODO Use npm promise [https://www.npmjs.com/package/promise]
Promise.prototype.finally = function (f) {
  return this.then(function (value) {
    return Promise.resolve(f()).then(function () {
      return value;
    });
  }, function (err) {
    return Promise.resolve(f()).then(function () {
      throw err;
    });
  });
};

// XXX Unused
function ifPackageActive(packageName, f) {
  const p = atom.packages.getActivePackage(packageName);
  return p ? f(p.mainModule) : null;
}

// f might be called multiple times
function onPackageByName(packageName, f) {
  // Catch it if it activates in the future
  const disposable = atom.packages.onDidActivatePackage(_package => {
    if (_package.name === packageName) {
      f(_package);
    }
  });
  // Catch it if it activated in the past
  const _package = atom.packages.getActivePackage(packageName);
  if (_package) {
    f(_package);
    disposable.dispose();
  }
  return disposable;
}

function mktemp({prefix, suffix, tmpdir}) {
  tmpdir = tmpdir || '/tmp'
  const random = chance.hash({length: 8})
  return `${tmpdir}/${prefix}${random}${suffix}`
}

function elementsFromHtml(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  // Copy .childNodes in case div mutates, e.g. if you .append one of its children elsewhere in the
  // dom (since a node can't exist in multiple places in the dom)
  return Array.from(div.childNodes)
}

function clipboardCopyImageFromDataURL(dataURL) {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL))
}

function clipboardCopyImg(img) {
  if (!img.src.startsWith('data:')) {
    throw `Only data urls are supported: img.src[${img.src}]`
  }
  clipboardCopyImageFromDataURL(img.src)
}

async function svgToPngDataUrl(svg) {
  const [svgWidth, svgHeight] = [svg.clientWidth, svg.clientHeight]
  if (svgWidth === 0 || svgHeight === 0) {
    // This happens when the svg elem isn't visible (not sure how to get width/height in that case)
    throw `svg.clientWidth[${svgWidth}] and svg.clientHeight[${svgHeight}] must be nonzero`
  }
  const canvas = document.createElement('canvas')
  canvas.width = svgWidth * devicePixelRatio // devicePixelRatio=2 for retina displays
  canvas.height = svgHeight * devicePixelRatio
  canvas.style.width = `${svgWidth}px`
  canvas.style.height = `${svgHeight}px`
  const ctx = canvas.getContext('2d')
  ctx.scale(devicePixelRatio, devicePixelRatio)
  const svgObjectUrl = URL.createObjectURL(new Blob([svg.outerHTML], {type: 'image/svg+xml'}))
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(svgObjectUrl) // Deallocate object
      resolve(canvas.toDataURL("image/png"))
    }
    img.src = svgObjectUrl
  })
}

function joinIfArray(x) {
  return x instanceof Array ? x.join('') : x;
}

function getPathComponents(path) {
  return path.split('/').filter(x => x);
}

// TODO Why isn't https://github.com/atom/atom/issues/16454 fixed in atom-1.23.3?
function warnIfTextEditorIdsAreNotUnique() {
  const editors = atom.workspace.getTextEditors();
  const dupeIds = _.chain(editors).countBy(x => x.id).flatMap((v, k) => v > 1 ? [k] : []).value();
  // Careful: dupeIds are string instead of int since js objects coerce keys via .toString()
  const dupeEditors = _.chain(dupeIds).flatMap(id => editors.filter(e => e.id.toString() === id)).value();
  if (_.size(dupeEditors) > 0) {
    atom.notifications.addWarning(
      "TextEditor id's are not unique! Try manually closing and reopening one of them. [https://github.com/atom/atom/issues/16454]",
      {
        dismissable: true,
        icon: 'bug',
        detail: dupeEditors.map(e => `${e.id} -> ${(e.buffer.file || {}).path}\n`).join(''),
      },
    );
  }
}

// TODO How to generically provide xterm.newTerm? (just hard depend on xterm package?)
// TODO How to generically pass in command? (pretty gnarly...)
function newTermWithCommand(command) {
  console.info('newTermWithCommand:', command);
  const xterm = atom.packages.getLoadedPackage('xterm').mainModule;
  xterm.newTerm({opts: {moreEnv: {'TMUX_NEW_SESSION_SHELL_COMMAND': command}}});
  // TODO Abstract into function `openInAdjacentPane`
  // TODO Package these commands up so we can declare a package dependency on them
  // Open term as new item in current pane, and require user to move it wherever they want; trying
  // to open the term in some adjacent pane too often produces a weird result that's more jarring
  // than helpful
  // atom.commands.dispatch(atom.workspace.element, 'user:window-move-active-item-to-pane-on-right');
}

//
// notebook
//

const module = {

  _config: {
    trackOutput: true,
    unsetPYTHONSTARTUP: true,
    skipHtml: false, // For dev
  },

  disposables: null,

  activate() {
    console.debug('hydrogen-extras: activate');
    this.disposables = new CompositeDisposable();
    this.notebookModules = {
      notebookHydrogen,
      notebookMarkdownImages,
    };
    Object.values(this.notebookModules).forEach(x => x.activate());
  },

  deactivate() {
    Object.values(this.notebookModules).forEach(x => x.deactivate());
    this.disposables.dispose();
    console.debug('hydrogen-extras: deactivate');
  },

};
export default module;
window.notebook = module; // XXX dev

const notebookHydrogen = {

  disposables: null,
  notebooks: new Map(), // TextEditor -> NotebookHydrogen
  seenKernels: new Set(), // Kernel

  activate() {
    // Force hydrogen to activate before we do
    if (!atom.packages.isPackageActive('Hydrogen')) {
      atom.packages.getLoadedPackage('Hydrogen').activateNow();
    }
    this.disposables = new CompositeDisposable();
    this.addCommands();
    this.observeKernels();
    this.disposables.add(
      atom.workspace.observeTextEditors(editor => {
        if (!this.notebooks.get(editor)) {
          // warnIfTextEditorIdsAreNotUnique(); // XXX if the switch from editor.id -> editor worked...
          const notebook = new NotebookHydrogen(this, editor);
          this.notebooks.set(editor, notebook);
          this.disposables.add(
            editor.onDidDestroy(() => {
              this.notebooks.get(editor).destroy();
              this.notebooks.delete(editor);
            })
          );
        }
      }),
      onPackageByName('vim-mode-plus', _package => {
        this.vmp = _package.mainModule;
        this.moreVmp = require('./more-vim-mode-plus');
      }),
    );
    if (notebook._config.unsetPYTHONSTARTUP) {
      this.setPYTHONSTARTUP({unset: true, quiet: true});
    }
  },

  deactivate() {
    this.shutdownSeenKernels();
    this.setPYTHONSTARTUP({restore: true, quiet: true});
    this.disposables.dispose();
    if (this.moreVmp) this.moreVmp.disposables.dispose();
    Array.from(this.notebooks.values()).forEach(notebook => notebook.destroy());
    // Leave kernels running, since they're owned by Hydrogen and not us
    //  - TODO Does Hydrogen properly clean up kernels on deactive/exit? PR if not
  },

  observeKernels() {
    this.hydrogenProvider = new hydrogen.HydrogenProvider(hydrogen.main);
    this.disposables.add(
      hydrogen.main.emitter.on('did-change-kernel', (kernel) => {
        // console.info('Kernel changed', kernel && kernel.displayName);
        window.kernel = kernel; // XXX dev
        this.ifActiveNotebook(notebook => notebook.updateKernel(kernel));
        if (kernel) {
          if (!this.seenKernels.has(kernel)) {
            this.seenKernels.add(kernel);
            console.info('Kernel added:', kernel.displayName);
            // HACK: Add PYTHONSTARTUP to displayName so it's loudly visibile (e.g. in status-bar)
            if (process.env.PYTHONSTARTUP) {
              kernel.displayName = `${kernel.displayName} (PYTHONSTARTUP)`;
            }
            atom.notifications.addInfo(`Started kernel: ${kernel.displayName}`);
            this.disposables.add(
              kernel.emitter.on('did-destroy', () => {
                console.info('Kernel destroyed:', kernel.displayName);
                this.seenKernels.delete(kernel);
              }),
            );
          }
        }
      }),
    );
  },

  shutdownSeenKernels() {
    console.info(`Shutting down seen kernels: ${this.seenKernels.size} kernel(s)`);
    this.seenKernels.forEach(kernel => this.shutdownKernel(kernel));
  },

  shutdownKernel(kernel) {
    if (kernel) {
      kernel.shutdown(); // WSKernel needs shutdown + destroy (ZMQKernel.destroy does shutdown)
      try {
        // This sometimes fails, e.g. if you change kernels (multiple times?) in the same editor
        //  - Does this still fail? I can't repro after the first time, which might have been muddied by dirty atom hacking state
        kernel.destroy();
      } catch (e) {
        console.warn(e);
      }
    }
  },

  addCommands() {
    this.disposables.add(
      atom.commands.add('atom-workspace', {
        'hydrogen-extras:toggle-track-output': ev => this.getActiveNotebook().toggleTrackOutput(),
        'hydrogen-extras:toggle-pythonstartup': ev => this.setPYTHONSTARTUP({toggle: true}),
        'hydrogen-extras:scroll-to-last-output': ev => this.getActiveNotebook().scrollToLastOutput(),
        'hydrogen-extras:jump-to-last-output': ev => this.getActiveNotebook().jumpToLastOutput(),
        'hydrogen-extras:run-code-selection': ev => this.getActiveNotebook().runCodeSelection(),
        'hydrogen-extras:run-code-selection-inpane': ev => this.getActiveNotebook().runCodeSelection({inpane: true}),
        'hydrogen-extras:run-code-line': ev => this.getActiveNotebook().runCodeLine(),
        'hydrogen-extras:run-code-line-inpane': ev => this.getActiveNotebook().runCodeLine({inpane: true}),
        'hydrogen-extras:run-code-selection-or-line': ev => this.getActiveNotebook().runCodeSelectionOrLine(),
        'hydrogen-extras:run-selected-paras': ev => this.getActiveNotebook().runSelectedChunks('para'),
        'hydrogen-extras:run-all-paras': ev => this.getActiveNotebook().runAllChunks('para'),
        'hydrogen-extras:run-all-paras-above': ev => this.getActiveNotebook().runAllChunksAbove('para'),
        'hydrogen-extras:run-all-paras-below': ev => this.getActiveNotebook().runAllChunksBelow('para'),
        'hydrogen-extras:run-all-paras-above-and-selected': ev => this.getActiveNotebook().runAllChunksAboveAndSelected('para'),
        'hydrogen-extras:run-all-paras-below-and-selected': ev => this.getActiveNotebook().runAllChunksBelowAndSelected('para'),
        'hydrogen-extras:run-selected-cells': ev => this.getActiveNotebook().runSelectedChunks('cell'),
        'hydrogen-extras:run-all-cells': ev => this.getActiveNotebook().runAllChunks('cell'),
        'hydrogen-extras:run-all-cells-above': ev => this.getActiveNotebook().runAllChunksAbove('cell'),
        'hydrogen-extras:run-all-cells-below': ev => this.getActiveNotebook().runAllChunksBelow('cell'),
        'hydrogen-extras:run-all-cells-above-and-selected': ev => this.getActiveNotebook().runAllChunksAboveAndSelected('cell'),
        'hydrogen-extras:run-all-cells-below-and-selected': ev => this.getActiveNotebook().runAllChunksBelowAndSelected('cell'),
        'hydrogen-extras:delete-result-at-cursor': ev => this.getActiveNotebook().deleteResultAtCursor(),
        'hydrogen-extras:delete-all-results': ev => this.getActiveNotebook().deleteAllResults(),
        'hydrogen-extras:toggle-kernel-monitor': ev => this.toggleKernelMonitor(),
        'hydrogen-extras:new-term-with-jupyter-for-current-kernel': ev => this.getActiveNotebook().newTermWithJupyterForCurrentKernel(),
        // TODO Move cmd + newTermWithCommand out of this package [and into what package?]
        'hydrogen-extras:new-term-with-htop': ev => newTermWithCommand('sudo htop -d10'),
      }),
      atom.commands.add('atom-text-editor', {
        'hydrogen-extras:interrupt-kernel': ev => this.getActiveNotebook().interruptKernel(),
        'hydrogen-extras:shutdown-kernel-and-delete-all-results': ev => this.getActiveNotebook().shutdownKernelAndDeleteAllResults(),
      }),
    );
  },

  getActiveNotebook() {
    return this.getNotebookForTextEditor(atom.workspace.getActiveTextEditor());
  },

  ifActiveNotebook(f) {
    const notebook = this.getActiveNotebook();
    if (notebook) {
      return f(notebook);
    }
  },

  getNotebookForTextEditor(editor) {
    return this.notebooks.get(editor);
  },

  setPYTHONSTARTUP(options = {}) {
    if (
      options.toggle ||
      options.unset && process.env.PYTHONSTARTUP ||
      options.restore && process.env._SAVED_PYTHONSTARTUP
    ) {
      [process.env._SAVED_PYTHONSTARTUP, process.env.PYTHONSTARTUP] = [
        process.env.PYTHONSTARTUP || '', process.env._SAVED_PYTHONSTARTUP || '',
      ];
      if (!options.quiet) {
        atom.notifications.addInfo(process.env.PYTHONSTARTUP ?
            `Restored PYTHONSTARTUP (${process.env.PYTHONSTARTUP})` :
            `Unset PYTHONSTARTUP (was: ${process.env._SAVED_PYTHONSTARTUP})`
        );
      }
    }
  },

  async toggleKernelMonitor() {
    const pane = atom.workspace.getActivePane();
    await atom.workspace.toggle(hydrogen.utils.KERNEL_MONITOR_URI);
    pane.focus();
  },

}
window.notebookHydrogen = notebookHydrogen; // XXX dev

class NotebookHydrogen {

  constructor(notebookHydrogen, editor) {
    console.debug('NotebookHydrogen.constructor', editor);

    this.notebookHydrogen = notebookHydrogen;
    this.editor = editor;
    this.kernel = null;
    this.markerLayer = this.editor.addMarkerLayer({maintainHistory: true, persistent: true});
    this.pendingResultReceivers = new Set();
    this.trackOutput = notebook._config.trackOutput;

    // If .ipynb:
    //  - Sync .ipynb.view -> .ipynb
    //  - Sync .ipynb -> .ipynb.view
    if (this.editor.buffer.file) {
      const editorPath = (this.editor.buffer.file || {}).path;
      const ext = path.extname(editorPath);
      // TODO Think harder about if we want automatic two-way sync. Might be too error prone.
      // TODO Add more safeguards when overwriting files (e.g. prompt, but not all the time?)
      if (ext === '.ipynb') {

        // TODO Janky open: e.g. on reopen tab, reload window
        console.log('atom.workspace', atom.workspace); // XXX
        this.ipynbViewEditor = atom.workspace.open(`${editorPath}-view`, {
          searchAllPanes: true,
          split: 'right',
        }).then(ipynbViewEditor => {

          // TODO Fix atom.workspace.openSync error so we can init this.* sync instead of async
          this.ipynbViewEditor = ipynbViewEditor;

          // Re-focus .ipynb editor
          const pane = atom.workspace.paneForItem(editor);
          pane.focus();
          pane.activateItem(editor);

          // Have to open .ipynb to get link with .ipynb-view
          const notebookPath = editorPath + '-view';
          this.disposables.add(
            this.editor.onDidStopChanging(() => {
              // TODO Janky guard to prevent infinite change loop between the two editors
              //  - Usually works, except if the user switches panes before 300ms
              if (this.editor === atom.workspace.getActiveTextEditor()) {
                console.debug('this.editor.onDidStopChanging');
                this.syncViewFromIpynb(this.ipynbViewEditor, this.editor);
              }
            }),
            this.ipynbViewEditor.onDidStopChanging(() => {
              if (this.ipynbViewEditor === atom.workspace.getActiveTextEditor()) {
                console.debug('this.ipynbViewEditor.onDidStopChanging');
                this.syncViewToIpynb(this.ipynbViewEditor, this.editor);
              }
            }),
          );
          this.syncViewFromIpynb(this.ipynbViewEditor, this.editor);

        })

      }
    }

  }

  destroy() {
    this.markerLayer.clear();
    this.markerLayer.destroy();
    this.updateKernel(null); // Shutdown kernel
  }

  updateKernel(kernel) {
    kernel = kernel || null; // Avoid undefined vs. null confusion
    if (kernel !== this.kernel) {
      const oldKernel = this.kernel;
      this.kernel = kernel;
      console.info(`Notebook[editor.id:${this.editor.id}] changed kernel: ${oldKernel && oldKernel.displayName} -> ${kernel && kernel.displayName}`);
      if (oldKernel) {
        this.shutdownKernelAndDeleteAllResults(oldKernel);
      }
    }
  }

  // hydrogen:interrupt-kernel + notification [TODO PR]
  //  - Duplicates: hydrogen.main.handleKernelCommand
  interruptKernel() {
    const {kernel} = hydrogen.store;
    if (!kernel) {
      atom.notifications.addWarning('No kernel running');
    } else {
      atom.notifications.addInfo(`^C kernel: ${kernel.displayName}`);
      kernel.interrupt();
    }
  }

  // hydrogen:shutdown-kernel + deleteAllResults + notification [TODO PR?]
  //  - Duplicates: hydrogen.main.handleKernelCommand
  shutdownKernelAndDeleteAllResults(kernel) {
    if (!kernel) {
      kernel = hydrogen.store.kernel;
      if (!kernel) atom.notifications.addWarning('No kernel running');
    }
    if (kernel) {
      atom.notifications.addInfo(`Shutting down kernel: ${kernel.displayName}`);
      this.notebookHydrogen.shutdownKernel(kernel);
      this.deleteAllResults();
    }
  }

  toggleTrackOutput() {
    this.trackOutput = !this.trackOutput;
    atom.notifications.addInfo(`Track output: ${this.trackOutput}`);
  }

  setLastOutputScreenPosition(position) {
    // console.info(`setLastOutputScreenPosition(${position.row}, ${position.column})`); // XXX dev
    this.lastOutputScreenPosition = position;
    if (this.trackOutput) {
      // TODO Which of these is better UX?
      //  - scrollToLastOutput
      //    (--) Screen sometimes doesn't track properly (feels like a race condition, but I can't spot it...)
      //    (-) No visual feedback to user which line is being tracked, a little confusing
      //  - jumpToLastOutput / "auto-advance"
      //    (++) Screen tracks properly -- more reliably than scrollToLastOutput
      //    (-) Feels like advance but inconsistent: positions cursor after output instead of start of next cell
      //        (?) Solvable? -- just change to be start of next cell / para / non-blank line?
      //    (-) Interferes with cursor, e.g. if you're holding down run-cell-and-advance
      //        - This one's unavoidable...
      this.scrollToLastOutput();
      // this.jumpToLastOutput();
    }
    // If vim-mode-plus, set mark "h" for last output ("h" for "hydrogen")
    if (this.notebookHydrogen.vmp) {
      this.notebookHydrogen.vmp.getEditorState(this.editor).mark.set('h', this.lastOutputScreenPosition);
    }
  }

  scrollToLastOutput() {
    // console.info(`scrollToLastOutput(${this.lastOutputScreenPosition.row}, ${this.lastOutputScreenPosition.column})`); // XXX dev
    const p = this.lastOutputScreenPosition; // TODO Make this object a Point so I can .translate
    this.editor.scrollToScreenPosition([p.row + 5, p.column]);
  }

  jumpToLastOutput() {
    this.editor.setCursorScreenPosition(this.lastOutputScreenPosition);
  }

  deleteAllResults() {
    this.markerLayer.clear();
  }

  deleteResultAtCursor() {
    this.deleteMarkersByFind({
      intersectsRow: this.editor.getCursorBufferPosition().row,
    });
  }

  deleteMarkersInTheWayOfNewResults(range) {
    this.deleteMarkersByFind({startsInRange: range});
    this.deleteMarkersByFind({endsInRange: range});
  }

  deleteMarkersByFind(properties) {
    this.markerLayer.findMarkers(properties).forEach(marker => {
      marker.destroy();
    });
  }

  async newTermWithJupyterForCurrentKernel() {
    const kernel = await this.ensureKernel();
    if (kernel) {
      const connectionFile = await this.runCodeReturnOutput(
        // TODO Add node_modules so we can dedent for multiline quotes `...` [https://github.com/dmnd/dedent]
        'from ipykernel import *; print(get_connection_file())'
      ).then(x => x.trim());
      newTermWithCommand(`jupyter console --existing=${connectionFile}`);
    }
  }

  async runCodeSelection(options = {}) {
    return this.runCode(options, this.editor.getSelectedBufferRange());
  }

  async runCodeLine(options = {}) {
    return this.runCode(
      options,
      this.editor.buffer.rangeForRow(this.editor.getCursorBufferPosition().row),
    );
  }

  async runCodeSelectionOrLine(options = {}) {
    if (this.editor.getSelectedBufferRange().isEmpty()) {
      return this.runCodeLine(options);
    } else {
      return this.runCodeSelection(options);
    }
  }

  async runSelectedChunks(type, options = {}) {
    this.runCodeChunks(codeChunksForSelection(type, this.editor, {selected: true}), options);
  }
  async runAllChunks(type, options = {}) {
    this.runCodeChunks(codeChunksForSelection(type, this.editor, {all: true}), options);
  }
  async runAllChunksAbove(type, options = {}) {
    this.runCodeChunks(codeChunksForSelection(type, this.editor, {above: true}), options);
  }
  async runAllChunksBelow(type, options = {}) {
    this.runCodeChunks(codeChunksForSelection(type, this.editor, {below: true}), options);
  }
  async runAllChunksAboveAndSelected(type, options = {}) {
    this.runCodeChunks(codeChunksForSelection(type, this.editor, {above: true, selected: true}), options);
  }
  async runAllChunksBelowAndSelected(type, options = {}) {
    this.runCodeChunks(codeChunksForSelection(type, this.editor, {below: true, selected: true}), options);
  }

  async runCodeChunks(chunkRanges, options = {}) {
    this.editor.clearSelections();
    await Promise.all(chunkRanges.map(range => {
      return this.runCode(options, range);
    }));
  }

  async runCodeReturnOutput(code) {
    const kernel = await this.ensureKernel();
    if (kernel) {
      let output = '';
      return new Promise((resolve, reject) => {
        kernel.execute(code, result => {
          // TODO Figure out a better way to reuse these two functions than static methods
          NotebookHydrogenResultReceiver.normalizeKernelResult(result);
          if (result.output_type === 'stream' && result.name === 'stdout') {
            output += result.text;
          } else if (result.output_type === 'error') {
            reject(NotebookHydrogenResultReceiver.formatKernelResultTraceback(result.traceback));
          } else if (result.stream === 'status' && result.data === 'ok') {
            resolve(output);
          }
        });
      });
    }
  }

  async runCode(options, range) {
    // warnIfTextEditorIdsAreNotUnique(); // XXX if the switch from editor.id -> editor worked...
    range = this.trimCodeRange(this.editor.buffer, range);
    const code = this.editor.buffer.getTextInRange(range).trimRight();
    if (!code) return;
    const resultReceiver = new NotebookHydrogenResultReceiver(
      options, this, this.editor, range, code,
    );
    // console.info(`XXX this.ensureKernel: code[${code}]`);
    const kernel = await this.ensureKernel();
    // console.info(`XXX this.ensureKernel: code[${code}], kernel[${kernel}]`);
    if (kernel) {
      // console.info(`XXX kernel.execute: code[${code}]`);
      // TODO Adapt kernel.execute into Promise [is this causing any problems currently?]
      kernel.execute(code, result => resultReceiver.onKernelResult(result));
    } else {
      resultReceiver.onKernelResult({
        stream: 'status',
        data: 'error',
      });
    }
    return await resultReceiver.promise;
  }

  trimCodeRange(buffer, range) {
    // TODO Trim all whitespace, not just \n
    while (buffer.getTextInRange(range).startsWith('\n')) {
      range = range.translate([1, 0], [0, 0]);
    }
    while (buffer.getTextInRange(range).endsWith('\n')) {
      range = range.translate([0, 0], [-1, buffer.rangeForRow(range.end.row - 1).end.column]);
    }
    // Allow a trailing blank line if we contain any blank lines, e.g. for cells vs. paragraphs
    //  - TODO Oops, doing this abuts our output with the top of the next cell, which is worse...
    //  - TODO How do we want this to look? Should we resort to css styling...?
    // if (/^\s*$/m.test(editor.buffer.getTextInRange(range))) {
    //   range = range.translate([0, 0], [1, 0]);
    // }
    return range;
  }

  // TODO [WIP] Auto-run code when its contents change
  //  - Idea: Pick code range, "watch-code" instead of "run-code"
  //  - Need way to visually indicate a watch
  //  - Need way to unwatch a watched code segment
  //  - Allow "code range" to be line/para/block/selection
  //  - Ok to require a watch to be contiguous (i.e. a single selection), since non-contiguous seems pathological
  async watchCode(options, range) {
    const marker = this.markerLayer.markBufferRange(range, {
      class: 'watchcode-marker',
      // See comments in NotebookHydrogenResultReceiver.constructor
      exclusive: true,
      invalidate: 'surround',
    });
    const onBufferChange = this.editor.buffer.onDidStopChanging(ev => {
      console.warn('buffer.bufferChanged', ev.changes);
      // TODO Still lots of false positives; also condition on range's text actually changing
      //  - This will require state to track what range's text looked like last time
      if (_.some(
        ev.changes,
        change => range.intersectsWith(change.oldRange) || range.intersectsWith(change.newRange),
      )) {
        console.warn('marker.bufferChanged', marker.inspect());
        // TODO Run code!
      }
    });
    marker.onDidDestroy(() => {
      onBufferChange.dispose();
    });
  }

  async ensureKernel(...args) {
    const kernel = await this._safeEnsureKernel(...args);
    // Cheap approximation to onDidStartKernel, which hydrogen doesn't provide [TODO Add + PR]
    this.lastKernel = kernel;
    return kernel;
  }

  async _safeEnsureKernel(...args) {
    return this.mutexAsync('_unsafeEnsureKernel', ...args);
  }

  // Not concurrency safe
  async _unsafeEnsureKernel() {
    const { grammar, filePath, kernel } = hydrogen.store;
    if (!grammar) {
      throw 'No grammar';
    } else if (!filePath) {
      throw 'No filePath';
    } else if (kernel) {
      return kernel;
    } else {
      // Pick sane default kernel to start, and let user switch if we're wrong
      let kernelSpec = await this._defaultKernelSpec(new File(filePath), grammar);
      console.info(`ensureKernel: Using kernelSpec[${kernelSpec && kernelSpec.display_name}]`);
      if (!kernelSpec) {
        atom.notifications.addWarning(
          `No kernels for grammar ${grammar.name}`,
          {icon: 'circle-slash'},
        );
        return null;
      } else if (kernelSpec.display_name === 'node.js') {
        return new AtomJsKernel();
      } else {
        const kernel = await new Promise((resolve, reject) => {
          // WARNING: If you call this multiple times concurrently then only the first will fire
          hydrogen.kernelManager.startKernel(
            kernelSpec,
            grammar,
            this.editor,
            filePath,
            kernel => resolve(kernel),
          );
        });
        return kernel;
      }
    }
  }

  async defaultKernelSpec() {
    const file = this.editor.buffer.file;
    const grammar = this.editor.getGrammar();
    return await this._defaultKernelSpec(file, grammar);
  }

  async _defaultKernelSpec(file, grammar) {
    const kernelSpecs = await hydrogen.kernelManager.getAllKernelSpecsForGrammar(grammar);
    const kernelSpecsByName = _.reduce(
      kernelSpecs,
      (acc, k) => { acc[k.display_name] = k; return acc; },
      {}
    );
    const kernelNamesToTry = _.concat(
      // The last kernel name the user chose
      ((this.lastKernel || {}).kernelSpec || {}).display_name,
      // Project dirs containing file
      atom.project.getDirectories().filter(d => d.contains(file.path)).map(d => d.getBaseName()),
      // Parent dirs containing file
      getPathComponents(file.getParent().path).reverse()
    );
    const kernelName = _.find(kernelNamesToTry, x => x in kernelSpecsByName)
    return (
      kernelName ? kernelSpecsByName[kernelName] :
      kernelSpecs.length > 0 ? kernelSpecs[0] :
      null
    );
  }

  syncViewFromIpynb(viewEditor, ipynbEditor) {
    console.debug('syncViewFromIpynb', viewEditor, ipynbEditor)
    try {

      const saved = {
        cursorBufferPosition: viewEditor.getCursorBufferPosition(),
        scrollTop: viewEditor.getScrollTop(),
      }

      const ipynbText = ipynbEditor.buffer.getText()
      const ipynbData = JSON.parse(ipynbEditor.getText())
      viewEditor.setText('')

      viewEditor.insertText('%%config\n')
      viewEditor.insertText(JSON.stringify(ipynbData.metadata || null, null, '  '))

      ipynbData.cells.forEach(cell => {
        console.debug('syncViewFromIpynb: cell', cell)

        const code = joinIfArray(cell.source)
        console.debug('syncViewFromIpynb: code\n', code)
        viewEditor.insertText('\n\n')
        if (code.trimLeft().startsWith('%%')) {
          // noop
        } else if (cell.cell_type === 'markdown') {
          viewEditor.insertText('%%md\n\n')
        } else {
          viewEditor.insertText('%%\n\n')
        }

        // TODO Why is (+'\n') necessary to avoid sometimes clipping the end of code?
        //  - We'll want to include a blankline for run-code-cell anyway, so revist after that
        viewEditor.insertText(code.trim() + '\n', {select: true})
        const [selection] = viewEditor.getSelections()
        const range = selection.getBufferRange()
        selection.clear()
        const resultReceiver = new NotebookHydrogenResultReceiver(
          {},
          module.getNotebookForTextEditor(viewEditor),
          viewEditor,
          range,
        )
        if (cell.outputs) {
          cell.outputs.forEach(output => {
            resultReceiver.onKernelResult(output)
          })
        }
        resultReceiver.onKernelResult({stream: 'status', data: 'ok'})

      })

      // TODO Still a little janky
      viewEditor.setCursorBufferPosition(saved.cursorBufferPosition)
      viewEditor.setScrollTop(saved.scrollTop)

    } catch (e) {
      atom.notifications.addError('Failed to sync from .ipynb', {dismissable: true})
      throw e
    }
  }

  syncViewToIpynb(viewEditor, ipynbEditor) {
    console.debug('syncViewToIpynb', viewEditor, ipynbEditor)
    try {

      // TODO
      //  - Cell outputs come straight from $('.raw-results')[].dataset.result

      // Docs: https://nbformat.readthedocs.io/en/latest/format_description.html
      const ipynb = {}

      const cellSepRows = []
      cellSepRows.push(viewEditor.buffer.getFirstPosition().row)
      viewEditor.scan(/^%%.*$/g, {}, ({range}) => cellSepRows.push(range.start.row))
      cellSepRows.push(viewEditor.buffer.getEndPosition().row + 1)
      const cellTexts = _.zip(cellSepRows, cellSepRows.slice(1)).filter(([startRow, endRow]) => {
        // _.zip goes the longer of the two lists and fills with undefined
        return startRow !== undefined && endRow !== undefined
      }).map(([startRow, endRow]) => {
        return {
          cellText: viewEditor.buffer.getTextInRange({
            start: {column: 0, row: startRow},
            end: {column: 0, row: endRow},
          }),
          startRow,
          endRow,
        }
      })
      if (!cellTexts[0].cellText.trim()) {
        // Allow first cell to omit leading %% by always including and dropping if empty
        cellTexts.shift()
      }

      let config = null
      ipynb.cells = []
      cellTexts.forEach(({cellText, startRow, endRow}) => {
        if (!cellText.startsWith('%%')) cellText = `%%\n\n${cellText}`
        let [_matched, magic, source] = cellText.match(/%%(.*)\n((?:.|\n)*)/)
        if (magic === 'md') magic = 'markdown'
        if (magic === 'config') {
          config = yaml.load(source.replace(/.*\n/, ''))
        } else {
          source = source.split('\n').map(x => x + '\n') // Like jupyter
          const cell_type = ['markdown', 'raw'].includes(magic) ? magic : 'code'
          if (cell_type === 'code' && magic) {
            source.unshift(`%%${magic}\n`, '\n')
          }
          const decorationMap = viewEditor.decorationsForScreenRowRange(startRow, endRow) // TODO Off by 1?
          const decoration = _.last(_.flatten(Object.values(decorationMap)).filter(x => x._item))
          let outputs = []
          if (decoration) {
            outputs = Array.from(decoration._item.querySelectorAll('.notebook-raw-result')).map(elem => {
              return JSON.parse(elem.dataset.result)
            })
          }

          // TODO Good start! -- keep iterating until jupyter can read it

          ipynb.cells.push({
            cell_type,
            execution_count: null, // TODO int
            metadata: {}, // TODO
            source,
            outputs,
          })
        }
      })

      // TODO Read out of config and/or current hydrogen kernel
      //  - hydrogen.store.kernelMapping.get((editor.buffer.file || {}).path).kernelSpec
      ipynb.nbformat = 4
      ipynb.nbformat_minor = 2
      ipynb.metadata = {
        kernelspec: {
          name: 'python',
          display_name: 'python',
          language: 'python',
        },
        language_info: {
          name: 'python',
          version: '3.6.2',
        },
      }

      const saved = {
        cursorBufferPosition: ipynbEditor.getCursorBufferPosition(),
        scrollTop: ipynbEditor.getScrollTop(),
      }

      ipynbEditor.setText(JSON.stringify(ipynb, null, '  '))

      // TODO Still a little janky
      ipynbEditor.setCursorBufferPosition(saved.cursorBufferPosition)
      ipynbEditor.setScrollTop(saved.scrollTop)

    } catch (e) {
      atom.notifications.addError('Failed to sync to .ipynb', {dismissable: true})
      throw e
    }
  }

  // Wrap an async function in a mutex
  //  - Class method because it's stateful (this[k])
  //  - TODO Refactor to be a top-level function that can be used on functions and methods
  async mutexAsync(asyncFunAttrName, ...args) {
    const f = asyncFunAttrName;
    const k = `_mutex_${f}`;
    if (!this[k]) {
      this[k] = this[f](...args).then(
        x => { this[k] = undefined; return x; },
        e => { this[k] = undefined; throw e; },
      );
    }
    return this[k];
  }

}

class NotebookHydrogenResultReceiver {

  // TODO How to leave visual mode after enter? Can't clipboard since we need to have a range
  // TODO How to restore decorations after delete/undo, cut/paste?
  // TODO Reuse ipython display? (plots, dfs)

  constructor(options, notebook, editor, range, code) {

    this.options = options;
    this.notebook = notebook;
    this.editor = editor;
    this.range = range;
    this.code = code;

    const outer = this;
    this.promise = new Promise((resolve, reject) => {
      outer._resolve = resolve;
      outer._reject = reject;
    });

    notebook.pendingResultReceivers.add(this);
    this.promise.finally(() => {
      notebook.pendingResultReceivers.delete(this);
    });
    this.promise.catch(e => {
      Array.from(notebook.pendingResultReceivers).forEach(that => {
        that.cancel();
      });
      throw e;
    });

    this.codePrefix = code.slice(0, 20).replace('\n', '\\n');
    if (code.length > this.codePrefix.length) this.codePrefix += '...';
    this.desc = `runCode[${this.codePrefix}]`; // For logging

    console.debug(`${this.desc}: constructor`, options, notebook, editor, range, code);

    this.hideOverlappingDecorations(range);
    notebook.deleteMarkersInTheWayOfNewResults(range);

    this.marker = notebook.markerLayer.markBufferRange(range, {
      class: 'notebook-marker',
      // Docs: https://atom.io/docs/api/v1.23.3/DisplayMarkerLayer#instance-markBufferRange
      exclusive: true, // Insertions at start/end boundaries should be outside the marker, not inside
      // invalidate: 'never', // Bad: decoration sticks around after you delete the code line/block
      invalidate: 'surround', // Just right
      // invalidate: 'overlap', // Too sensitive
      // invalidate: 'inside', // Too sensitive: decoration disappears if any inside code is edited
      // invalidate: 'touch', // Too sensitive
    });
    // Clean up marker on invalidate
    this.marker.onDidChange(ev => {
      if (!ev.isValid) {
        // this.marker.destroy();
      }
    });

    this.container = document.createElement('div');
    this.container.className = 'notebook-result-container';

    this.resultElem = document.createElement('div');
    this.resultElem.className = 'notebook-result pending';
    this.resultElem.hidden = true;
    this.container.append(this.resultElem);

    this.rawResultsContainer = document.createElement('div');
    this.rawResultsContainer.className = 'notebook-raw-results-container';
    this.container.append(this.rawResultsContainer);

    this.resultLastTextElem = null;
    this.dblclickElems = [];

    this.codeDecoration = editor.decorateMarker(this.marker, {
      type: 'highlight',
      class: 'notebook-code-highlight pending',
    });
    this.resultDecoration = editor.decorateMarker(this.marker, {
      type: 'block',
      position: 'after',
      item: this.container,
    });
    this.resultDecoration._item = this.container; // HACK Why isn't this retrievable?

    // Don't set output on init: if we're queued, let the running cell own the output position
    // this.updateOutputPosition();

    window.editor = editor // XXX dev
    window.range = range // XXX dev
    window.code = code // XXX dev
    window.markerLayer = notebook.markerLayer // XXX dev
    window.marker = this.marker; // XXX dev
    window.codeDecoration = this.codeDecoration; // XXX dev
    window.resultDecoration = this.resultDecoration; // XXX dev
    console.debug(`${this.desc}: marker`, this.marker); // XXX dev
    console.debug(`${this.desc}: codeDecoration`, this.codeDecoration); // XXX dev
    console.debug(`${this.desc}: resultDecoration`, this.resultDecoration); // XXX dev

  }

  hideOverlappingDecorations(range) {
    // TODO Is there a good way to do this more generally?
    //  - e.g. find and destroy all overlapping block decorations?
    // Hide autocomplete-plus suggestion list
    const {autocompleteManager} = atom.packages.getActivePackage('autocomplete-plus').mainModule
    autocompleteManager.hideSuggestionList()
  }

  updateOutputPosition() {
    if (this.marker.isValid()) { // Else you get some spurious jumps to Point(1, 1)
      // console.info(`updateOutputPosition: marker[${this.marker}]`); // XXX dev
      this.notebook.setLastOutputScreenPosition({
        // TODO How to properly track the bottom of pdb.set_trace() output?
        //  - It appears to always be just a few rows behind (and falls more behind with more output?)
        //  - Screen vs. buffer? I made the switch from buffer to screen but it still appears to lag
        // row: this.marker.getBufferRange().end.row + 1, // Buffer position
        row: this.marker.getScreenRange().end.row + 1, // Screen position
        column: 0,
      });
    }
  }

  onKernelResult(result) {
    console.debug(`${this.desc}: result\n`, result);

    this.rawResultElem = document.createElement('div');
    this.rawResultElem.className = 'notebook-raw-result';
    this.rawResultElem.dataset.result = JSON.stringify(result);
    this.rawResultsContainer.append(this.rawResultElem);

    // After this.rawResultElem.dataset.result = ...
    this.constructor.normalizeKernelResult(result);

    window.container = this.container; // XXX dev
    window.resultElem = this.resultElem; // XXX dev
    window.result = result; // XXX dev

    if (result.stream === 'execution_count') {
      // Ignored, e.g. `Out[${result.data}]`
      this.updateOutputPosition();
    } else if (result.output_type === 'stream') {
      this.resultAppendText(result.text, { stream: result.name });
      this.updateOutputPosition();
    } else if (['execute_result', 'display_data'].includes(result.output_type)) {
      this.onKernelResultData(result.data);
      this.updateOutputPosition();
    } else if (result.output_type === 'error') {
      this.resultAppendText(
        this.constructor.formatKernelResultTraceback(result.traceback),
        { stream: 'stderr' },
      );
      // this.resultLastTextElem.classList.add('stderr');
      this.updateOutputPosition();
    } else if (result.stream === 'status') {
      this.resultStatus(result.data);
      this.updateOutputPosition();
    } else {
      console.error(`${this.desc}: Unexpected result\n`, result);
    }
  }

  onKernelResultData(data) {
    this.resultEnsureNewline();
    if (result.data['text/html'] && !notebook._config.skipHtml) {
      this.resultAppendElementsFromHtml(result.data['text/html'], {
        // TODO Fix text/plain formatting for big (wide? long?) pandas df's (compare to text/html)
        textForClipboardCopy: result.data['text/plain']
      });
    } else if (result.data['image/svg+xml']) {
      this.resultAppendSvgFromXml(result.data['image/svg+xml']);
    } else if (result.data['image/png']) {
      this.resultAppendImgFromSrc(`data:image/png;base64,${result.data['image/png']}`);
    } else if (result.data['image/jpeg']) {
      this.resultAppendImgFromSrc(`data:image/jpeg;base64,${result.data['image/jpeg']}`);
    } else if (result.data['application/javascript']) { // For bokeh
      // Bypass CSP so that external resources can be loaded (e.g. js libs)
      //  - https://github.com/electron/electron/issues/3430
      //  - https://electronjs.org/docs/api/web-frame
      //  - TODO How worrisome is this? The whole intention is to run code we've never seen, so...
      require('electron').webFrame.registerURLSchemeAsBypassingCSP('https');
      // Appending <script> doesn't eval the js, don't know why. Just eval the js instead.
      // this.resultAppendElementsFromHtml(`<script ...>`);
      eval(result.data['application/javascript']);
    } else {
      let text = result.data['text/plain'] || '';
      text = text.toString(); // In case of non-strings, like from ijskernel
      this.resultAppendText(text);
    }
  }

  static normalizeKernelResult(result) {
    // result.data[k] : string | list[string] -> string
    if (result.data) {
      Object.keys(result.data).forEach(k => {
        result.data[k] = joinIfArray(result.data[k]);
      });
    }
    // result.text : string | list[string] -> string
    if (result.text) {
      result.text = joinIfArray(result.text);
    }
  }

  static formatKernelResultTraceback(resultTraceback) {
    return resultTraceback.map(line => {
      if (!line.endsWith('\n')) line += '\n'; // (e.g. ipykernel does, ijskernel doesn't)
      return stripAnsi(line);
    }).join('');
  }

  cancel() {
    if (!this.cancelled) {
      this.cancelled = true;
      this.resultAppendText('[cancelled]', { stream: 'stderr' });
      this.resultStatus('cancelled');
    }
  }

  resultStatus(status) {
    if (status === 'ok') {
      if (this.options.inpane) this.openElemsInPanes();
      this.resultElem.classList.remove('pending');
      this.resultElem.classList.add('ok');
      this.codeDecoration.destroy();
      if (this.resultElem.hidden) this.marker.destroy();
      this._resolve();
    } else if (status === 'error') {
      if (this.options.inpane) this.openElemsInPanes();
      this.resultElem.classList.remove('pending');
      this.resultElem.classList.add('error');
      this.codeDecoration.destroy();
      this._reject('status: error');
    } else if (status === 'cancelled') {
      if (this.options.inpane) this.openElemsInPanes();
      this.resultElem.classList.remove('pending');
      this.resultElem.classList.add('error');
      this.codeDecoration.destroy();
      this._reject('status: cancelled');
    } else {
      const msg = `Unexpected result.data[${status}] when result.stream[status]`;
      console.error(`${this.desc}: ${msg}`);
      this._reject(msg);
    }
  }

  resultEnsureNewline() {
    if (this.resultLastTextElem && !this.resultLastTextElem.textContent.endsWith('\n')) {
      this.resultAppendText('\n');
    }
  }

  resultAppendText(text, opts = {}) {
    if (text) {
      const stream = opts.stream || 'stdout';
      const streamClass = `stream-${stream}`;
      if (
        !this.resultLastTextElem ||
        !this.resultLastTextElem.classList.contains(streamClass)
      ) {
        const textElem = document.createElement('div');
        // console.debug('resultAppendText: new textElem', textElem); // XXX dev
        textElem.classList.add('notebook-result-text');
        textElem.classList.add(streamClass);
        textElem.onclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
            // cmd-click -> copy
            clipboard.writeText(textElem.textContent);
            atom.notifications.addSuccess('Copied to clipboard (text)');
          }
        };
        textElem.ondblclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
            // dblclick -> open in new tab
            this.resultOpenInPane({
              data: textElem.textContent,
              suffix: '.txt',
            });
          }
        };
        this.dblclickElems.push(textElem);
        this.resultAppend(textElem);
        this.resultLastTextElem = textElem;
      }
      text = stripAnsi(text); // TODO Map ansi colors to css (https://github.com/chalk/chalk)
      // Append text to resultLastTextElem, interpreting CR chars (\r) along the way
      //  - Approach: for each CR char, delete back to last LF char (\n)
      const [preCRText, ...postCRTexts] = text.split('\r');
      this.resultLastTextElem.append(document.createTextNode(preCRText));
      postCRTexts.forEach(postCRText => {
        let lastLF = this.resultLastTextElem.textContent.lastIndexOf('\n');
        lastLF += 1; // Delete to char after LF, else delete to 0 if no LF found (-1)
        this.resultLastTextElem.textContent = this.resultLastTextElem.textContent.slice(0, lastLF);
        this.resultLastTextElem.append(document.createTextNode(postCRText));
      });
    }
  }

  resultAppendElementsFromHtml(html, {textForClipboardCopy}) {
    const elems = elementsFromHtml(html);
    this.resultAppend(...elems);
    if (textForClipboardCopy) {
      elems.forEach((elem) => {
        elem.onclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
            // cmd-click -> copy
            clipboard.writeText(textForClipboardCopy);
            atom.notifications.addSuccess('Copied to clipboard (text for html)');
          }
        };
        elem.ondblclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
            // dblclick -> open in new tab
            this.resultOpenInPane({
              data: textForClipboardCopy,
              suffix: '.txt',
            });
          }
        };
        this.dblclickElems.push(elem);
      });
    }
  }

  resultAppendSvgFromXml(svgXml) {
    const elements = elementsFromHtml(svgXml);
    const parent = this.resultAppend(...elements);
    Array.from(parent.getElementsByTagName('svg')).forEach((svg) => {
      svg.onclick = (ev) => {
        if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
          // cmd-click -> copy
          svgToPngDataUrl(svg).then((pngDataUrl) => {
            clipboardCopyImageFromDataURL(pngDataUrl);
            atom.notifications.addSuccess('Copied to clipboard (png from svg)');
          });
        }
      };
      svg.ondblclick = (ev) => {
        if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
          // dblclick -> open in new tab
          this.resultOpenInPane({
            data: svg.outerHTML,
            suffix: '.svg',
          });
        }
      };
      this.dblclickElems.push(svg);
    });
  }

  resultAppendImgFromSrc(src) {
    const img = document.createElement('img');
    img.src = src;
    img.onclick = (ev) => {
      if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
        // cmd-click -> copy
        clipboardCopyImg(img);
        atom.notifications.addSuccess('Copied to clipboard (image)');
      }
    };
    img.ondblclick = (ev) => {
      if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        // dblclick -> open in new tab
        if (!src.startsWith('data:image/png;')) {
          // TODO Map src data url to NativeImage.to* + file suffix
          throw `Expected 'data:image/png', got src[${src.slice(0, 50)}...]`;
        }
        this.resultOpenInPane({
          data: nativeImage.createFromDataURL(img.src).toPng(),
          suffix: '.png',
        });
      }
    };
    this.dblclickElems.push(img);
    this.resultAppend(img);
  }

  resultAppend(...elements) {
    if (!this.options.inpane) this.resultElem.hidden = false;
    this.resultElem.append(...elements);
    this.resultLastTextElem = null;
    this.editor.scrollToCursorPosition();
    return this.resultElem;
  }

  async resultOpenInPane({data, prefix, suffix}) {
    prefix = prefix || this.codePrefix;
    prefix = `${prefix}-`.replace(/\W+/g, '-').replace(/^-/, '');
    const tmpPath = mktemp({prefix, suffix});
    fs.writeFileSync(tmpPath, data);
    await atom.workspace.open(tmpPath); // [TODO atom.workspace.openSync is broken]
    // TODO Abstract into function `openInAdjacentPane`
    // TODO Package these commands up so we can declare a package dependency on them
    // TODO XXX Based on my experience, trying to hit the pane the user wants is unreliable and
    // more frequently results in annoying UX than helpful UX. Let's kill this entirely? Or maybe
    // make it an opt-in?
    // atom.commands.dispatch(atom.workspace.element, 'user:window-move-active-item-to-pane-on-right');
    // atom.commands.dispatch(atom.workspace.element, 'user:window-focus-pane-on-left');
  }

  // e.g. for runCode*({inpane: true})
  async openElemsInPanes() {
    for (const elem of this.dblclickElems) {
      await elem.dispatchEvent(new MouseEvent('dblclick'));
      break;
    }
  }

}

// TODO Autocomplete? Limited use without this...
// TODO New context per editor
//  - Else `const x = 3` fails if you ever run it twice
//  - Pass in globals to each new context
//  - https://nodejs.org/api/vm.html
// TODO No way to kill AtomJsKernel since it's not hydrogen
//  - Have to restart the atom window!
// TODO Any way to format like chrome dev console?
//  - Workaround: automatically log in dev console
class AtomJsKernel {
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

//
// Old markdown thing
//

// TODO Get this outta here
const notebookMarkdownImages = {

  _config: {
    scopes: ['text.md'],
  },

  disposables: null,
  markerLayers: new Map(), // TextEditor -> DisplayMarkerLayer

  activate() {
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      atom.workspace.observeTextEditors(editor => {
        if (!this.markerLayers.has(editor)) {
          const markerLayer = editor.addMarkerLayer({maintainHistory: true, persistent: true});
          // warnIfTextEditorIdsAreNotUnique(); // XXX if the switch from editor.id -> editor worked...
          this.markerLayers.set(editor, markerLayer);
          this.disposables.add(
            editor.onDidDestroy(() => this.markerLayers.delete(editor))
          );
          if (this._config.scopes.includes(editor.getGrammar().scopeName)) {
            this.disposables.add(
              editor.onDidStopChanging(() => this.refreshEditor(editor))
            );
            this.refreshEditor(editor);
          }
        }
      })
    );
  },

  deactivate() {
    this.disposables.dispose();
  },

  refreshEditor(editor) {

    // Decorate markdown images: ![...](url)
    editor.scan(/!\[[^\]\n]*\]\(([^)\n]+)\)/g, mdImage => {
      const mdImageUrl = mdImage.match[1]

      // If not already decorated
      const decorations = editor.findMarkers({
        class: `${packageName}-image`,
        containsBufferPosition: mdImage.range.start,
      })
      if (decorations.length === 0) {

        // Make marker + decoration
        const marker = editor.markBufferRange(mdImage.range, {
          class: `${packageName}-image`,
          invalidate: 'inside',
        })
        editor.decorateMarker(marker, {
          type: 'block',
          position: 'after',
          item: this.imageDecoration(
            this.ensureUrlIsAbsolute(mdImageUrl, path.dirname((editor.buffer.file || {}).path)),
          ),
        })

        // Clean up marker on invalidate
        marker.onDidChange(ev => {
          if (!ev.isValid) {
            marker.destroy()
          }
        })

      }
    })
  },

  imageDecoration(imageUrl) {
    const div = document.createElement('div')
    div.className = 'notebook-result-container'
    const img = document.createElement('img')
    img.className = 'notebook-result'
    img.src = imageUrl
    div.append(img)
    return div
  },

  ensureUrlIsAbsolute(url, relativeToDir) {
    if (/^[a-zA-Z][-a-zA-Z0-9+.]*:/.test(path)) {
      return url
    } else {
      return path.resolve(relativeToDir, url) // Noop if url is absolute path
    }
  },

}

//
// XXX Danger
//

/*

// Import atom internal modules
const ScopeDescriptor = require(`${atom.packages.resourcePath}/src/scope-descriptor`)
const TokenizedBuffer = require(`${atom.packages.resourcePath}/src/tokenized-buffer`)

// TODO XXX FIXME FUCK FUCK FUCK THIS IS HORRIBLE AND A WASTE OF TIME
//  - I just burned 4h trying to make this stupid bullshit work
//  - Current state:
//    - [x] Opens *.ipynb paths as NotebookTextEditor
//    - [ ] Reopens NotebookTextEditor panes on shift-cmd-r
//    - [ ] NotebookTextEditor view is usable
//      - Can't scroll, no status-bar. Wat.
//  - I'm probably missing something really basic here...
class NotebookTextEditor extends TextEditor {

  // TODO Call this to make it all go
  static addOpeners() {
    atom.workspace.addOpener((uri) => NotebookTextEditor.opener(uri))
  }

  // .ipynb -> NotebookTextEditor
  //  - Idea 1, which was really difficult and burned multiple hours:
  //    - .ipynb -> NotebookTextEditor
  //    - ipynb-raw://.ipynb -> TextEditor
  //  - Idea 2, which avoided some of that nonsense:
  //    - atom-notebook://.ipynb -> NotebookTextEditor
  //    - .ipynb -> TextEditor + open(`atom-notebook://${uri}`)
  //    - Nope, also difficult: NotebookTextEditor still reports its uri as the file path, which
  //      means it's recognized as having open /foo/bar and not atom-notebook:///foo/bar
  //  - Idea 3
  //    - .ipynb -> NotebookTextEditor
  //    - Add some switch internal to NotebookTextEditor that toggles the view between its two
  //      TextBuffer's
  static opener(uri) {
    const ext = path.extname(uri).toLowerCase()
    if (ext === '.ipynb') {
      return NotebookTextEditor.openSync(uri)
    }
  }

  static openSync(source, bufferParams = {}, editorParams = {}) {
    const buffer = TextBuffer.loadSync(source, bufferParams)
    return NotebookTextEditor.build({
      ...editorParams,
      buffer,
    })
  }

  // Copied from https://github.com/atom/atom/blob/1.22-releases/src/text-editor-registry.js#L112
  static build(params) {
    const self = atom.textEditors // TextEditorRegistry
    const GRAMMAR_SELECTION_RANGE = Range(Point.ZERO, Point(10, 0)).freeze()
    params = Object.assign({assert: self.assert}, params)
    let scope = null
    if (params.buffer) {
      const filePath = params.buffer.getPath()
      const headContent = params.buffer.getTextInRange(GRAMMAR_SELECTION_RANGE)
      params.grammar = self.grammarRegistry.selectGrammar(filePath, headContent)
      scope = new ScopeDescriptor({scopes: [params.grammar.scopeName]})
    }
    Object.assign(params, self.textEditorParamsForScope(scope))
    // [Edit: TextEditor -> NotebookTextEditor]
    return new NotebookTextEditor(params)
  }

  constructor(params = {}) {
    super(params)
    console.debug('NotebookTextEditor.constructor', this)
  }

  serialize() {
    return {
      ...super.serialize(),
      deserializer: 'NotebookTextEditor',
    }
  }

  // Copied from https://github.com/atom/atom/blob/1.22-releases/src/text-editor.coffee#L126
  deserialize(state, atomEnvironment) {
    try {
      tokenizedBuffer = TokenizedBuffer.deserialize(state.tokenizedBuffer, atomEnvironment)
      if (!tokenizedBuffer) return null
      state.tokenizedBuffer = tokenizedBuffer
      state.tabLength = state.tokenizedBuffer.getTabLength()
    } catch (error) {
      if (error.syscall === 'read') {
        return // Error reading the file, don't deserialize an editor for it
      } else {
        throw error
      }
    }
    state.buffer = state.tokenizedBuffer.buffer
    state.assert = atomEnvironment.assert.bind(atomEnvironment)
    const editor = new NotebookTextEditor(state)
    if (state.registered) {
      const disposable = atomEnvironment.textEditors.add(editor)
      editor.onDidDestroy(() => disposable.dispose())
    }
    return editor
  }

}
atom.deserializers.add(NotebookTextEditor)
window.NotebookTextEditor = NotebookTextEditor // XXX dev

*/
