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
  ifPackageActive, joinIfArray, onAnyEvent, sha1hex, stripSuffix, withException,
} = require('./util');

export class IpynbSync {

  constructor(notebook) {
    this.disposables = new CompositeDisposable();
    this.notebook = notebook;
    this.ipynbPyFile = new IpynbPyFile(this);
  }

  get editor() { return this.notebook.editor; }
  get path() { return this.notebook.editor.buffer.file.path; }

  destroy() {
    this.disposables.dispose();
  }

  async start() {
    this.disposables.add(
      onAnyEvent(this.editor.buffer, eventName => console.debug('this.editor.buffer', eventName)), // XXX
      this.editor.buffer.onDidReload(() => this.reloadOutputsFromIpynb()),
      this.editor.buffer.onDidChangePath(() => this.setGrammarToPy()),
      // Install our custom File into editor.buffer to maintain the .py <-> .ipynb mapping
      //  - Do this after setting up the did-* listeners, since it triggers the first did-reload
      await this.ipynbPyFile.start(),
    );
    return new Disposable(() => this.destroy());
  }

  setGrammarToPy() {
    this.editor.setGrammar(atom.grammars.grammarForScopeName('source.python'));
  }

  getPyFromIpynbSource(ipynbSource) {
    console.debug('getPyFromIpynbSource');
    try {

      // e.g. on new file
      if (!ipynbSource) return '';

      // Parse input .ipynb json
      //  - TODO Sanity check: does kernel=prices-dashboard modeline actually work in .ipynb.py?
      const ipynb = JSON.parse(ipynbSource);
      const ipynbCells = ipynb.cells;
      const pyLines = [];
      window.ipynb = ipynb; // XXX

      // TODO TODO Action at a distance! (-> reloadOutputsFromIpynb)
      this.lastIpynbCells = ipynbCells;

      // Surface .metadata
      //  - TODO How to sync kernel between .py and .ipynb? We typically run jupyter notebook
      //    .ipynb in an env but rely on hydrogen kernel management for atom .py
      const kernelspec = ipynb.metadata.kernelspec || {};
      pyLines.push(
        '%%metadata',
        `# atom: kernel=${kernelspec.name || ''}`,
      );
      const metadata = {
        // Include a hash of the full .ipynb so that .ipynb changes on disk that don't change the
        // resulting .py (e.g. add/remove/clear outputs) will still trigger a TextBuffer reload
        ipynb_hash: sha1hex(ipynbSource),
        ...ipynb.metadata,
      };
      // TODO Write .kernelspec from .py hydrogen kernel, or preserve .kernelspec from .ipynb for simpler roundtrip/diff?
      //  - Should probably write from .py hydrogen kernel, to mimic jupyter notebook
      // delete metadata['kernelspec']; // Sufficiently represented by modeline
      if (!_.isEmpty(metadata)) {
        pyLines.push(
          stripSuffix(
            yaml.safeDump(metadata, {
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

      // Compute .py buffer contents from .ipynb cells
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
        // Surface metadata in heading
        const metadata = cell.metadata;
        // Store cell.execution_count so we can read it back out on roundtrip
        //  - TODO TODO Find better way to represent execution_count
        //    - Have to handle case where cell has .outputs:[] but has .execution_count:N
        //  - TODO TODO Also find way to update whatever representation when running .py cells interactively
        if (cell.execution_count) {
          metadata.execution_count = cell.execution_count;
        }
        if (!_.isEmpty(metadata)) {
          const metadataYaml = stripSuffix(yaml.safeDump(metadata, {flowLevel: 0}), '\n');
          heading = ['%%', null].includes(heading) ? '' : `\n${heading}`;
          heading = `%% ${metadataYaml}${heading}`;
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

  reloadOutputsFromIpynb() {
    console.debug('reloadOutputsFromIpynb');
    try {

      // TODO TODO Action at a distance! (<- getPyFromIpynbSource)
      let ipynbCells = this.lastIpynbCells;
      if (!ipynbCells) {
        // Else parse .ipynb from file, e.g. on window reload when getPyFromIpynbSource isn't called
        const ipynbSource = this.ipynbPyFile.file.readSync();
        ipynbCells = ipynbSource && JSON.parse(ipynbSource).cells;
      }

      // e.g. on new file
      if (!ipynbCells) return;

      // Ensure editor grammar is .py before allCodeChunks, which is sensitive to e.g. comment chars
      this.setGrammarToPy();

      // Link .ipynb/.py cells, so we can put .ipynb outputs in the right .py place
      //  - pyCells has one more than ipynbCells, because of the config/modeline cell we add above
      const pyCells = allCodeChunks('cell', this.editor);
      // TODO TODO Re-enable once we finish debugging both roundtrips
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
            const resultsReceiver = new KernelResultsReceiver(
              {},
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

  // TODO TODO Find better way to represent execution_count
  //  - Have to handle case where cell has .outputs:[] but has .execution_count:N
  //  - TODO TODO Also find way to update whatever representation when running .py cells interactively

  getIpynbFromPyEditor() {
    console.debug('getIpynbFromPyEditor');
    try {

      // Docs: https://nbformat.readthedocs.io/en/latest/format_description.html
      const ipynb = {};
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

        // Parse cell delim (e.g. '%%' / '%% {x: foo, y: bar}')
        //  - Interpret delim text as cell metadata
        let delimText;
        [, delim, delimText, source] = source.match(/^(%% *(?: +(.*))?)\n((?:.|\n)*)$/) || [
          null, null, null, source,
        ];
        let metadata;
        if (delimText) {
          metadata = withException(() => {
            const x = yaml.safeLoad(delimText);
            if (x.constructor !== Object) {
              throw Error(`Expected Object, got ${x.constructor.name}`);
            }
            return x;
          }, e => {
            e.message = `Failed to parse cell metadata as yaml: ${JSON.stringify(delim)}\n \n${e.message}`;
          });
        }
        metadata = metadata || {};

        // Read execution_count back out from cell metadata
        //  - TODO TODO Find better way to represent execution_count
        //    - Have to handle case where cell has .outputs:[] but has .execution_count:N
        //  - TODO TODO Also find way to update whatever representation when running .py cells interactively
        let {execution_count} = metadata;
        delete metadata['execution_count'];

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
        [, magic, source] = source.match(/^%%(.*)\n((?:.|\n)*)$/) || [
          null, null, source,
        ];
        magic = {
          // Translate magic synonyms
          'md': 'markdown',
        }[magic] || magic;

        // Parse ipynb.metadata (%%metadata in first cell)
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
        if (source !== null) {
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
            // TODO TODO This isn't sufficient, e.g. cell with .outputs:[] but .execution_count:N
            // if (result.execution_count) execution_count = result.execution_count; // Last one wins
          }
        });

        // Add as an ipynb cell, unless we're the first cell with no delim, magic, source, or outputs
        if (!(firstCell && !delim && !magic && !source.length && !outputs.length)) {
          ipynbCell = {
            cell_type,
            metadata,
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
      const kernelSpec = this.notebook.getKernelSpec(); // Respects modelines, lastKernel, etc.
      ipynb.nbformat = 4;
      ipynb.nbformat_minor = 2;
      ipynb.metadata = {
        ...ipynb.metadata,
        // TODO Write .kernelspec from .py hydrogen kernel, or preserve .kernelspec from .ipynb for simpler roundtrip/diff?
        //  - Should probably write from .py hydrogen kernel, to mimic jupyter notebook
        kernelspec: {
          // Provide fallbacks in case there's no hydrogen kernel running
          //  - For name, fallback to .display_name because hydrogen kernelSpec's have no .name
          name: kernelSpec.name || kernelSpec.display_name || 'python',
          display_name: kernelSpec.display_name || 'python',
          language: kernelSpec.language || 'python',
        },
      };

      // Populate .ipynb buffer (all at once)
      let ipynbJson = jsonStableStringify(ipynb, {space: 1});
      // Jupyter compat: collapse empty []/{} that are split over two lines, e.g.
      //  - 'outputs: [\n  ],\n' -> 'outputs: [],\n'
      ipynbJson = ipynbJson.replace(
        /([[{])\n\s*([\]}])/g,
        (_match, open, close) => `${open}${close}`,
      )
      // Jupyter compat: ensure ending newline
      ipynbJson = ipynbJson + '\n';

      return ipynbJson;

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

}
