'use babel'

import {TextBuffer} from 'atom';
import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const jsonStableStringify = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/json-stable-stringify`);
const {CompositeDisposable, Disposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const yaml = require(`${atom.packages.resolvePackagePath('docker')}/node_modules/js-yaml`);

const {allCodeChunks, trimCodeRange} = require('./cells');
const {KernelResultsReceiver} = require('./kernel-results-receiver');
const {IpynbPyFile} = require('./ipynb-file');
const {
  dumpCellMetadataLine,
  ifPackageActive,
  joinIfArray,
  onAnyEvent,
  parseCellMagic,
  parseCellMetadata,
  parsePyMetadata,
  puts,
  sha1hex,
  stripSuffix,
  withException,
} = require('./util');

export class IpynbSync {

  constructor(notebook) {
    this.disposables = new CompositeDisposable();
    this.notebook = notebook;
    this.ipynbPyFile = new IpynbPyFile(this);
    console.debug('IpynbSync.constructor', {editor: this.notebook.editor.id}); // XXX dev
  }

  get editor() { return this.notebook.editor; }
  get path() { return this.notebook.editor.buffer.file.path; }

  destroy() {
    this.disposables.dispose();
  }

  async start() {
    this.disposables.add(
      onAnyEvent(this.editor.buffer, eventName => console.debug('this.editor.buffer', eventName)), // XXX dev
      this.editor.buffer.onDidReload(() => this.reloadOutputsFromIpynb()),
      // TODO Still needed? See comment at setGrammar
      this.editor.buffer.onDidChangePath(() => this.setGrammar()),
      // Install our custom File into editor.buffer to maintain the .py <-> .ipynb mapping
      //  - Do this after setting up the did-* listeners, since it triggers the first did-reload
      await this.ipynbPyFile.start(),
    );
    return new Disposable(() => this.destroy());
  }

  // HACK Without this, slow-loading .ipynb files don't always have syntax highlighting
  //  - Repro: open a >10m .ipynb file -> window:reload -> observe that grammar is correct but syntax isn't colored
  //  - Workaround: this.setGrammar() at late points during file load (e.g. in reloadOutputsFromIpynb)
  setGrammar() {
    this.editor.setGrammar(atom.grammars.grammarForScopeName('source.ipynb'));
  }

  getPyFromIpynbSource(ipynbSource) {
    console.debug('getPyFromIpynbSource'); // XXX dev
    try {

      // On new file
      if (!ipynbSource) {
        ipynbSource = this.jsonStringifyLikeJupyter({
          cells: [],
          metadata: {
            kernelspec: this.defaultKernelspec,
          },
          ...this.nbformats,
        });
      }

      // Parse input .ipynb json
      //  - TODO Sanity check: does kernel=foo modeline actually work in .ipynb.py?
      const ipynb = JSON.parse(ipynbSource);
      const ipynbCells = ipynb.cells || [];
      let ipynbMetadata = ipynb.metadata || {};
      const pyLines = [];
      window.ipynb = ipynb; // XXX

      // Surface notebook .metadata as %%metadata cell
      //  - TODO How to sync kernel between .py and .ipynb? We typically run jupyter notebook
      //    .ipynb in an env but rely on hydrogen kernel management for atom .py
      const kernelspec = ipynbMetadata.kernelspec || this.defaultKernelspec;
      pyLines.push(
        '%%metadata',
        `# atom: kernel=${kernelspec.name || ''}`,
      );
      ipynbMetadata = {
        // Synthesize a hash of the full .ipynb json in the .py text so that _any_ .ipynb change on disk will trigger a
        // TextBuffer reload (e.g. cell outputs, which wouldn't otherwise affect the .py text and thus wouldn't trigger
        // a TextBuffer reload)
        ipynb_hash: sha1hex(ipynbSource),
        ...ipynbMetadata,
      };
      // TODO Write .kernelspec from .py hydrogen kernel, or preserve .kernelspec from .ipynb for simpler roundtrip/diff?
      //  - Should probably write from .py hydrogen kernel, to mimic jupyter notebook
      // delete metadata['kernelspec']; // Sufficiently represented by modeline
      if (!_.isEmpty(ipynbMetadata)) {
        pyLines.push(
          stripSuffix(
            yaml.safeDump(ipynbMetadata, {
              indent: 2,
              flowLevel: -1,
              sortKeys: true,
              lineWidth: 120,
            }),
            '\n',
          ),
        );
      }
      pyLines.push('');

      // Stash intermediates so that reloadOutputsFromIpynb doesn't have to re-parse the json, which could be very slow
      //  - HACK Action at a distance! (-> reloadOutputsFromIpynb)
      this.stashIpynbDataOnRead = {
        ipynbCells,
        oldIpynbHash: this.getPyMetadataIpynbHash(), // TODO O(n) -> O(1) (see below)
        newIpynbHash: ipynbMetadata.ipynb_hash,
      };
      // console.debug('getPyFromIpynbSource: stashIpynbDataOnRead', this.stashIpynbDataOnRead); // XXX debug

      // Compute .py cell text (no cell output yet) from .ipynb cells
      let firstCell = true;
      ipynbCells.forEach(cell => {
        let source = joinIfArray(cell.source);
        let heading;
        if (cell.cell_type === 'markdown') {
          heading = '%%md';
        } else if (cell.cell_type === 'code') {
          if (/^\s*%%/.test(source)) {
            heading = null; // Let '%%...' in source be the heading
          } else {
            heading = '%%';
          }
        } else if (cell.cell_type === 'raw') {
          heading = '%%raw';
        } else {
          heading = '%%unknown';
        }
        // Surface cell metadata in cell heading (%% {...})
        if (cell.execution_count) {
          // Store cell.execution_count so we can read it back out on roundtrip
          //  - TODO Find better way to represent execution_count
          //    - Have to handle case where cell has .outputs:[] but has .execution_count:N
          //  - TODO Also find way to update whatever representation when running .py cells interactively
          cell.metadata.execution_count = cell.execution_count;
        }
        if (!_.isEmpty(cell.metadata)) {
          heading = dumpCellMetadataLine(cell.metadata) + (
            ['%%', null].includes(heading) ? '' : `\n${heading}`
          );
        }
        if (!firstCell) pyLines.push('');
        if (heading) pyLines.push(heading);
        if (source) pyLines.push(source);
        firstCell = false;
      })

      // Populate .py buffer (all at once)
      //  - Assumption: incremental array append is faster than incremental buffer append
      pyLines.push('') // Ensure trailing newline
      return pyLines.join('\n');

    } catch (e) {
      // TODO Clean up this error reporting
      console.error(e);
      atom.notifications.addError(`Failed to sync .py from ${this.path}`, {
        detail: e.message,
        stack: e.stack,
      });
      throw e;
    }
  }

  // TODO TODO Unused, kill
  // reloadOnDidSaveIfEmpty() {
  //   console.debug('reloadOnDidSaveIfEmpty'); // XXX dev
  //   if (this.editor.buffer.isModified()) {
  //     // We should only be called onDidSave() which should imply !isModified()
  //     //  - But noop silently to degrade gracefully in case weird race conditions trigger this
  //   } else {
  //     if (this.editor.buffer.isEmpty()) {
  //       this.editor.buffer.reload();
  //     }
  //   }
  // }

  reloadOutputsFromIpynb() {
    console.debug('reloadOutputsFromIpynb'); // XXX dev
    try {

      // Ensure editor grammar is .py before allCodeChunks, which is sensitive to e.g. comment chars
      //  - Also see HACK comment at setGrammar
      this.setGrammar();

      // Parse cells from .py
      const pyCells = allCodeChunks('cell', this.editor);

      // TODO TODO Shit shit shit. Make these use cases work:
      //  - Outputs don't refresh after save
      //  - Outputs don't refresh on \\ when nothing's changed
      //  - Outputs refresh on initial load (.py from .ipynb)
      //  - {once:true} continues noop'ing after save
      //  - {once:true} re-runs when no output (e.g. after deleting manually)
      //  - Something sane happens when the .ipynb is modified outside of atom:
      //    - When the atom .py is unmodified
      //    - When the atom .py is modified

      // Reuse intermediates from getPyFromIpynbSource + getIpynbFromPyEditor
      //  - From getPyFromIpynbSource so we don't have to re-parse the json, which could be very slow
      //  - From getIpynbFromPyEditor so we don't have to reload the outputs, which disconnects us from running cells
      //  - HACK Action at a distance! (<- getPyFromIpynbSource)
      let {ipynbCells, oldIpynbHash, newIpynbHash, savedIpynbHash} = {};
      let {stashIpynbDataOnRead, stashIpynbDataOnWrite} = this;
      delete this.stashIpynbDataOnRead;  // Don't consume twice // TODO Fishy...
      delete this.stashIpynbDataOnWrite; // Don't consume twice // TODO Fishy...
      if (stashIpynbDataOnRead) {
        ({ipynbCells, oldIpynbHash, newIpynbHash} = stashIpynbDataOnRead);
      } else {
        // Else parse .ipynb from file, e.g. on window reload when getPyFromIpynbSource isn't called
        const ipynbSource = this.ipynbPyFile.readIpynbSourceSync();
        if (ipynbSource) {
          ipynbCells = JSON.parse(ipynbSource).cells;
          oldIpynbHash = this.getPyMetadataIpynbHash(); // TODO O(n) -> O(1) (see below)
          newIpynbHash = sha1hex(ipynbSource);
        }
      }
      if (stashIpynbDataOnWrite) {
        ({savedIpynbHash} = stashIpynbDataOnWrite);
      }

      // Short-circuit if no .ipynb to load from (e.g. on new file)
      if (!ipynbCells) return;

      // Short-circuit if we have outputs and there's no change to the .ipynb since we last did a save or load
      //  - Detect this by comparing the .ipynb hash to ipynb_hash in the .py %%metadata cell (first cell)
      //  - It's important to reload when we have no outputs because that's how we load from .ipynb in the first place
      // const pyIpynbHash = this.getPyMetadataIpynbHash(pyCells); // XXX -> oldIpynbHash
      const shortHash = hash => (hash || '').slice(0, 7);
      const hasOutputs = this.notebook.hasResults();
      if (hasOutputs && (false
        || oldIpynbHash === newIpynbHash
        // HACK Don't reload outputs when we just saved the same .ipynb that we're reloading outputs from
        //  - TODO Confusingly, we still _do_ reload .py
        //  - And it doesn't lose track of the currently running cell...
        //  - Maybe we should just fix the currently-running-cell bug?
        || savedIpynbHash === newIpynbHash
      )) {
        console.debug(`newIpynbHash[skip]: hasOutputs[${hasOutputs}], saved[${shortHash(savedIpynbHash)}], old[${shortHash(oldIpynbHash)}], new[${shortHash(newIpynbHash)}]`); // XXX
        // Yay, no work to do!
        return;
      } else {
        console.debug(`newIpynbHash[RELOAD]: hasOutputs[${hasOutputs}], saved[${shortHash(savedIpynbHash)}], old[${shortHash(oldIpynbHash)}], new[${shortHash(newIpynbHash)}]`); // XXX
      }

      // Link .ipynb/.py cells, so we can put .ipynb outputs in the right .py place
      //  - pyCells has one more than ipynbCells, because of the config/modeline cell we add above
      // TODO Re-enable once we finish debugging both roundtrips
      // if (1 + ipynbCells.length != pyCells.length) {
      //   throw `Failed to find all the cells: ipynbCells[1 + ${ipynbCells.length}] != pyCells[${pyCells.length}]`;
      // }
      _.zipWith([null].concat(ipynbCells), pyCells, (ipynbCell, pyCell) => {
        if (ipynbCell) {
          ipynbCell._pyCell = pyCell;
        }
      });

      // Populate .py notebook outputs
      this.notebook.withTrackOutput(false, () => {
        ipynbCells.forEach(cell => {
          if (cell._pyCell) {
            // Reuse KernelResultsReceiver to populate cell outputs
            //  - `new KernelResultsReceiver` clears any existing outputs in the cell range
            const resultsReceiver = new KernelResultsReceiver(
              {owner: 'IpynbSync'},
              this.notebook,
              this.editor,
              trimCodeRange(this.editor.buffer, cell._pyCell),
              '',
            );
            (cell.outputs || []).forEach(output => {
              resultsReceiver.onKernelResult(output);
            });
            resultsReceiver.onKernelResult({stream: 'status', data: 'ok'});
          }
        });
      });

    } catch (e) {
      // TODO Clean up this error reporting
      console.error(e);
      atom.notifications.addError(`Failed to sync outputs from ${this.path}`, {
        detail: e.message,
        stack: e.stack,
      });
      throw e;
    }
  }

  // TODO Find better way to represent execution_count
  //  - Have to handle case where cell has .outputs:[] but has .execution_count:N
  //  - TODO Also find way to update whatever representation when running .py cells interactively

  getIpynbFromPyEditor() {
    console.debug('getIpynbFromPyEditor', {editor: this.editor.id}); // XXX dev
    try {

      // Docs: https://nbformat.readthedocs.io/en/latest/format_description.html
      let ipynb = {};
      const pyCells = allCodeChunks('cell', this.editor);

      let firstCell = true;
      ipynb.metadata = {};
      ipynb.cells = [];
      pyCells.forEach(cell => {

        const sourceRaw = this.editor.buffer.getTextInRange(cell);
        let source = sourceRaw;

        // Actually, shouldn't magics stay in the cell source?
        //  - Hmm, looks like `magic` captures the whole line, and it gets put back below
        //  - And it's maybe ok that it captures the whole line since 'markdown'/'raw' are the
        //    only ones we switch behavior on
        //  - TODO Maybe a cleaner way to handle `magic`, but maybe works well enough for a first pass

        // Parse cell metadata from delim text (e.g. '%%' / '%% {x: foo, y: bar}')
        let cellMetadata, delim;
        ({metadata: cellMetadata, delim, body: source} = parseCellMetadata(source));

        // Read execution_count back out from cell metadata
        //  - TODO Find better way to represent execution_count
        //    - Have to handle case where cell has .outputs:[] but has .execution_count:N
        //  - TODO Also find way to update whatever representation when running .py cells interactively
        let {execution_count} = cellMetadata;
        delete cellMetadata['execution_count'];

        // Strip modeline (first line of first cell)
        if (firstCell) {
          const vimModeline = ifPackageActive('vim-modeline', x => x);
          if (!vimModeline) {
            atom.notifications.addError('Please install package vim-modeline for modeline functionality');
          } else {
            const [firstLine, ...restLines] = source.split('\n');
            if (vimModeline.parseVimModeLine(firstLine)) {
              source = restLines.join('\n');
            }
          }
        }

        // Parse cell magic (e.g. '%%bq -T -o df')
        //  - TODO Parse magicArgs separate from magic?
        let magic;
        ({magic, code: source} = parseCellMagic(source));

        // Parse .py %%metadata (first cell)
        if (magic === 'metadata') {
          ipynb.metadata = withException(() => {
            const x = yaml.safeLoad(source);
            delete x.ipynb_hash; // Only for .py (see above)
            return x;
          }, e => {
            e.message = `Failed to parse %%metadata cell (as yaml): ${e.message}`;
          });
          magic = null;
          source = null;
        }

        // Determine .ipynb cell_type
        const cell_type = ['markdown', 'raw'].includes(magic) ? magic : 'code';

        // Munge source
        if (source) {
          // Strip one trailing newline (always present in .py)
          source = stripSuffix(source, '\n');
          // Put %%magic back in cell source, if code cell
          if (magic && cell_type === 'code') {
            source = `%%${magic}\n${source}`;
          }
          // Turn (maybe multi-line) string into list of one-line strings, like jupyter
          //  - Even for single-line strings, turn into a singleton list, like jupyter
          //  - Special case: turn '' into [], not [''], so we can easily detect empty below
          if (source === '') {
            source = null;
          } else {
            source = source.split('\n');
            source = source.map((x, i) => i < source.length - 1 ? x + '\n' : x);
          }
          // Jupyter compat: omit final "" from source (list of lines) if last cell of line is blank
          if (_.last(source) === '') {
            source = source.slice(0, -1);
          }
        }
        source = source || []; // Jupyter compat

        // How to map cell -> outputs? Just collect all outputs positioned within current cell.
        //  - No stable notion of "output for cell" since there's no stable notion of "cell"
        const outputs = [];
        const results =
          _(this.editor.decorationsForScreenRowRange(
            cell.start.row,
            // Workaround bug where .decorationsForScreenRowRange(x, lastRow) returns _all_ decorations
            //  - TODO Does this introduce other bugs? e.g. what about decorations that exist only on the last line?
            Math.min(cell.end.row, this.editor.buffer.getLastRow() - 1),
          ))
          .thru(Object.values)
          .flatten()
          .map(decoration => decoration._item)
          .filter(elem => elem)
          .flatMap(elem => Array.from(elem.querySelectorAll('.notebook-raw-result')))
          .map(elem => JSON.parse(elem.dataset.result))
          .value();
        results.forEach(result => {
          if (!result.stream) {
            outputs.push(result);
            // TODO This isn't sufficient, e.g. cell with .outputs:[] but .execution_count:N
            // if (result.execution_count) execution_count = result.execution_count; // Last one wins
          }
        });

        // Add as an ipynb cell, unless we're the first cell with no delim, magic, source, or outputs
        if (!(firstCell && !delim && !magic && !source.length && !outputs.length)) {
          ipynbCell = {
            cell_type,
            metadata: cellMetadata,
            source,
          };
          if (cell_type === 'code') {
            ipynbCell.execution_count = execution_count || null;
            ipynbCell.outputs = outputs;
          }
          ipynb.cells.push(ipynbCell);
        }

        firstCell = false;
      });

      // Write ipynb metadata from hydrogen kernel metadata
      const kernel = this.notebook.kernel || {};
      ipynb = {
        ...ipynb,
        ...this.nbformats,
      };
      ipynb.metadata = {
        ...ipynb.metadata,
        // Write .kernelspec from .py active hydrogen kernel, not from .ipynb .kernelspec
        //  - Use hydrogen kernel.*, not kernel.kernelSpec.*, to capture e.g. PYTHONSTARTUP
        kernelspec: {
          // Provide fallbacks in case there's no hydrogen kernel running
          //  - For name, fallback to .display_name because hydrogen kernel/kernelSpec's have no .name
          name:         kernel.name || kernel.displayName || this.defaultKernelspec.name,
          display_name: kernel.displayName                || this.defaultKernelspec.display_name,
          language:     kernel.language                   || this.defaultKernelspec.language,
        },
      };

      // Populate .ipynb buffer (all at once)
      const ipynbSource = this.jsonStringifyLikeJupyter(ipynb);

      // Stash intermediates for reloadOutputsFromIpynb
      //  - HACK Action at a distance! (-> reloadOutputsFromIpynb)
      this.stashIpynbDataOnWrite = {
        savedIpynbHash: sha1hex(ipynbSource),
      };
      console.debug('getIpynbFromPyEditor: stashIpynbDataOnWrite', this.stashIpynbDataOnWrite); // XXX debug

      return ipynbSource;

    } catch (e) {
      // TODO Clean up this error reporting
      console.error(e);
      atom.notifications.addError(`Failed to sync to ${this.path}`, {
        detail: e.message,
        stack: e.stack,
      });
      throw e;
    }
  }

  getPyMetadataIpynbHash(pyCells = null) {
    pyCells = pyCells || allCodeChunks('cell', this.editor); // TODO O(n) -> O(1) by parsing for first cell only
    // console.debug('getPyMetadataIpynbHash', {pyCells}); // XXX debug
    if (pyCells && pyCells.length > 0) {
      const pyMetadataCell = pyCells[0];
      if (pyMetadataCell) {
        const pyMetadata = this.editor.buffer.getTextInRange(pyMetadataCell);
        return (parsePyMetadata(pyMetadata || '') || {}).ipynb_hash;
      }
    }
  }

  ipynbDefaultMetadata

  jsonStringifyLikeJupyter(ipynb) {
    // Populate .ipynb buffer (all at once)
    let ipynbSource = jsonStableStringify(ipynb, {space: 1});
    // Jupyter compat: collapse empty []/{} that are split over two lines, e.g.
    //  - 'outputs: [\n  ],\n' -> 'outputs: [],\n'
    ipynbSource = ipynbSource.replace(
      /([[{])\n\s*([\]}])/g,
      (_match, open, close) => `${open}${close}`,
    )
    // Jupyter compat: ensure ending newline
    ipynbSource = ipynbSource + '\n';
    return ipynbSource;
  }

  get defaultKernelspec() {
    return {
      display_name: 'python',
      language:     'python',
      name:         'python'
    };
  }

  get nbformats() {
    return {
      nbformat:       4,
      nbformat_minor: 2,
    };
  }

}
