'use babel'

import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const jsonStableStringify = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/json-stable-stringify`);
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const yaml = require(`${atom.packages.resolvePackagePath('docker')}/node_modules/js-yaml`);

const {allCodeChunks, trimCodeRange} = require('./cells');
const {KernelResultsReceiver} = require('./kernel-results-receiver');
const {ifPackageActive, joinIfArray, stripSuffix, withException} = require('./util');

export class IpynbSync {

  constructor(notebooks, notebook) {
    // XXX notebooks/notebook after sorting out which of its things we need to depend on
    this.notebooks = notebooks;
    this.notebook = notebook;
    this.disposables = new CompositeDisposable();
  }

  destroy() {
    this.disposables.dispose();
  }

  get editorIpynbPath() { return (this.editorIpynb.buffer.file || {}).path; }
  get editorPyPath() { return this.editorPy && (this.editorPy.buffer.file || {}).path; }
  get editorIpynbFilename() { return path.basename(this.editorIpynbPath); }
  get editorPyFilename() { return path.basename(this.editorPyPath); }

  // TODO Think harder about if we want automatic two-way sync. Might be too error prone.
  // TODO Add more safeguards when overwriting files (e.g. prompt, but not all the time?)
  async start() {
    this.notebookIpynb = this.notebook;
    this.editorIpynb = this.notebook.editor;

    // TODO Janky open: e.g. on reopen tab, reload window
    //  - TODO Fix atom.workspace.openSync error so we can be sync instead of async (do we care?)
    const editorPyPath = `${editorPath}.py`;
    this.editorPy = await atom.workspace.open(editorPyPath, {
      searchAllPanes: true,
      split: 'bottom',
      activatePane: false, activateItem: false, // XXX dev
    });
    this.notebookPy = this.notebooks.getNotebookForTextEditor(this.editorPy);

    window.editorPy = this.editorPy; // XXX
    window.editorIpynb = this.editorIpynb; // XXX

    // TODO TODO Re-enable (disabled to avoid disruptive focus stealing during dev)
    // Re-focus .ipynb editor
    // const pane = atom.workspace.paneForItem(this.editorIpynb);
    // pane.activateItem(this.editorIpynb);
    // pane.focus();

    // Have to open .ipynb to get link with .ipynb.py
    this.syncIpynbToPy(this.editorPy, this.editorIpynb);
    this.disposables.add(
      // TextBuffer events
      ..._.flatMap(['did-stop-changing', 'did-reload'], eventName => {
        return [
          // Guard on active editor to prevent infinite change loop between the two editors
          //  - (Terminates assuming the user isn't toggling the active editor every ~300ms)
          this.editorIpynb.buffer.emitter.on(eventName, () => {
            if (this.editorIpynb === atom.workspace.getActiveTextEditor()) {
              this.syncIpynbToPy(this.editorPy, this.editorIpynb);
            }
          }),
          this.editorPy.buffer.emitter.on(eventName, () => {
            if (this.editorPy === atom.workspace.getActiveTextEditor()) {
              this.syncPyToIpynb(this.editorPy, this.editorIpynb);
            }
          }),
        ];
      }),
      // HydrogenNotebook events
      ..._.flatMap(['did-update-outputs'], eventName => {
        return [
          // Guard on active editor to prevent infinite change loop between the two editors
          //  - (Terminates assuming the user isn't toggling the active editor every ~300ms)
          this.notebookPy.emitter.on(eventName, () => {
            if (this.editorPy === atom.workspace.getActiveTextEditor()) {
              this.syncPyToIpynb(this.editorPy, this.editorIpynb);
            }
          }),
        ];
      }),
    );
  }

  syncIpynbToPy(editorPy, editorIpynb) {
    console.debug('syncIpynbToPy', 'editorPy:', editorPy, 'editorIpynb:', editorIpynb);
    this.withSavedEditorState(editorPy, () => {
      try {

        // Save editor state to restore after sync
        const saved = {
          visibleRowRange: editorPy.getVisibleRowRange(),
          cursorBufferPosition: editorPy.getCursorBufferPosition(),
        };

        // Parse input .ipynb json
        //  - TODO Sanity check: does kernel=prices-dashboard modeline actually work in .ipynb.py?
        const ipynb = JSON.parse(editorIpynb.getText());
        const ipynbCells = ipynb.cells;
        const pyLines = [];
        window.ipynb = ipynb; // XXX

        // Surface .metadata
        //  - TODO How to sync kernel between .py and .ipynb? We typically run jupyter notebook
        //    .ipynb in an env but rely on hydrogen kernel management for atom .py
        const kernelspec = ipynb.metadata.kernelspec || {};
        pyLines.push(
          '%%metadata',
          `# atom: kernel=${kernelspec.name || ''}`,
        );
        const metadata = {...ipynb.metadata};
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
              heading = '##';
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
            heading = ['##', null].includes(heading) ? '' : `\n${heading}`;
            heading = `## ${metadataYaml}${heading}`;
          }
          if (!firstCell) pyLines.push('');
          if (heading) pyLines.push(heading);
          if (source) pyLines.push(source);
          firstCell = false;
        })

        // Populate .py buffer (all at once)
        //  - Assumption: incremental array append is faster than incremental buffer append
        pyLines.push('')
        editorPy.setText(pyLines.join('\n'));

        // Link .ipynb/.py cells, so we can put .ipynb outputs in the right .py place
        //  - pyCells has one more than ipynbCells, because of the config/modeline cell we add above
        const pyCells = allCodeChunks('cell', editorPy);
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
        ipynbCells.forEach(cell => {
          const resultsReceiver = new KernelResultsReceiver(
            {},
            this.notebookPy,
            editorPy,
            trimCodeRange(editorPy.buffer, cell._pyCell),
            '',
          );
          (cell.outputs || []).forEach(output => {
            resultsReceiver.onKernelResult(output);
          });
          resultsReceiver.onKernelResult({stream: 'status', data: 'ok'});
        });

      } catch (e) {
        console.error(e);
        atom.notifications.addError(`Failed to sync from ${this.editorIpynbPath}`, {
          detail: e.message,
          stack: e.stack,
        });
      }
    });
  }

  // TODO TODO Find better way to represent execution_count
  //  - Have to handle case where cell has .outputs:[] but has .execution_count:N
  //  - TODO TODO Also find way to update whatever representation when running .py cells interactively

  syncPyToIpynb(editorPy, editorIpynb) {
    console.debug('syncPyToIpynb', 'editorPy:', editorPy, 'editorIpynb:', editorIpynb);
    this.withSavedEditorState(editorIpynb, () => {
      try {

        // Docs: https://nbformat.readthedocs.io/en/latest/format_description.html
        const ipynb = {};
        const pyCells = allCodeChunks('cell', editorPy);

        let firstCell = true;
        ipynb.metadata = {};
        ipynb.cells = [];
        pyCells.forEach(cell => {

          const sourceRaw = editorPy.buffer.getTextInRange(cell);
          let source = sourceRaw;

          // Actually, shouldn't magics stay in the cell source?
          //  - Hmm, looks like `magic` captures the whole line, and it gets put back below
          //  - And it's maybe ok that it captures the whole line since 'markdown'/'raw' are the
          //    only ones we switch behavior on
          //  - TODO Maybe a cleaner way to handle `magic`, but maybe works well enough for a first pass

          // Parse cell delim (e.g. '##' / '## {x: foo, y: bar}')
          //  - Interpret delim text as cell metadata
          let delimText;
          [, delim, delimText, source] = source.match(/^(## *(?: +(.*))?)\n((?:.|\n)*)$/) || [
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
            ipynb.metadata = withException(() => yaml.safeLoad(source), e => {
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
            _(editorPy.decorationsForScreenRowRange(
              cell.start.row,
              // Workaround bug where .decorationsForScreenRowRange(x, lastRow) returns _all_ decorations
              //  - TODO Does this introduce other bugs? e.g. what about decorations that exist only on the last line?
              Math.min(cell.end.row, editorPy.buffer.getLastRow() - 1),
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
          // kernelspec: {
          //   // Provide fallbacks in case there's no hydrogen kernel running
          //   //  - For name, fallback to .display_name because hydrogen kernelSpec's have no .name
          //   name: kernelSpec.name || kernelSpec.display_name || 'python',
          //   display_name: kernelSpec.display_name || 'python',
          //   language: kernelSpec.language || 'python',
          // },
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
        editorIpynb.setText(ipynbJson);

      } catch (e) {
        console.error(e);
        atom.notifications.addError(`Failed to sync to ${this.editorIpynbPath}`, {
          detail: e.message,
          stack: e.stack,
        });
      }
    });
  }

  withSavedEditorState(editor, f) {
    // Save editor state
    const saved = {
      visibleRowRange: editor.getVisibleRowRange(),
      cursorBufferPosition: editor.getCursorBufferPosition(),
    };
    try {
      f();
    } finally {
      // Restore editor state
      //  - editor.element.setScrollTop() isn't reliable (why?), so avoid it
      //  - Instead, set editor scroll by moving cursor, and then move cursor back to its real spot
      //  - Min by max visible row in case an output occupies most/all of the editor
      //    - If an output is in view, then visibleRowRange[0] is always the preceeding row
      //    - If an output occupies the whole view, then visibleRowRange is [preceeding, preceeding]
      saved.visibleRowRange = saved.visibleRowRange.map(x => x || 0); // Avoid NaN, e.g. on fresh editor
      const vmpCursorRowOffset = 2; // HACK: vim-mode-plus scrolls the editor to keep the cursor ≥2 rows from top/bottom edges
      editor.setCursorBufferPosition([
        Math.min(saved.visibleRowRange[0] + vmpCursorRowOffset, saved.visibleRowRange[1]),
        0,
      ], {autoscroll: true});
      editor.setCursorBufferPosition(saved.cursorBufferPosition, {autoscroll: false});
    }
  }

}
