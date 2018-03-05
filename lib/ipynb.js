'use babel'

import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const yaml = require(`${atom.packages.resolvePackagePath('docker')}/node_modules/js-yaml`);

const {} = require('./cells');
const {KernelResultsReceiver} = require('./kernel-results-receiver');
const {joinIfArray} = require('./util');

export class IpynbSync {

  constructor(notebook) {
    // XXX this._notebook after sorting out which of its things we need to depend on
    this.editorIpynb = notebook.editor;
    this._notebook = notebook;

    this.disposables = new CompositeDisposable();

    this.start();
  }

  destroy() {
    this.disposables.dispose();
  }

  get editorIpynbPath() {
    return (this.editorIpynb.buffer.file || {}).path;
  }

  get editorPyPath() {
    return this.editorPy && (this.editorPy.buffer.file || {}).path;
  }

  async start() {
    // If .ipynb then open .py and start sync, else do nothing
    if (this.editorIpynb.buffer.file) {
      const editorPath = (this.editorIpynb.buffer.file || {}).path;
      // TODO Think harder about if we want automatic two-way sync. Might be too error prone.
      // TODO Add more safeguards when overwriting files (e.g. prompt, but not all the time?)
      if (path.extname(editorPath) === '.ipynb') {

        // TODO Janky open: e.g. on reopen tab, reload window
        //  - TODO Fix atom.workspace.openSync error so we can be sync instead of async (do we care?)
        console.log('atom.workspace', atom.workspace); // XXX
        this.editorPy = await atom.workspace.open(`${editorPath}.py`, {
          searchAllPanes: true,
          split: 'bottom',
        });

        // Re-focus .ipynb editor
        const pane = atom.workspace.paneForItem(this.editorIpynb);
        // TODO TODO Re-enable
        // pane.activateItem(this.editorIpynb);
        // pane.focus();

        // Have to open .ipynb to get link with .ipynb.py
        this.syncViewFromIpynb(this.editorPy, this.editorIpynb);
        this.disposables.add(
          // Guard on active editor to prevent infinite change loop between the two editors
          //  - (Terminates assuming the user isn't toggling the active editor every ~300ms)
          this.editorIpynb.buffer.onDidStopChanging(({changes}) => {
            if (this.editorIpynb === atom.workspace.getActiveTextEditor()) {
              console.debug('this.editorIpynb.buffer.onDidStopChanging');
              this.syncViewFromIpynb(this.editorPy, this.editorIpynb);
            }
          }),
          this.editorPy.buffer.onDidStopChanging(() => {
            if (this.editorPy === atom.workspace.getActiveTextEditor()) {
              console.debug('this.editorPy.buffer.onDidStopChanging');
              this.syncViewToIpynb(this.editorPy, this.editorIpynb);
            }
          }),
        );
      }
    }
  }

  syncViewFromIpynb(editorPy, editorIpynb) {
    console.debug('syncViewFromIpynb', editorPy, editorIpynb);
    try {

      const saved = {
        cursorBufferPosition: editorPy.getCursorBufferPosition(),
        scrollTop: editorPy.getScrollTop(),
      };

      const ipynbText = editorIpynb.buffer.getText();
      const ipynbData = JSON.parse(editorIpynb.getText());
      editorPy.setText('');

      editorPy.insertText('%%config\n');
      editorPy.insertText(JSON.stringify(ipynbData.metadata || null, null, '  '));

      ipynbData.cells.forEach(cell => {
        console.debug('syncViewFromIpynb: cell', cell);

        const code = joinIfArray(cell.source);
        console.debug('syncViewFromIpynb: code\n', code);
        editorPy.insertText('\n\n');
        if (code.trimLeft().startsWith('%%')) {
          // noop
        } else if (cell.cell_type === 'markdown') {
          editorPy.insertText('%%md\n\n');
        } else {
          editorPy.insertText('%%\n\n');
        }

        // TODO Why is (+'\n') necessary to avoid sometimes clipping the end of code?
        //  - We'll want to include a blankline for run-code-cell anyway, so revist after that
        editorPy.insertText(code.trim() + '\n', {select: true});
        const [selection] = editorPy.getSelections();
        const range = selection.getBufferRange();
        selection.clear();
        const resultsReceiver = new KernelResultsReceiver(
          {},
          module.getNotebookForTextEditor(editorPy),
          editorPy,
          range,
        );
        if (cell.outputs) {
          cell.outputs.forEach(output => {
            resultsReceiver.onKernelResult(output);
          });
        }
        resultsReceiver.onKernelResult({stream: 'status', data: 'ok'});

      })

      // TODO Still a little janky
      // editorPy.setCursorBufferPosition(saved.cursorBufferPosition);
      // editorPy.setScrollTop(saved.scrollTop);

    } catch (e) {
      atom.notifications.addError('Failed to sync from .ipynb');
      throw e;
    }
  }

