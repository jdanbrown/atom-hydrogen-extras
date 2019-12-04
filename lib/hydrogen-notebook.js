'use babel';

import assert from 'assert';
import {exec} from 'child_process';
import path from 'path';
import {Emitter, File, Point, Range} from 'atom';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const fs = require(`${atom.packages.resolvePackagePath('vim-mode-plus')}/node_modules/fs-plus`);
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
  utils: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/utils`),
  HydrogenProvider: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/plugin-api/hydrogen-provider`),
};
const {CompositeDisposable, Disposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const jupyterlabServices = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/@jupyterlab/services`);

const {AtomJsKernel} = require('./atom-js-kernel');
const {
  allCodeChunks,
  codeChunksForSelection,
  trimCodeRange,
} = require('./cells');
const {kernelForEditor} = require('./hydrogen-util');
const {IpynbSync} = require('./ipynb');
const {KernelResultsReceiver, closeAndUnzoomActiveItem} = require('./kernel-results-receiver');
const {
  getPathComponents,
  ifPackageActive,
  newTermWithCommand,
  onPackageByName,
  parseCellMagic,
  parseCellMetadata,
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
    this.seenKernels = new Set(); // of Kernel
  }

  activate() {
    // Force hydrogen to activate before we do
    if (!atom.packages.isPackageActive('Hydrogen')) {
      atom.packages.getLoadedPackage('Hydrogen').activateNow();
    }
    this.disposables = new CompositeDisposable();
    this.addCommands();
    this.observeTextEditors();
    this.observeKernels();
    this.disposables.add(
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
    this.detachSeenKernels();
    this.setPYTHONSTARTUP({restore: true, quiet: true});
    this.disposables.dispose();
    if (this.moreVmp) this.moreVmp.disposables.dispose();
    Array.from(this.notebooks.values()).forEach(notebook => notebook.destroy());
    // Leave kernels running, since they're owned by Hydrogen and not us
    //  - TODO Does Hydrogen properly clean up kernels on deactive/exit? PR if not
  }

  observeTextEditors() {
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
    );
  }

  observeKernels() {
    this.hydrogenProvider = new hydrogen.HydrogenProvider(hydrogen.main);
    this.disposables.add(
      hydrogen.main.emitter.on('did-change-kernel', kernel => {
        // console.debug('Kernel changed', kernel && kernel.displayName); // Dev
        window.kernel = kernel; // XXX dev
        this.ifActiveNotebook(notebook => notebook.checkForChangedKernel(kernel));
        if (kernel) {
          if (!this.seenKernels.has(kernel)) {
            this.seenKernels.add(kernel);
            // HACK Add PYTHONSTARTUP to displayName so it's loudly visibile (e.g. in status-bar)
            if (process.env.PYTHONSTARTUP) {
              // HACK Very brittle, e.g. `kernel.displayName = ...` used to work and then didn't
              // FIXME On atom hot reload, this repeatedly appends 'foo (PYTHONSTARTUP) (PYTHONSTARTUP) ...'
              kernel.transport.displayName = `${kernel.displayName} (PYTHONSTARTUP)`;
            }
            console.info('Kernel added:', kernel.displayName);
            atom.notifications.addInfo(`Started kernel: ${kernel.displayName}`);
            this.disposables.add(
              kernel.emitter.on('did-destroy', async () => {
                console.info('Kernel destroyed:', kernel.displayName);
                this.seenKernels.delete(kernel);

                // HACK Trigger GET /api/sessions to workaround annoying jupyter-kernel-gateway bug
                //  - https://github.com/jupyter/notebook/issues/2900
                //  - https://github.com/jupyter/notebook/issues/4209
                //    - This is the same error msg I see in the `jupyter kernelgateway` logs
                //  - https://github.com/jupyter/notebook/pull/4219
                //    - This appears to be the underlying cause (and fix)
                //  - TODO Why isn't this fixed by upgrading to: jupyter-kernel-gateway==2.4.0 notebook==6.0.1 ?
                const getSessionMaybe = middleware => (
                  middleware && (middleware.session || getSessionMaybe(middleware._next))
                );
                const session = getSessionMaybe(kernel.firstMiddlewareAdapter);
                if (session) { // Only defined for remote kernels
                  try {
                    await jupyterlabServices.Session.listRunning(session.serverSettings);
                  } catch (e) {
                    // Ignore error (should always throw b/c of backend bug linked above)
                  }
                  console.info('HACK Triggered GET /api/sessions to workaround annoying juypter-kernel-gateway bug');
                }

              }),
            );
          }
        }
      }),
    );
  }

  detachSeenKernels() {
    console.info(`Detaching from seen kernels: ${this.seenKernels.size} kernel(s)`);
    this.seenKernels.forEach(kernel => this.detachKernel(kernel));
  }

  detachKernel(kernel) {
    if (this.shutdownKernelOnDetach) {
      this.shutdownKernel(kernel);
    }
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
        'hydrogen-extras:toggle-ipynb-py-file': ev => this.getActiveNotebook().toggleIpynbPyFile(),
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
        // TODO Make these cmds easily configurable (e.g. adding extra options, adding extra cmds)
        'hydrogen-extras:new-term-with-htop': ev => newTermWithCommand('sudo htop -d10'),
        'hydrogen-extras:new-term-with-glances': ev => newTermWithCommand('glances -t1 -b -1 -4 --process-short-name --fs-free-space'),
      }),
      atom.commands.add('atom-text-editor', {
        'hydrogen-extras:interrupt-kernel': ev => this.getActiveNotebook().interruptKernel(),
        'hydrogen-extras:kill-kernel': ev => this.getActiveNotebook().killKernel(),
      }),
      atom.commands.add('.notebook--figure', {
        'hydrogen-extras:close-and-unzoom': ev => closeAndUnzoomActiveItem(),
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
    // console.debug('HydrogenNotebook.constructor', editor);

    this.notebooks = notebooks;
    this.config = notebooks.config;
    this.editor = editor;
    this.trackOutput = this.config.trackOutput;
    this.highlightCells = this.config.highlightCells;
    this.disposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.cellMarkers = null;
    this.pendingResultsReceivers = new Set();
    this.seenOutputMarkerIds = new Set(); // of DisplayMarker.id (string)

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
    this.disposables.add(new Disposable(() => {
      this.markerLayer.destroy();
      this.cellMarkerLayer.destroy();
    }));

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

    // If .ipynb, do the .py/.ipynb sync
    const editorPath = (this.editor.buffer.file || {}).path;
    if (editorPath && '.ipynb' === path.extname(editorPath).toLowerCase()) {
      this.ipynbSync = new IpynbSync(this);
      window.ipynbSync = this.ipynbSync; // XXX
      this.ipynbSync.start().then(x => {
        this.disposables.add(x);
      });
    }

  }

  destroy() {
    if (this.kernel) this.detachKernel();
    this.disposables.dispose();
  }

  get kernel() {
    return kernelForEditor(this.editor);
  }

  toggleIpynbPyFile() {
    if (this.editor.buffer._ipynbPyFile) {
      this.editor.buffer._ipynbPyFile.toggle();
    }
    if (this.ipynbSync) {
      this.ipynbSync.ipynbPyFile.toggle();
    }
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
      const chunks = allCodeChunks('cell', this.editor);
      // Save previous markers
      const prevMarkers = this.cellMarkers;
      // Mark and decorate each cell
      this.cellMarkers = chunks.filter(chunk => {
        // Don't put a delim at the top of the file
        return !chunk.start.isEqual(this.editor.buffer.getFirstPosition());
      }).map(chunk => {

        // TODO Clean up (+ styles/notebook.less)
        // chunk = trimCodeRange(this.editor.buffer, chunk); // XXX No longer needed with allCodeChunks
        const delim = Range(chunk.start.translate([-1,0], [0,0]), chunk.start.translate([0,0],[0,0])); // For background / border-bottom
        // const delim = Range(chunk.start.translate([0,0], [0,0]), chunk.start.translate([1,0],[0,0])); // For border-top

        return this.cellMarkerLayer.markBufferRange(delim, {
          class: 'notebook-cell-delim',
          invalidate: 'never', // We'll destroy manually
        });
      });
      // Destroy previous markers
      (prevMarkers || []).forEach(marker => marker.destroy());
    }
  }

  checkForChangedKernel() {
    const oldKernel = this._lastSeenKernel || null; // Avoid undefined vs. null confusion
    const newKernel = this.kernel || null; // Avoid undefined vs. null confusion
    if (newKernel !== oldKernel) {
      console.info(
        `Notebook[editor.id:${this.editor.id}] changed kernel: ` +
        `${oldKernel && oldKernel.displayName} -> ${newKernel && newKernel.displayName}`
      );
      if (oldKernel) {
        this.detachKernel(oldKernel);
        // this.deleteAllResults(); // Too disruptive
      }
    }
    // Invariant: this._lastSeenKernel == this.kernel after checkForChangedKernel
    this._lastSeenKernel = newKernel;
  }

  killKernel(kernel) {
    this.shutdownKernel(kernel);
    // this.deleteAllResults(); // Too disruptive
  }

  // hydrogen:interrupt-kernel + notification [TODO PR]
  //  - Duplicates: hydrogen.main.handleKernelCommand
  interruptKernel(kernel) {
    kernel = kernel || this.kernel;
    if (!kernel) {
      atom.notifications.addWarning('No kernel running');
    } else {
      atom.notifications.addInfo(`^C kernel: ${kernel.displayName}`);
      kernel.interrupt();
    }
  }

  detachKernel(kernel) {
    kernel = kernel || this.kernel;
    if (kernel) {
      this.notebooks.detachKernel(kernel);
    }
  }

  // hydrogen:shutdown-kernel + notification [TODO PR?]
  //  - Duplicates: hydrogen.main.handleKernelCommand
  shutdownKernel(kernel) {
    kernel = kernel || this.kernel;
    if (!kernel) {
      atom.notifications.addWarning('No kernel running');
    } else {
      atom.notifications.addInfo(`Shutting down kernel: ${kernel.displayName}`);
      this.notebooks.shutdownKernel(kernel);
    }
  }

  toggleTrackOutput() {
    this.trackOutput = !this.trackOutput;
    atom.notifications.addInfo(`Track output: ${this.trackOutput}`);
  }

  withTrackOutput(trackOutput, f) {
    const saved = this.trackOutput;
    this.trackOutput = trackOutput;
    try {
      return f();
    } finally {
      this.trackOutput = saved;
    }
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
    this.deleteMarkersByFinds([
      {}, // All markers
    ]);
  }

  deleteResultAtCursor() {
    this.deleteMarkersByFinds([
      {intersectsRow: this.editor.getCursorBufferPosition().row},
    ]);
  }

  deleteMarkersInTheWayOfNewResults(range) {
    this.deleteMarkersByFinds([
      {startsInRange: range},
      {endsInRange: range},
    ]);
  }

  deleteMarkersByFinds(propertiess) {
    propertiess.forEach(properties => {
      this.markerLayer.findMarkers(properties).forEach(marker => {
        marker.destroy();
      });
    });
    this.emitter.emit('did-update-outputs'); // (No longer used, but maybe still useful)
  }

  getResultMarkers(properties = {}) {
    return this.markerLayer.findMarkers({
      class: 'notebook-result-marker',
      ...properties,
    });
  }

  hasResults() {
    return !_.isEmpty(this.getResultMarkers());
  }

  async newTermWithJupyterForCurrentKernel() {
    const kernel = await this.ensureKernel();
    if (kernel) {
      // TODO Add node_modules so we can dedent for multiline quotes `...` [https://github.com/dmnd/dedent]

      // Get remote hostname, if kernel is remote
      //  - TODO How to let user specify an alternate username?
      //  - HACK Not a very robust approach (comparing hostnames), but good enough to start
      const localHostname = await new Promise((resolve, reject) => {
        exec('hostname', (err, stdout, stderr) => {
          assert(!err, stderr);
          resolve(stdout.trim());
        });
      });
      const remoteHostname = (await this.runCodeReturnOutput(
        'import subprocess; print(subprocess.check_output("hostname").strip())'
      )).trim();
      const maybeSsh = remoteHostname === localHostname ? '' : `ssh -t ${remoteHostname} -- `;
      console.debug(`newTermWithJupyterForCurrentKernel: local[${localHostname}] remote[${remoteHostname}]`);

      // Get env that kernel was run from
      //  - e.g. use venv/bin/jupyter i/o global jupyter
      const envBinDir = (await this.runCodeReturnOutput(
        'import sys, os.path; print(os.path.dirname(sys.executable))'
      )).trim();

      // Get connection file so we can connect to the running kernel
      const connectionFile = (await this.runCodeReturnOutput(
        'import ipykernel; print(ipykernel.get_connection_file().strip())'
      )).trim();

      // Launch new term pane with `jupyter console`
      //  - e.g. to debug, run a debugger pm() (e.g. `import pdb; pdb.pm()` for pdb/pdbpp, or `%debug` for ipdb)
      newTermWithCommand(`${maybeSsh}${envBinDir}/jupyter console --existing=${connectionFile}`);

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
    range = trimCodeRange(this.editor.buffer, range);
    let codeRaw = this.editor.buffer.getTextInRange(range).trimRight();

    // Always launch kernel
    const kernel = await this.ensureKernel();

    // Short-circuit if no code
    if (!codeRaw) return;

    const {metadata, body: code} = parseCellMetadata(codeRaw);

    // Short-circuit on custom cell magics (for .ipynb/.py sync)
    if (['md', 'markdown', 'raw', 'metadata', 'unknown'].includes(parseCellMagic(code).magic)) {
      return;
    }

    if (metadata.once) {
      const outputsInRange = this.getResultMarkers({
        intersectsBufferRange: range,
        owner: 'runCode', // Distinguish our outputs vs. e.g. IpynbSync loads [TODO Not yet used, but seems useful...]
      });
      console.debug('outputsInRange', outputsInRange.map(x => x.id)); // XXX TODO TODO
      const seenOutputsInRange = outputsInRange.filter(marker => this.seenOutputMarkerIds.has(marker.id));
      console.debug('this.seenOutputMarkerIds', Array.from(this.seenOutputMarkerIds)); // XXX TODO TODO
      console.debug('seenOutputsInRange', seenOutputsInRange.map(x => x.id)); // XXX TODO TODO
      if (!_.isEmpty(seenOutputsInRange)) {
        //  - Don't construct a KernelResultsReceiver since that wipes out the existing outputs
        //  - TODO Figure out some kind of feedback for the user that we noop'd this as a "once" cell
        return
      }
    }

    const resultsReceiver = new KernelResultsReceiver({owner: 'runCode', ...options}, this, this.editor, range, code);
    if (!kernel) {
      // Bad [not actually sure when this happens in practice]
      resultsReceiver.onKernelResult({stream: 'status', data: 'error'});
    } else if (metadata.skip) {
      // Skip cells marked `%% {skip:true}`
      resultsReceiver.onKernelResult({output_type: 'status', execution_state: 'busy'});
      resultsReceiver.onKernelResult({output_type: 'stream', name: 'stdout', text: '[skip]'});
      resultsReceiver.onKernelResult({output_type: 'status', execution_state: 'idle'});
      resultsReceiver.onKernelResult({stream: 'status', data: 'ok'});
    } else {
      // Run code
      //  - TODO Adapt kernel.execute into Promise [is this causing any problems currently?]
      kernel.execute(code, result => resultsReceiver.onKernelResult(result));
    }

    // Track that we've seen this code output
    //  - So that we can avoid running it again if it's a {once:true} cell
    //  - HACK Reaching into guts! Create a proper api for us to observe the output marker id.
    const outputMarker = resultsReceiver.marker;
    const outputMarkerId = outputMarker.id;
    this.seenOutputMarkerIds.add(outputMarkerId);
    outputMarker.onDidDestroy(() => this.seenOutputMarkerIds.delete(outputMarkerId));

    return await resultsReceiver.promise;
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
    const kernel = this.kernel;
    if (kernel) return kernel;

    const grammar = this.editor.getGrammar();
    const file = this.editor.buffer.file;
    if (!grammar) throw 'Editor has no grammar';
    if (!file) throw 'Editor has no file';

    // Pick sane default kernel to start, and let user switch if we're wrong
    //  - Careful: hydrogen kernelSpec's have display_name but not name, whereas jupyter kernels
    //    use name for the stable identifier (e.g. 'python3') and display_name for the
    //    human-friendly name (e.g. 'Python 3')
    //  - TODO: PR hydrogen so their kernels have .name in addition to .display_name
    await this.updateKernelSpecs();
    const kernelSpec = this.getKernelSpec();
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
          file.path,
          kernel => resolve(kernel),
        );
      });
      return kernel;
    }
  }

  getKernelSpec() {
    const grammar = this.editor.getGrammar();
    const file = this.editor.buffer.file;
    if (!grammar) throw 'Editor has no grammar';
    if (!file) throw 'Editor has no file';

    const kernelSpecs = this.getAllKernelSpecsForGrammarSync(grammar);
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

  // Split hydrogen KernelManager.getAllKernelSpecsForGrammar into an async update + sync get,
  // because we need a sync get in IpynbPyFile.createWriteStream
  async updateKernelSpecs() {
    await hydrogen.kernelManager.updateKernelSpecs();
  }

  // Split hydrogen KernelManager.getAllKernelSpecsForGrammar into an async update + sync get,
  // because we need a sync get in IpynbPyFile.createWriteStream
  getAllKernelSpecsForGrammarSync(grammar) {
    if (!grammar) return [];
    if (!hydrogen.kernelManager.kernelSpecs) return [];
    const kernelSpecs = hydrogen.kernelManager.kernelSpecs;

    // FIXME Nope, this isn't sufficient, e.g. doesn't fix the kernel picker (hydrogen:start-local-kernel)
    //  - The user config has to specify languageMappings for hydrogen kernel picker to work
    //  - TODO Submit a hydrogen PR that allows multiple grammars to map to the same kernel, e.g.
    //    - 'python' -> ['jupyter notebook (python)', 'magicpython']
    //    - Else we can't use hydrogen with two different non-standard grammars
    // // HACK Make .ipynb find the same kernels as .py
    // //  - Hydrogen settings do support this kind of mapping, but let's not require the user to edit them
    // const scopeNameMapping = {
    //   'source.ipynb.python': 'source.python',
    // };
    // grammar = atom.grammars.grammarForScopeName(scopeNameMapping[grammar.scopeName] || grammar.scopeName);

    // HACK Show all installed kernels regardless of grammar, since we don't yet have a good story for varying grammars
    //  - e.g. for scala in .ipynb I had to fiddle too much with duping kernel.json files and hacking the language field
    // console.log('XXX', {kernelSpecs}); // XXX Nope, we aren't even being called :/
    return kernelSpecs.filter(spec => hydrogen.utils.kernelSpecProvidesGrammar(spec, grammar));
    // return kernelSpecs; // XXX Nope, we aren't even being called :/
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
