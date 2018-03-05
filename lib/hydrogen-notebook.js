'use babel';

import path from 'path';
import {File, Point, Range} from 'atom';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
  utils: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/utils`),
  HydrogenProvider: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/plugin-api/hydrogen-provider`),
};

const {AtomJsKernel} = require('./atom-js-kernel');
const {
  codeChunkDelimsInDirection,
  codeChunksForSelection,
} = require('./cells');
const {IpynbSync} = require('./ipynb');
const {KernelResultsReceiver} = require('./kernel-results-receiver');
const {
  getPathComponents,
  ifPackageActive,
  newTermWithCommand,
  onPackageByName,
  warnIfTextEditorIdsAreNotUnique,
} = require('./util');

window.hydrogen = hydrogen; // XXX dev

//
// HydrogenNotebooks
//

export class HydrogenNotebooks {

  constructor(config) {
    this.config = config;
    this.notebooks = new Map(); // TextEditor -> HydrogenNotebook
    this.seenKernels = new Set(); // Kernel
  }

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
          const notebook = new HydrogenNotebook(this, editor);
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
    if (this.config.unsetPYTHONSTARTUP) {
      this.setPYTHONSTARTUP({unset: true, quiet: true});
    }
  }

  deactivate() {
    this.shutdownSeenKernels();
    this.setPYTHONSTARTUP({restore: true, quiet: true});
    this.disposables.dispose();
    if (this.moreVmp) this.moreVmp.disposables.dispose();
    Array.from(this.notebooks.values()).forEach(notebook => notebook.destroy());
    // Leave kernels running, since they're owned by Hydrogen and not us
    //  - TODO Does Hydrogen properly clean up kernels on deactive/exit? PR if not
  }

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
  }

  shutdownSeenKernels() {
    console.info(`Shutting down seen kernels: ${this.seenKernels.size} kernel(s)`);
    this.seenKernels.forEach(kernel => this.shutdownKernel(kernel));
  }

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
  }

  addCommands() {
    this.disposables.add(
      atom.commands.add('atom-workspace', {
        'hydrogen-extras:toggle-track-output': ev => this.getActiveNotebook().toggleTrackOutput(),
        'hydrogen-extras:toggle-pythonstartup': ev => this.setPYTHONSTARTUP({toggle: true}),
        'hydrogen-extras:toggle-highlight-cells': ev => this.getActiveNotebook().toggleHighlightCells(),
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
  }

  getActiveNotebook() {
    return this.getNotebookForTextEditor(atom.workspace.getActiveTextEditor());
  }

  ifActiveNotebook(f) {
    const notebook = this.getActiveNotebook();
    if (notebook) {
      return f(notebook);
    }
  }

  getNotebookForTextEditor(editor) {
    return this.notebooks.get(editor);
  }

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
  }

  async toggleKernelMonitor() {
    const pane = atom.workspace.getActivePane();
    await atom.workspace.toggle(hydrogen.utils.KERNEL_MONITOR_URI);
    pane.focus();
  }

}

//
// HydrogenNotebook
//

export class HydrogenNotebook {

  constructor(notebooks, editor) {
    console.debug('HydrogenNotebook.constructor', editor);

    this.notebooks = notebooks;
    this.editor = editor;
    this.trackOutput = this.notebooks.config.trackOutput;
    this.highlightCells = this.notebooks.config.highlightCells;
    this.disposables = new CompositeDisposable();
    this.kernel = null;
    this.cellMarkers = null;
    this.pendingResultsReceivers = new Set();

    // Do maintain history and persistence for output marker/decorations
    //  - Undo so that outputs come back immediately on undo, instead of having to rerun them
    //  - Persistent so that outputs come back on window reload [TODO make this actually work]
    this.markerLayer = this.editor.addMarkerLayer({maintainHistory: true, persistent: true});
    // Don't maintain history (or persistence) for cellMarkerLayer:
    //  - Else we don't see marker.onDidChange on undo, since the markerLayer handles it for us
    //  - This seems helpful, but it actually makes our life harder since it would require us to
    //    compute incremental deltas in cell/marker state instead of recomputing them for the whole
    //    buffer on any change, because that's the only way to behave compatibly with what the
    //    markerLayer is doing
    //  - Don't bother with persistent since it's simple and cheap to reparse cell markers on load
    this.cellMarkerLayer = this.editor.addMarkerLayer({maintainHistory: false, persistent: false});

    this.updateCellDecorations();
    this.disposables.add(
      this.editor.buffer.onDidStopChanging(({changes}) => {
        this.updateCellDecorations();
      }),
    );
    // This maintains decorations on all markers in the markerLayer (cool!)
    //  - Works on future markers that are added, too
    const cellMarkerDiv = document.createElement('div');
    cellMarkerDiv.className = 'cell-marker-div';
    this.editor.decorateMarkerLayer(this.cellMarkerLayer, {
      class: 'notebook-code-highlight cell-delim',
      type: 'highlight',
      // type: 'block', position: 'after', item: cellMarkerDiv,
    });

    this.ipynbSync = new IpynbSync(this)
  }

  destroy() {
    this.markerLayer.destroy();
    this.cellMarkerLayer.destroy();
    this.ipynbSync.destroy();
    this.updateKernel(null); // Shutdown kernel
    this.disposables.dispose();
  }

  // Maintain markers and decorations on all cells (avoid making editing really slow)
  //  - Delims only, make refresh cheap
  //  - My first attempt was to mark cells and trigger on marker invalidation, but that turned out
  //    to be waaaay slower (~10x) and way more complicated than buffer.onDidStopChanging with a
  //    cheap scan of the cell delims. Code here, for reference:
  //    - https://gist.github.com/jdanbrown/8a0ea5c368b4de32daae11711ab209fc
  updateCellDecorations() {
    if (!this.highlightCells) {
      // Destroy markers, if any
      (this.cellMarkers || []).forEach(marker => marker.destroy());
      this.cellMarkers = null;
    } else {
      // Parse cells from entire buffer
      const delims = codeChunkDelimsInDirection('cell', this.editor, 'next', [0, 0]);
      // Save previous markers
      const prevMarkers = this.cellMarkers;
      // Mark and decorate each cell
      this.cellMarkers = delims.map(delim => {

        // TODO TODO Clean up (+ styles/notebook.less)
        delim = this.trimCodeRange(this.editor.buffer, delim);
        delim = Range(delim.start.translate([-1,0], [0,0]), delim.start.translate([0,0],[0,0])); // + background (/ border-bottom)
        // delim = Range(delim.start.translate([0,0], [0,0]), delim.start.translate([1,0],[0,0])); // (+ border-top)

        return this.cellMarkerLayer.markBufferRange(delim, {
          class: 'notebook-cell-delim',
          invalidate: 'never', // We'll destroy manually
        });
      });
      // Destroy previous markers
      (prevMarkers || []).forEach(marker => marker.destroy());
    }
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
      this.notebooks.shutdownKernel(kernel);
      this.deleteAllResults();
    }
  }

  toggleTrackOutput() {
    this.trackOutput = !this.trackOutput;
    atom.notifications.addInfo(`Track output: ${this.trackOutput}`);
  }

  toggleHighlightCells() {
    this.highlightCells = !this.highlightCells;
    this.updateCellDecorations();
    atom.notifications.addInfo(`Highlight cells: ${this.highlightCells}`);
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
    if (this.notebooks.vmp) {
      this.notebooks.vmp.getEditorState(this.editor).mark.set('h', this.lastOutputScreenPosition);
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
          KernelResultsReceiver.normalizeKernelResult(result);
          if (result.output_type === 'stream' && result.name === 'stdout') {
            output += result.text;
          } else if (result.output_type === 'error') {
            reject(KernelResultsReceiver.formatKernelResultTraceback(result.traceback));
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
    const resultsReceiver = new KernelResultsReceiver(
      options, this, this.editor, range, code,
    );
    // console.info(`XXX this.ensureKernel: code[${code}]`);
    const kernel = await this.ensureKernel();
    // console.info(`XXX this.ensureKernel: code[${code}], kernel[${kernel}]`);
    if (kernel) {
      // console.info(`XXX kernel.execute: code[${code}]`);
      // TODO Adapt kernel.execute into Promise [is this causing any problems currently?]
      kernel.execute(code, result => resultsReceiver.onKernelResult(result));
    } else {
      resultsReceiver.onKernelResult({
        stream: 'status',
        data: 'error',
      });
    }
    return await resultsReceiver.promise;
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
      // See comments in KernelResultsReceiver.constructor
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
      //  - Higher prio than modeline so that kill->restart doesn't jump kernels
      //  - In case this isn't what the user wants and they're confused about the spooky implicit
      //    state, they can close and reopen the editor pane to reset it
      ((this.lastKernel || {}).kernelSpec || {}).display_name,
      // A kernel=<display_name> setting in the modeline [https://atom.io/packages/vim-modeline]
      ifPackageActive('vim-modeline', vimModeline => {
        const modeline = vimModeline.detectVimModeLine(this.editor);
        return (modeline || {}).kernel;
      }),
      // Project dirs containing file
      atom.project.getDirectories().filter(d => d.contains(file.path)).map(d => d.getBaseName()),
      // Parent dirs containing file
      getPathComponents(file.getParent().path).reverse()
    );
    // console.debug('kernelNamesToTry', kernelNamesToTry); // XXX dev
    const kernelName = _.find(kernelNamesToTry, x => x in kernelSpecsByName)
    return (
      kernelName ? kernelSpecsByName[kernelName] :
      kernelSpecs.length > 0 ? kernelSpecs[0] :
      null
    );
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
