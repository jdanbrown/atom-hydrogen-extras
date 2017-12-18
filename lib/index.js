'use babel'

import clipboard from 'clipboard'
import {app, nativeImage} from 'electron'
import fs from 'fs'
import path from 'path'
import {File, Point, Range, TextBuffer, TextEditor} from 'atom'
import vm from 'vm'

// Import atom internal modules
const ScopeDescriptor = require(`${atom.packages.resourcePath}/src/scope-descriptor`)
const TokenizedBuffer = require(`${atom.packages.resourcePath}/src/tokenized-buffer`)

// TODO Package and depend on these properly so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`)
const chance = require(`${atom.configDirPath}/packages/random/node_modules/chance`).Chance()
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
}
const stripAnsi = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/strip-ansi`)
const yaml = require(`${atom.packages.resolvePackagePath('docker')}/node_modules/js-yaml`)

const packageName = 'dan-notebook-v0'

window.hydrogen = hydrogen // XXX dev

//
// utils
//

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

function rangeTrimTrailingNewline(buffer, range) {
  while (buffer.getTextInRange(range).endsWith('\n')) {
    range = range.translate(
      [0, 0],
      [-1, buffer.rangeForRow(range.end.row - 1).end.column],
    )
  }
  return range
}

function joinIfArray(x) {
  return x instanceof Array ? x.join('') : x
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
    let result, e, ok
    try {
      result = vm.runInThisContext(code)
      ok = true
    } catch (_e) {
      e = _e
      ok = false
    }
    if (ok) {
      console.info('AtomJsKernel: ok\n', `\n${code}\n`, result)
      onResult({
        output_type: 'execute_result',
        data: {
          'text/plain': result, // Don't .toString(), in case we can get fancier behavior somewhere
        },
      })
      onResult({
        stream: 'status',
        data: 'ok',
      })
    } else {
      console.error('AtomJsKernel: error\n', `\n${code}\n`, e) // (How to format nicely?)
      onResult({
        output_type: 'error',
        ename: typeof(e),
        evalue: e.toString(),
        traceback: e.stack.split('\n'),
      })
      onResult({
        stream: 'status',
        data: 'error',
      })
    }
  }
}

//
// notebook
//

const module = {

  _config: {
    skipHtml: false, // For dev
  },

  activate() {
    this.notebookModules = {
      notebookMarkdownImages,
      notebookHydrogen,
    }
    Object.values(this.notebookModules).forEach(x => x.activate())
  },

  addCommands() {
    atom.commands.add('atom-workspace', {
      'dan-notebook-v0:run-code-selection': ev => this.getNotebookForActiveTextEditor().runCodeSelection(),
      'dan-notebook-v0:run-code-selection-inpane': ev => this.getNotebookForActiveTextEditor().runCodeSelection({inpane: true}),
      'dan-notebook-v0:run-code-line': ev => this.getNotebookForActiveTextEditor().runCodeLine(),
      'dan-notebook-v0:run-code-line-inpane': ev => this.getNotebookForActiveTextEditor().runCodeLine({inpane: true}),
      'dan-notebook-v0:delete-result-at-cursor': ev => this.getNotebookForActiveTextEditor().deleteResultAtCursor(),
      'dan-notebook-v0:delete-all-results': ev => this.getNotebookForActiveTextEditor().deleteAllResults(),
    })
  },

  getNotebookForTextEditor(editor) {
    const notebookModule = this.notebookModules.notebookHydrogen
    return notebookModule.notebooks[editor.id]
  },

  getNotebookForActiveTextEditor() {
    return this.getNotebookForTextEditor(atom.workspace.getActiveTextEditor())
  },

}
export default module
module.addCommands() // TODO How to do this from package.json?
window.notebook = module // XXX dev

const notebookHydrogen = {

  notebooks: {},

  activate() {
    atom.workspace.observeTextEditors(editor => {
      if (!this.notebooks[editor.id]) {
        this.notebooks[editor.id] = new NotebookHydrogen(editor)
        editor.onDidDestroy(() => {
          delete this.notebooks[editor.id]
        })
      }
    })
  },

}

const notebookMarkdownImages = {

  _config: {
    scopes: ['text.md'],
  },

  markerLayers: {},

  activate() {
    atom.workspace.observeTextEditors(editor => {
      const markerLayer = editor.addMarkerLayer({maintainHistory: true, persistent: true})
      this.markerLayers[editor.id] = markerLayer.id
      if (this._config.scopes.includes(editor.getGrammar().scopeName)) {
        editor.onDidStopChanging(() => this.refreshEditor(editor))
        this.refreshEditor(editor)
      }
    })
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
            this.ensureUrlIsAbsolute(mdImageUrl, path.dirname(editor.buffer.file.path)),
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

class NotebookHydrogen {

  constructor(editor) {
    console.debug('NotebookHydrogen.constructor', editor)

    this.editor = editor
    this.markerLayer = this.editor.addMarkerLayer({maintainHistory: true, persistent: true})

    // If .ipynb:
    //  - Sync .ipynb.view -> .ipynb
    //  - Sync .ipynb -> .ipynb.view
    if (this.editor.buffer.file) {
      const editorPath = this.editor.buffer.file.path
      const ext = path.extname(editorPath)
      // TODO Think harder about if we want automatic two-way sync. Might be too error prone.
      // TODO Add more safeguards when overwriting files (e.g. prompt, but not all the time?)
      if (ext === '.ipynb') {

        // TODO Janky open: e.g. on reopen tab, reload window
        console.log('atom.workspace', atom.workspace) // XXX
        this.ipynbViewEditor = atom.workspace.open(`${editorPath}-view`, {
          searchAllPanes: true,
          split: 'right',
        }).then(ipynbViewEditor => {

          // TODO Fix atom.workspace.openSync error so we can init this.* sync instead of async
          this.ipynbViewEditor = ipynbViewEditor

          // Re-focus .ipynb editor
          const pane = atom.workspace.paneForItem(editor)
          pane.focus()
          pane.activateItem(editor)

          // Have to open .ipynb to get link with .ipynb-view
          const notebookPath = editorPath + '-view'
          this.editor.onDidStopChanging(() => {
            // TODO Janky guard to prevent infinite change loop between the two editors
            //  - Usually works, except if the user switches panes before 300ms
            if (this.editor === atom.workspace.getActiveTextEditor()) {
              console.debug('this.editor.onDidStopChanging')
              this.syncViewFromIpynb(this.ipynbViewEditor, this.editor)
            }
          })
          this.ipynbViewEditor.onDidStopChanging(() => {
            if (this.ipynbViewEditor === atom.workspace.getActiveTextEditor()) {
              console.debug('this.ipynbViewEditor.onDidStopChanging')
              this.syncViewToIpynb(this.ipynbViewEditor, this.editor)
            }
          })
          this.syncViewFromIpynb(this.ipynbViewEditor, this.editor)

        })

      }
    }

  }

  deleteAllResults() {
    this.markerLayer.clear()
  }

  deleteResultAtCursor() {
    this.deleteMarkersByFind({
      containsBufferPosition: this.editor.getCursorBufferPosition(),
    })
  }

  deleteMarkersInTheWayOfNewResults(range) {
    this.deleteMarkersByFind({startsInRange: range})
    this.deleteMarkersByFind({endsInRange: range})
  }

  deleteMarkersByFind(properties) {
    this.markerLayer.findMarkers(properties).forEach(marker => {
      marker.destroy()
    })
  }

  async runCodeSelection(options = {}) {
    return this.runCode(options, editor => {
      return editor.getSelectedBufferRange()
    })
  }

  async runCodeLine(options = {}) {
    return this.runCode(options, editor => {
      return editor.buffer.rangeForRow(editor.getCursorBufferPosition().row)
    })
  }

  async runCode(options, getRange) {
    const kernel = await this.ensureKernel()
    const range = rangeTrimTrailingNewline(this.editor.buffer, getRange(this.editor))
    const code = this.editor.buffer.getTextInRange(range)
    if (!code) return
    const resultReceiver = new NotebookHydrogenResultReceiver(options, this, this.editor, range)
    kernel.execute(code, result => resultReceiver.onKernelResult(result))
  }

  async ensureKernel() {
    if (!atom.packages.isPackageActive('Hydrogen')) {
      atom.packages.getLoadedPackage('Hydrogen').activateNow()
    }
    const { grammar, filePath, kernel } = hydrogen.store
    return new Promise((resolve, reject) => {
      if (!grammar) {
        reject('No grammar')
      } else if (!filePath) {
        reject('No filePath')
      } else if (kernel) {
        resolve(kernel)
      } else if (grammar.scopeName === 'source.js') {
        resolve(new AtomJsKernel())
      } else {
        hydrogen.kernelManager.startKernelFor(
          grammar,
          this.editor,
          filePath,
          kernel => resolve(kernel),
        )
      }
    })
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

          // TODO TODO Good start! -- keep iterating until jupyter can read it

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
      //  - hydrogen.store.kernelMapping.get(editor.buffer.file.path).kernelSpec
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

}

class NotebookHydrogenResultReceiver {

  // TODO TODO How to leave visual mode after enter? Can't clipboard since we need to have a range
  // TODO TODO How to restore decorations after delete/undo, cut/paste?
  // TODO TODO Cmds for motion (line, para, block)
  // TODO TODO Reuse ipython display (plots, dfs)

  // TODO TODO Render to pane instead of inline (if arg given, via e.g. alt keybinding)
  //  - elem.dispatchEvent(new MouseEvent('dblclick'))

  constructor(options, notebook, editor, range) {
    console.debug('NotebookHydrogenResultReceiver.constructor', options, notebook, editor, range)

    this.options = options

    this.hideOverlappingDecorations(range)
    notebook.deleteMarkersInTheWayOfNewResults(range)

    this.marker = notebook.markerLayer.markBufferRange(range, {
      class: 'notebook-marker',
      // TODO How to remove decoration when code is deleted but not when only partially modified?
      // invalidate: 'inside',
      // invalidate: 'never', // XXX Decoration sticks around after you delete the code line/block
      // invalidate: 'surround', // XXX Decoration still sticks around (like 'never')
      // invalidate: 'overlap', // TODO Decoration still sticks around in too many cases...
      invalidate: 'inside', // Too sensitive
      // invalidate: 'touch', // Too sensitive
    })
    // Clean up marker on invalidate
    // console.debug('Created marker', this.marker) // XXX
    this.marker.onDidChange(ev => {
      // console.debug(ev) // XXX
      if (!ev.isValid) {
        this.marker.destroy()
        // console.debug('Destroyed marker', this.marker) // XXX
      }
    })

    this.container = document.createElement('div')
    this.container.className = 'notebook-result-container'

    this.resultElem = document.createElement('div')
    this.resultElem.className = 'notebook-result pending'
    this.resultElem.hidden = true
    this.container.append(this.resultElem)

    this.rawResultsContainer = document.createElement('div')
    this.rawResultsContainer.className = 'notebook-raw-results-container'
    this.container.append(this.rawResultsContainer)

    this.resultLastTextElem = null
    this.dblclickElems = []

    this.pendingDecoration = editor.decorateMarker(this.marker, {
      type: 'highlight',
      class: 'notebook-code-pending',
    })
    this.resultDecoration = editor.decorateMarker(this.marker, {
      type: 'block',
      position: 'after',
      item: this.container,
    })
    this.resultDecoration._item = this.container // HACK Why isn't this retrievable?
    console.debug('marker', this.marker, this.resultDecoration) // XXX dev

  }

  hideOverlappingDecorations(range) {
    // TODO Is there a good way to do this more generally?
    //  - e.g. find and destroy all overlapping block decorations?
    // Hide autocomplete-plus suggestion list
    const {autocompleteManager} = atom.packages.getActivePackage('autocomplete-plus').mainModule
    autocompleteManager.hideSuggestionList()
  }

  onKernelResult(result) {
    console.debug('kernel.execute: result\n', result)

    this.rawResultElem = document.createElement('div')
    this.rawResultElem.className = 'notebook-raw-result'
    this.rawResultElem.dataset.result = JSON.stringify(result)
    this.rawResultsContainer.append(this.rawResultElem)

    this.normalizeKernelResult(result)

    if (result.stream === 'execution_count') {
      // Ignored, e.g. `Out[${result.data}]`
    } else if (result.output_type === 'stream') {
      this.resultAppendText(result.text) // lineColor = result.name === 'stderr' ? ...
    } else if (['execute_result', 'display_data'].includes(result.output_type)) {
      this.resultEnsureNewline()
      if (false) {
      } else if (result.data['text/html'] && !notebook._config.skipHtml) {
        this.resultAppendElementsFromHtml(result.data['text/html'], {
          textForClipboardCopy: result.data['text/plain']
        })
      } else if (result.data['image/svg+xml']) {
        this.resultAppendSvgFromXml(result.data['image/svg+xml'])
      } else if (result.data['image/png']) {
        this.resultAppendImgFromSrc(`data:image/png;base64,${result.data['image/png']}`)
      } else if (result.data['image/jpeg']) {
        this.resultAppendImgFromSrc(`data:image/jpeg;base64,${result.data['image/jpeg']}`)
      } else {
        this.resultAppendText(result.data['text/plain'] || '')
      }
      window.container = this.container // XXX dev
      window.resultElem = this.resultElem // XXX dev
      window.result = result // XXX dev
    } else if (result.output_type === 'error') {
      result.traceback.forEach(line => {
        if (!line.endsWith('\n')) line += '\n' // (e.g. ipykernel does, ijskernel doesn't)
        this.resultAppendText(line)
      })
    } else if (result.stream === 'status' && result.data == 'ok') {
      if (this.options.inpane) this.openDblclickElemsInPanes()
      this.resultElem.classList.remove('pending')
      this.resultElem.classList.add('ok')
      this.pendingDecoration.destroy()
      if (this.resultElem.hidden) this.marker.destroy()
    } else if (result.stream === 'status' && result.data == 'error') {
      if (this.options.inpane) this.openDblclickElemsInPanes()
      this.resultElem.classList.remove('pending')
      this.resultElem.classList.add('error')
      this.pendingDecoration.destroy()
    }

  }

  normalizeKernelResult(result) {
    // result.data[k] : string | list[string] -> string
    if (result.data) {
      Object.keys(result.data).forEach(k => {
        result.data[k] = joinIfArray(result.data[k])
      })
    }
    // result.text : string | list[string] -> string
    if (result.text) {
      result.text = joinIfArray(result.text)
    }
  }

  resultEnsureNewline() {
    if (this.resultLastTextElem && !this.resultLastTextElem.textContent.endsWith('\n')) {
      this.resultAppendText('\n')
    }
  }

  resultAppendText(text) {
    if (text) {
      if (!this.resultLastTextElem) {
        const textElem = document.createElement('div')
        textElem.classList.add('notebook-result-text')
        textElem.onclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
            // cmd-click -> copy
            clipboard.writeText(textElem.textContent)
            atom.notifications.addSuccess('Copied to clipboard (text)')
          }
        }
        this.dblclickElems.push(textElem)
        textElem.ondblclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
            // dblclick -> open in new tab
            this.resultOpenInPane({
              data: textElem.textContent,
              prefix: 'notebook-text-',
              suffix: '.txt',
            })
          }
        }
        this.resultAppend(textElem)
        this.resultLastTextElem = textElem
      }
      text = stripAnsi(text) // TODO Map ansi colors to css (https://github.com/chalk/chalk)
      this.resultLastTextElem.append(document.createTextNode(text))
    }
  }

  resultAppendElementsFromHtml(html, {textForClipboardCopy}) {
    const elems = elementsFromHtml(html)
    this.resultAppend(...elems)
    if (textForClipboardCopy) {
      elems.forEach((elem) => {
        elem.onclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
            // cmd-click -> copy
            clipboard.writeText(textForClipboardCopy)
            atom.notifications.addSuccess('Copied to clipboard (text for html)')
          }
        }
        this.dblclickElems.push(elem)
        elem.ondblclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
            // dblclick -> open in new tab
            this.resultOpenInPane({
              data: textForClipboardCopy,
              prefix: 'notebook-html-',
              suffix: '.txt',
            })
          }
        }
      })
    }
  }

  resultAppendSvgFromXml(svgXml) {
    const elements = elementsFromHtml(svgXml)
    const parent = this.resultAppend(...elements)
    Array.from(parent.getElementsByTagName('svg')).forEach((svg) => {
      svg.onclick = (ev) => {
        if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
          // cmd-click -> copy
          svgToPngDataUrl(svg).then((pngDataUrl) => {
            clipboardCopyImageFromDataURL(pngDataUrl)
            atom.notifications.addSuccess('Copied to clipboard (png from svg)')
          })
        }
      }
      this.dblclickElems.push(svg)
      svg.ondblclick = (ev) => {
        if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
          // dblclick -> open in new tab
          this.resultOpenInPane({
            data: svg.outerHTML,
            prefix: 'notebook-svg-',
            suffix: '.svg',
          })
        }
      }
    })
  }

  resultAppendImgFromSrc(src) {
    const img = document.createElement('img')
    img.src = src
    img.onclick = (ev) => {
      if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
        // cmd-click -> copy
        clipboardCopyImg(img)
        atom.notifications.addSuccess('Copied to clipboard (image)')
      }
    }
    this.dblclickElems.push(img)
    img.ondblclick = (ev) => {
      if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        // dblclick -> open in new tab
        if (!src.startsWith('data:image/png;')) {
          // TODO Map src data url to NativeImage.to* + file suffix
          throw `Expected 'data:image/png', got src[${src.slice(0, 50)}...]`
        }
        this.resultOpenInPane({
          data: nativeImage.createFromDataURL(img.src).toPng(),
          prefix: 'notebook-img-',
          suffix: '.png',
        })
      }
    }
    this.resultAppend(img)
  }

  resultAppend(...elements) {
    if (!this.options.inpane) this.resultElem.hidden = false
    this.resultElem.append(...elements)
    this.resultLastTextElem = null
    return this.resultElem
  }

  async resultOpenInPane({data, prefix, suffix}) {
    const tmpPath = mktemp({prefix, suffix})
    fs.writeFileSync(tmpPath, data)
    await atom.workspace.open(tmpPath) // [TODO atom.workspace.openSync is broken]
    // TODO Package these commands up so we can declare a package dependency on them
    atom.commands.dispatch(atom.workspace.element, 'user:window-move-active-item-to-pane-on-right')
    atom.commands.dispatch(atom.workspace.element, 'user:window-focus-pane-on-left')
  }

  async openDblclickElemsInPanes() {
    for (const elem of this.dblclickElems) {
      await elem.dispatchEvent(new MouseEvent('dblclick'))
    }
  }

}

//
// XXX Danger
//

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