  syncViewToIpynb(editorPy, editorIpynb) {
    console.debug('syncViewToIpynb', editorPy, editorIpynb);
    try {

      // TODO
      //  - Cell outputs come straight from $('.raw-results')[].dataset.result

      // Docs: https://nbformat.readthedocs.io/en/latest/format_description.html
      const ipynb = {};

      const cellSepRows = [];
      cellSepRows.push(editorPy.buffer.getFirstPosition().row);
      editorPy.scan(/^%%.*$/g, {}, ({range}) => cellSepRows.push(range.start.row));
      cellSepRows.push(editorPy.buffer.getEndPosition().row + 1);
      const cellTexts = _.zip(cellSepRows, cellSepRows.slice(1)).filter(([startRow, endRow]) => {
        // _.zip goes the longer of the two lists and fills with undefined
        return startRow !== undefined && endRow !== undefined;
      }).map(([startRow, endRow]) => {
        return {
          cellText: editorPy.buffer.getTextInRange({
            start: {column: 0, row: startRow},
            end: {column: 0, row: endRow},
          }),
          startRow,
          endRow,
        };
      });
      if (!cellTexts[0].cellText.trim()) {
        // Allow first cell to omit leading %% by always including and dropping if empty
        cellTexts.shift();
      }

      let config = null;
      ipynb.cells = [];
      cellTexts.forEach(({cellText, startRow, endRow}) => {
        if (!cellText.startsWith('%%')) cellText = `%%\n\n${cellText}`;
        let [_matched, magic, source] = cellText.match(/%%(.*)\n((?:.|\n)*)/);
        if (magic === 'md') magic = 'markdown';
        if (magic === 'config') {
          config = yaml.load(source.replace(/.*\n/, ''));
        } else {
          source = source.split('\n').map(x => x + '\n') // Like jupyter;
          const cell_type = ['markdown', 'raw'].includes(magic) ? magic : 'code';
          if (cell_type === 'code' && magic) {
            source.unshift(`%%${magic}\n`, '\n');
          }
          const decorationMap = editorPy.decorationsForScreenRowRange(startRow, endRow) // TODO Off by 1?;
          const decoration = _.last(_.flatten(Object.values(decorationMap)).filter(x => x._item));
          let outputs = [];
          if (decoration) {
            outputs = Array.from(decoration._item.querySelectorAll('.notebook-raw-result')).map(elem => {
              return JSON.parse(elem.dataset.result);
            });
          }

          // TODO Good start! -- keep iterating until jupyter can read it

          ipynb.cells.push({
            cell_type,
            execution_count: null, // TODO int
            metadata: {}, // TODO
            source,
            outputs,
          });
        }
      });

      // TODO Read out of config and/or current hydrogen kernel
      //  - hydrogen.store.kernelMapping.get((editor.buffer.file || {}).path).kernelSpec
      ipynb.nbformat = 4;
      ipynb.nbformat_minor = 2;
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
      };

      const saved = {
        cursorBufferPosition: editorIpynb.getCursorBufferPosition(),
        scrollTop: editorIpynb.getScrollTop(),
      };

      editorIpynb.setText(JSON.stringify(ipynb, null, '  '));

      // TODO Still a little janky
      // editorIpynb.setCursorBufferPosition(saved.cursorBufferPosition);
      // editorIpynb.setScrollTop(saved.scrollTop);

    } catch (e) {
      atom.notifications.addError('Failed to sync to .ipynb');
      throw e;
    }
  }

}
