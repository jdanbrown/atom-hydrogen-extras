'use babel';

import {Point, Range} from 'atom';
import clipboard from 'clipboard';
import {nativeImage} from 'electron';
import fs from 'fs';
import path from 'path';

// TODO How to import from our own package.json?
const {CompositeDisposable, Disposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);
const AnsiUp = require(`${atom.packages.resolvePackagePath('hydrogen-extras')}/node_modules/ansi_up`);
const ansi_up = new AnsiUp.default;
const chance = require(`${atom.packages.resolvePackagePath('random')}/node_modules/chance`).Chance();
const vegaEmbed = require(`${atom.packages.resolvePackagePath('hydrogen-extras')}/node_modules/vega-embed/build/vega-embed`);
window.vegaEmbed = vegaEmbed; // XXX Debug

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const stripAnsi = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/strip-ansi`);

const {maximizeCurrentPane, unmaximizeCurrentPane} = require('./maximize-pane');
const {
  boolishString,
  cellIsEmpty,
  cellHasMetadataLine,
  clipboardCopyImageFromDataURL,
  clipboardCopyImg,
  dumpCellMetadataLine,
  elementsFromHtml,
  joinIfArray,
  mktemp,
  parseCellMetadata,
  svgToPngDataUrl,
} = require('./util');
const vegaUtil = require('./vega-util');

export class KernelResultsReceiver {

  // TODO How to leave visual mode after enter? Can't clipboard since we need to have a range
  // TODO How to restore decorations after delete/undo, cut/paste?
  // TODO Reuse ipython display? (plots, dfs)

  constructor(options, notebook, editor, range, code) {

    this.disposables = new CompositeDisposable(); // (Not yet used)
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

    notebook.pendingResultsReceivers.add(this);
    this.promise.finally(() => {
      notebook.pendingResultsReceivers.delete(this);
    });
    this.promise.catch(e => {
      Array.from(notebook.pendingResultsReceivers).forEach(that => {
        that.cancel();
      });
      throw e;
    });

    this.codePrefix = code.slice(0, 20).replace('\n', '\\n');
    if (code.length > this.codePrefix.length) this.codePrefix += '...';
    this.desc = `runCode[${this.codePrefix}]`; // For logging

    // console.debug(`${this.desc}: constructor`, options, notebook, editor, range, code);

    this.hideOverlappingDecorations(range);
    notebook.deleteMarkersInTheWayOfNewResults(range);

    this.marker = notebook.markerLayer.markBufferRange(range, {
      class: 'notebook-result-marker',
      owner: options.owner,
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
    this.container.append(this.resultElem);

    this.rawResultsContainer = document.createElement('div');
    this.rawResultsContainer.className = 'notebook-raw-results-container';
    this.container.append(this.rawResultsContainer);

    this.resultLastTextElem = null;
    this.openableElems = [];

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
    // console.debug(`${this.desc}: marker`, this.marker); // XXX dev
    // console.debug(`${this.desc}: codeDecoration`, this.codeDecoration); // XXX dev
    // console.debug(`${this.desc}: resultDecoration`, this.resultDecoration); // XXX dev

  }

  dispose() {
    this.disposables.dispose();
  }

  measureRuntimeStart() {
    this.startTime = new Date();
  }

  measureRuntimeStop() {
    if (this.startTime && !cellIsEmpty(this.code)) {
      let time = (new Date() - this.startTime) / 1000; // Seconds
      if (time < this.notebook.config.showCellTimesOver) time = null;
      if (time) time = `${time}s`;
      this.addCellMetadata({time});
    }
  }

  addCellMetadata(metadata) {
    const buffer = this.editor.buffer;
    if (this.supportsCellMetadata(buffer)) {
      const cellText = buffer.getTextInRange(this.range);
      const delimLineRange = cellHasMetadataLine(cellText)
        ? buffer.rangeForRow(this.range.getRows()[0], true)
        : Range(this.range.start, this.range.start);
      const existingMetadata = parseCellMetadata(cellText).metadata;
      metadata = _.omitBy(
        {...existingMetadata, ...metadata},
        x => _.isNull(x) || _.isUndefined(x),
      );
      if (!_.isEmpty(metadata) || !_.isEmpty(existingMetadata)) {
        const delimLineText = dumpCellMetadataLine(metadata) + '\n';
        buffer.setTextInRange(
          // Ok this is funky:
          //  - If we overwrite the full delimLineRange, then we can't delete from the delim line because the output
          //    marker's range shrinks to start at the line after the overwritten delim line
          //  - To work around that, trim the range and text so we leave the first char as is, which suffices to keep
          //    the output marker's range unchanged (since we edited strictly inside of it)
          //  - This workaround assumes that the new first char and old first char match (both are '%')
          delimLineRange.translate({row: 0, column: 1}, {row: 0, column: 0}),
          delimLineText.slice(1),
        );
        buffer.groupLastChanges(); // Group undo with previous undo
      }
    }
  }

  supportsCellMetadata(buffer) {
    return [
      '.ipynb',
    ].includes(path.extname((buffer.file || {}).path));
  }

  hideOverlappingDecorations(range) {
    // TODO Is there a good way to do this more generally?
    //  - e.g. find and destroy all overlapping block decorations?
    // Hide autocomplete-plus suggestion list
    const {autocompleteManager} = atom.packages.getActivePackage('autocomplete-plus').mainModule
    autocompleteManager.hideSuggestionList()
  }

  onDidUpdateOutput() {
    this.updateOutputPosition();
    this.notebook.emitter.emit('did-update-outputs');
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
    // console.debug(`${this.desc}: result\n`, result); // XXX debug

    // Append jupyter results to .notebook-raw-result, e.g. for .ipynb outputs
    //  - Exclude synthetic hydrogen results that aren't real jupyter results
    //  - TODO De-dupe these conditions with the conditions below
    if (!(
      result.output_type === 'status' && result.execution_state === 'busy' ||
      result.output_type === 'status' && result.execution_state === 'idle' ||
      result.output_type === 'execute_input'
    )) {
      this.rawResultElem = document.createElement('div');
      this.rawResultElem.className = 'notebook-raw-result';
      this.rawResultElem.dataset.result = JSON.stringify(result);
      // After: this.rawResultElem.dataset.result = JSON.stringify(result)
      this.constructor.normalizeKernelResult(result);
      // Replace prev rawResultElem if both are text and '\r'/'\n' allow it
      //  - Else long-running progress bars bloat .ipynb and make things slow/hang
      const prevRawResultElem = _.last(this.rawResultsContainer.children);
      const erasePrev = !!(
        prevRawResultElem &&
        result.text &&
        (
          _.get(prevRawResultElem, ['dataset', 'shouldErase']) && !result.text.startsWith('\n') ||
          _.get(prevRawResultElem, ['dataset', 'mayErase'])    && result.text.startsWith('\r')
        )
      );
      if (erasePrev) {
        prevRawResultElem.replaceWith(this.rawResultElem);
      } else {
        this.rawResultsContainer.append(this.rawResultElem);
      }
      // After: normalizeKernelResult(result)
      if (result.text) {
        this.rawResultElem.dataset.shouldErase = boolishString(!result.text.includes('\n') && result.text.endsWith('\r'));
        this.rawResultElem.dataset.mayErase    = boolishString(!result.text.includes('\n'));
      }
    }

    window.container = this.container; // XXX dev
    window.resultElem = this.resultElem; // XXX dev
    window.result = result; // XXX dev

    if (result.stream === 'execution_count') {
      // Ignored, e.g. `Out[${result.data}]`
      this.onDidUpdateOutput();
    } else if (result.output_type === 'status' && result.execution_state === 'busy') {
      this.measureRuntimeStart();
    } else if (result.output_type === 'status' && result.execution_state === 'idle') {
      // Let resultStatus do measureRuntimeStop(), to distinguish ok/error from cancelled
    } else if (result.output_type === 'execute_input') {
      // TODO New (synthetic?) hydrogen result type
    } else if (result.output_type === 'stream') {
      this.resultAppendText(result.text, { stream: result.name });
      this.onDidUpdateOutput();
    } else if (['execute_result', 'display_data'].includes(result.output_type)) {
      this.onKernelResultData(result.data);
      this.onDidUpdateOutput();
    } else if (result.output_type === 'error') {
      this.resultAppendText(
        this.constructor.formatKernelResultTraceback(result.traceback),
        { stream: 'stderr' },
      );
      // this.resultLastTextElem.classList.add('stderr');
      this.onDidUpdateOutput();
    } else if (result.stream === 'status') {
      this.resultStatus(result.data);
      this.onDidUpdateOutput();
    } else {
      console.error(`${this.desc}: Unexpected result\n`, result);
    }
  }

  onKernelResultData(data) {
    this.resultEnsureNewline();

    // html
    if (result.data['text/html'] && !this.notebook.config.skipHtml) {
      this.resultAppendElementsFromHtml(result.data['text/html'], {
        // TODO Fix text/plain formatting for big (wide? long?) pandas df's (compare to text/html)
        textForClipboardCopy: result.data['text/plain']
      });

    // altair (vegalite/vega)
    //  - Tested with altair 4.1.0 which uses 'application/vnd.vegalite.v4+json'
    //  - e.g. https://github.com/nteract/nteract/pull/4442/files
    } else if (result.data['application/vnd.vegalite.v4+json']) {
      this.resultAppendVega(result.data['application/vnd.vegalite.v4+json']);
    } else if (result.data['application/vnd.vegalite.v3+json']) {
      this.resultAppendVega(result.data['application/vnd.vegalite.v3+json']);
    } else if (result.data['application/vnd.vegalite.v2+json']) {
      this.resultAppendVega(result.data['application/vnd.vegalite.v2+json']);
    } else if (result.data['application/vnd.vegalite.v1+json']) {
      this.resultAppendVega(result.data['application/vnd.vegalite.v1+json']);
    } else if (result.data['application/vnd.vega.v5+json']) {
      this.resultAppendVega(result.data['application/vnd.vega.v5+json']);
    } else if (result.data['application/vnd.vega.v4+json']) {
      this.resultAppendVega(result.data['application/vnd.vega.v4+json']);
    } else if (result.data['application/vnd.vega.v3+json']) {
      this.resultAppendVega(result.data['application/vnd.vega.v3+json']);
    } else if (result.data['application/vnd.vega.v2+json']) {
      this.resultAppendVega(result.data['application/vnd.vega.v2+json']);

    // Images
    } else if (result.data['image/svg+xml']) {
      this.resultAppendSvgFromXml(result.data['image/svg+xml']);
    } else if (result.data['image/png']) {
      this.resultAppendImgFromSrc(`data:image/png;base64,${result.data['image/png']}`);
    } else if (result.data['image/jpeg']) {
      this.resultAppendImgFromSrc(`data:image/jpeg;base64,${result.data['image/jpeg']}`);

    // js
    //  - e.g. for bokeh
    } else if (result.data['application/javascript']) {
      // TODO Add support for `element` [done], jquery, urls instead of code, lib=/css=, (what else?):
      //  - https://ipython.readthedocs.io/en/stable/api/generated/IPython.display.html#IPython.display.Javascript
      //  - "In the Notebook, the containing element will be available as element, and jQuery will be available. Content
      //    appended to element will be visible in the output area."
      // Bypass CSP so that external resources can be loaded (e.g. js libs)
      //  - https://github.com/electron/electron/issues/3430
      //  - https://electronjs.org/docs/api/web-frame
      //  - TODO How worrisome is this? The whole intention is to run code we've never seen, so...
      require('electron').webFrame.registerURLSchemeAsBypassingCSP('https');
      // Appending <script> doesn't eval the js, don't know why. Just eval the js instead.
      // this.resultAppendElementsFromHtml(`<script ...>`);
      // Make the containing element available as `element`
      //  - As per https://ipython.readthedocs.io/en/stable/api/generated/IPython.display.html#IPython.display.Javascript
      const element = document.createElement('div');
      this.resultAppend(element);
      // Eval the js
      //  - TODO Sandbox this eval
      eval(result.data['application/javascript']);

    // Else text/plain
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
      if (this.options.inpane) this.openOpenableElems();
      this.resultElem.classList.remove('pending');
      this.resultElem.classList.add('ok');
      this.codeDecoration.destroy();
      this.measureRuntimeStop();
      this._resolve();
    } else if (status === 'error') {
      if (this.options.inpane) this.openOpenableElems();
      this.resultElem.classList.remove('pending');
      this.resultElem.classList.add('error');
      this.codeDecoration.destroy();
      this.measureRuntimeStop();
      this._reject('status: error');
    } else if (status === 'cancelled') {
      if (this.options.inpane) this.openOpenableElems();
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
        textElem.classList.add('notebook-result-text');
        textElem.classList.add(streamClass);
        this.resultAppend(textElem);
        this.resultLastTextElem = textElem;
        this.initOpenable({
          elem: textElem,
          open: async args => {
            this.resultOpen({
              data: textElem.textContent,
              suffix: '.txt',
              ...args,
            });
          },
          copy: async () => {
            clipboard.writeText(textElem.textContent);
            atom.notifications.addSuccess('Copied to clipboard (text)');
          },
        });
      }

      // TODO Map ansi colors to css
      //  - Try: https://github.com/drudru/ansi_up
      //    - Use use_classes:true to emit css classes instead of literal colors
      //    - Then override (or replace) with our atom classes from the user theme's *-syntax/styles/colors.less
      //  - Try: https://github.com/xpl/ansicolor
      //  - Try: https://github.com/chalk/chalk
      //  - XXX Obstructed at a lower level: text from hydrogen contains the '^[' instead of esc (and '^H' instead of del)
      //    - ipykernel? hydrogen? Need to dig to figure out
      // if (!('reset_to_off' in ansi_up)) {
      //   ansi_up.reset_to_off = () => {
      //     ansi_up.fg = null;
      //     ansi_up.bg = null;
      //     ansi_up.bold = false;
      //   };
      // }
      // global._ = _;
      // global.ansi_up = ansi_up;
      // global.ex = "\n\n\033[1;33;40m 33;40  \033[1;33;41m 33;41  \033[1;33;42m 33;42  \033[1;33;43m 33;43  \033[1;33;44m 33;44  \033[1;33;45m 33;45  \033[1;33;46m 33;46  \033[1m\033[0\n\n\033[1;33;42m >> Tests OK\n\n";
      // global.text = text;
      // console.debug(text);
      // console.debug(ansi_up.ansi_to_html(text));

      // TODO Map ansi colors to css
      text = stripAnsi(text);

      // Append text to resultLastTextElem, interpreting CR chars (\r) along the way
      //  - Approach: for each CR char, delete back to last LF char (\n)
      //    - But don't erase lines on \r\n -- HACK replace \r\n with \n before doing \r stuff
      //  - Handling \r across calls is tricky -- HACK use this.deferredText to handle the common cases
      if (this.deferredText) {
        text = this.deferredText + text;
        this.deferredText = undefined;
      }
      text = text.replace(/\r\n/g, '\n');
      if (text.endsWith('\r')) {
        text = text.slice(0, text.length - 1);
        this.deferredText = '\r';
      }
      const [preCRText, ...postCRTexts] = text.split(/\r+/);
      this.resultLastTextElem.append(document.createTextNode(preCRText));
      postCRTexts.forEach(postCRText => {
        if (!postCRText.startsWith('\n')) {
          let lastLF = this.resultLastTextElem.textContent.lastIndexOf('\n');
          lastLF += 1; // Delete to char after LF, else delete to 0 if no LF found (-1)
          this.resultLastTextElem.textContent = this.resultLastTextElem.textContent.slice(0, lastLF);
        }
        this.resultLastTextElem.append(document.createTextNode(postCRText));
      });
    }
  }

  resultAppendElementsFromHtml(html, {textForClipboardCopy}) {

    // HACK If html came from altair's 'html' renderer, extract the json vega spec and reroute through resultAppendVega
    //  - https://altair-viz.github.io/user_guide/display_frontends.html
    //  - This gives us more control over the vegaEmbed options (e.g. actions:false)
    //  - Note that without this reroute trying to render the altair html fails, but in a dumb way that's fixable a la:
    //    - html = html.replace(/document.currentScript/, '({})');
    if (vegaUtil.isHtmlFromAltairHtmlRenderer(html)) {
      const vegaSpec = vegaUtil.extractVegaSpecFromAltairHtmlRenderer(html);
      this.resultAppendVega(vegaSpec);

    // Else render html normally
    } else {
      const elems = elementsFromHtml(html);
      this.resultAppend(...elems);
      if (textForClipboardCopy) {
        elems.forEach(elem => {
          this.initOpenable({
            elem: elem,
            open: async args => {
              this.resultOpen({
                data: textForClipboardCopy,
                suffix: '.txt',
                ...args,
              });
            },
            copy: async () => {
              clipboard.writeText(textForClipboardCopy);
              atom.notifications.addSuccess('Copied to clipboard (text for html)');
            },
          });
        });
      }

    }
  }

  async resultAppendVega(vegaSpec) {
    window.vegaSpec = vegaSpec; // XXX Debug

    // Initialize vega listeners for responsive plot sizing
    //  - https://vega.github.io/vega-lite/docs/size.html#specifying-responsive-width-and-height
    //  - FIXME Plots with responsive sizing (width/height:'container') _almost_ work
    //    - They render correctly on running the cell that produces the plot
    //    - They render correctly on editor reload (\\)
    //    - They render incorrectly (empty, width=0) when initially opening an .ipynb
    //    - They render incorrectly (empty, width=0) when saving this file in atom "developer mode" (maybe not worth solving)
    vegaUtil.ensureListenersInitialized();

    const div = document.createElement('div');
    div.classList.add('notebook-figure-vega');
    const outer = div;

    this.resultAppend(outer);
    try {
      const vegaResult = await vegaEmbed(div, vegaSpec, {
        // Options
        //  - https://github.com/vega/vega-embed#options
        actions: false,
        // TODO How to make links open in browser instead of popping up weird atom window?
        //  - Tried this but didn't work: https://github.com/vega/vega-lite/issues/3795
        // 'loader': {'target': '_blank'},
      });
      const vegaView = vegaResult.view;
      window.vegaResult = vegaResult; // XXX Debug
      window.vegaView   = vegaView;   // XXX Debug
    } catch (e) {
      console.error(e);
      atom.notifications.addError(`Failed to render vegalite`, {
        detail: e.message,
        stack: e.stack,
      });
      throw e;
    }

    // TODO Make vegalite openable on click / shift-click / opt-click
    //  - https://vega.github.io/vega/docs/api/view/#image-export
    //  - Careful conflicting with normal click interactions (e.g. on legends)
    //  - Might need to use: vegaView.addEventListener('click', (event, item) => ...)
    //    - https://vega.github.io/vega/docs/api/view/#event-handling
    //    - https://vega.github.io/vega/docs/event-streams/ -- which events are available
    // this.initOpenable({
    //   elem: div,
    //   ...
    // });

  }

  resultAppendSvgFromXml(svgXml) {
    const elements = elementsFromHtml(svgXml);
    const parent = this.resultAppend(...elements);
    Array.from(parent.getElementsByTagName('svg')).forEach(svg => {
      this.initOpenable({
        elem: svg,
        figure: true,
        open: async args => {
          this.resultOpen({
            data: svg.outerHTML,
            suffix: '.svg',
            ...args,
          });
        },
        copy: async () => {
          const pngDataUrl = await svgToPngDataUrl(svg);
          clipboardCopyImageFromDataURL(pngDataUrl);
          atom.notifications.addSuccess('Copied to clipboard (png from svg)');
        },
      });
    });
  }

  resultAppendImgFromSrc(src) {
    const img = document.createElement('img');
    img.src = src;
    this.resultAppend(img);
    this.initOpenable({
      elem: img,
      figure: true,
      open: async args => {
        if (!src.startsWith('data:image/png;')) {
          // TODO Map src data url to NativeImage.to* + file suffix
          throw `Expected 'data:image/png', got src[${src.slice(0, 50)}...]`;
        }
        return await this.resultOpen({
          data: nativeImage.createFromDataURL(img.src).toPNG(),
          suffix: '.png',
          ...args,
        });
      },
      copy: async () => {
        clipboardCopyImg(img);
        atom.notifications.addSuccess('Copied to clipboard (png)');
      },
    });
  }

  resultAppend(...elements) {

    // New div for each resultAppend, to block-isolate separate calls
    //  - e.g. A sequence of figures should stack vertically (div), not wrap horizontally (no div)
    const div = document.createElement('div');
    div.append(...elements);
    this.resultElem.append(div);
    this.resultLastTextElem = null;
    this.editor.scrollToCursorPosition();

    // HACK Manually eval <script> elems, since atom/electron doesn't do this automatically
    //  - TODO Why doesn't atom/electron do this automatically? What's the right way to do this? Surely not this way!
    //  - TODO Eval in sandbox (instead of naked eval in current env)
    //  - Ref: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script
    Array.from(div.getElementsByTagName('script')).forEach(script => {
      appendError = s => {
        this.resultAppendText(`${s}\n  ${script.outerHTML}\n\n`, {stream: 'stderr'});
      };
      if (script.type === 'module') {
        appendError('Script type="module" not yet supported, skipping');
      } else if ((script.type || 'text/javascript') === 'text/javascript') {
        if (script.src) {
          // TODO Support src (wasn't my first use case, so I skipped it on first pass)
          appendError('Script src=... not yet supported, skipping');
        } else if (script.text) {
          if (script.async) appendError('Script async not yet supported, running immediately');
          if (script.defer) appendError('Script defer not yet supported, running immediately');
          // HACK I _think_ setTimeout avoids some document.getElementById()->null race conditions on save/reload...
          setTimeout(
            () => {
              // HACK document.currentScript doesn't stick (is it readonly?), so use document_currentScript instead
              const document_currentScript = script;
              try {
                // Isolate script in a new local scope
                eval(`(() => { ${script.text}; })()`);
              } catch (e) {
                appendError(`Script execution failed: ${e.message}`);
              }
            },
            0,
          );
        }
      }
    });

    return this.resultElem;
  }

  async resultOpen({data, prefix, suffix, figure, zoom, opts}) {
    opts = opts || {};
    prefix = prefix || this.codePrefix;
    prefix = `${prefix}-`.replace(/\W+/g, '-').replace(/^-/, '');
    const tmpPath = mktemp({prefix, suffix});
    fs.writeFileSync(tmpPath, data);
    const item = await atom.workspace.open(tmpPath, opts); // [TODO atom.workspace.openSync is broken]
    if (figure) this.markItemAsFigure(item);
    if (zoom) maximizeCurrentPane();
    return item
    // TODO Abstract into function `openInAdjacentPane`
    // TODO Package these commands up so we can declare a package dependency on them
    // TODO XXX Based on my experience, trying to hit the pane the user wants is unreliable and
    // more frequently results in annoying UX than helpful UX. Let's kill this entirely? Or maybe
    // make it an opt-in?
    // atom.commands.dispatch(atom.workspace.element, 'user:window-move-active-item-to-pane-on-right');
    // atom.commands.dispatch(atom.workspace.element, 'user:window-focus-pane-on-left');
  }

  // e.g. for runCode*({inpane: true})
  async openOpenableElems() {
    for (const elem of this.openableElems) {
      await elem.dispatchEvent(new MouseEvent('dblclick'));
      break;
    }
  }

  initOpenable({elem, figure, open, copy}) {
    this.openableElems.push(elem);
    const on = ({click, dblclick}) => async ev => {
      const [a, c, m, s] = [ev.altKey, ev.ctrlKey, ev.metaKey, ev.shiftKey];
      // cmd-click -> open in bg
      if (!a && !c && m && !s && click) await open({figure, opts: {activateItem: false}});
      // alt-click -> copy
      if (a && !c && !m && !s && click) await copy();
      // figure click -> open with zoom
      if (figure && !a && !c && !m && !s && click) await open({figure, zoom: true});
      // !figure dblclick -> open
      if (!figure && !a && !c && !m && !s && dblclick) await open({figure});
    };
    elem.onclick = on({click: true})
    elem.ondblclick = on({dblclick: true})
  }

  markItemAsFigure(item) {
    item.element.classList.add('notebook--figure');
  }

}

// TODO Figure out how to reorg code so that this and resultOpen can sit on the same module/class
//  - closeAndUnzoomActiveItem needs to be called by the global HydrogenNotebooks
//  - Maybe resultOpen shouldn't be in NotebookHydrogenResultReceiver?
export async function closeAndUnzoomActiveItem() {
  unmaximizeCurrentPane();
  await atom.workspace.getActivePane().destroyActiveItem();
}
