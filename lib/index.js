'use babel'

import path from 'path'
import vm from 'vm'

const stripAnsi = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/strip-ansi`);
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
}

const packageName = 'dan-notebook-v0'

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

const notebook = {

  config: {
    scopes: {
      type: 'array',
      items: {type: 'string'},
      default: ['text.md'],
    },
  },

  markerLayers: {},

  activate() {
    atom.workspace.observeTextEditors(editor => {

      const markerLayer = editor.addMarkerLayer({maintainHistory: true, persistent: true})
      this.markerLayers[editor.id] = markerLayer.id

      if (atom.config.get(`${packageName}.scopes`).includes(editor.getGrammar().scopeName)) {
        editor.onDidStopChanging(() => this.refreshEditor(editor))
        this.refreshEditor(editor)
      }

    })
  },

  markerLayer(editor) {
    return editor.getMarkerLayer(this.markerLayers[editor.id])
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
    div.appendChild(img)
    return div
  },

  ensureUrlIsAbsolute(url, relativeToDir) {
    if (/^[a-zA-Z][-a-zA-Z0-9+.]*:/.test(path)) {
      return url
    } else {
      return path.resolve(relativeToDir, url) // Noop if url is absolute path
    }
  },

  async ensureKernel(editor) {
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
        hydrogen.kernelManager.startKernelFor(grammar, editor, filePath, kernel => resolve(kernel))
      }
    })
  },

  trimRangeTrailingNewline(buffer, range) {
    while (buffer.getTextInRange(range).endsWith('\n')) {
      range = range.translate(
        [0, 0],
        [-1, buffer.rangeForRow(range.end.row - 1).end.column],
      )
    }
    return range
  },

  async runCodeSelection() {
    return this.runCode(editor => {
      return editor.getSelectedBufferRange()
    })
  },

  async runCodeLine() {
    return this.runCode(editor => {
      return editor.buffer.rangeForRow(editor.getCursorBufferPosition().row)
    })
  },

  // TODO TODO How to leave visual mode after enter? Can't clipboard since we need to have a range
  // TODO TODO How to restore decorations after delete/undo, cut/paste?
  // TODO TODO Cmds for motion (line, para, block)
  // TODO TODO Reuse ipython display (plots, dfs)
  async runCode(getRange) {
    const editor = atom.workspace.getActiveTextEditor()
    const kernel = await this.ensureKernel(editor)
    const range = this.trimRangeTrailingNewline(editor.buffer, getRange(editor))
    const code = editor.buffer.getTextInRange(range)
    if (!code) return
    this.deleteMarkersForRunCode(editor, range)
    const marker = this.markerLayer(editor).markBufferRange(range, {
      class: 'notebook-marker',
      invalidate: 'inside',
    })
    // Clean up marker on invalidate
    // console.debug('Created marker', marker) // XXX
    marker.onDidChange(ev => {
      // console.debug(ev) // XXX
      if (!ev.isValid) {
        marker.destroy()
        // console.debug('Destroyed marker', marker) // XXX
      }
    })
    const container = document.createElement('div')
    container.className = 'notebook-result-container'
    let output = null
    function outputEnsureExists() {
      if (!output) {
        output = document.createElement('div')
        output.className = 'notebook-result'
        container.appendChild(output)
      }
    }
    function outputAppendElement(element) {
      outputEnsureExists()
      output.appendChild(element)
    }
    function outputAppendHtmlString(htmlString) {
      outputEnsureExists()
      output.innerHTML += htmlString
    }
    function outputAppendImage(src) {
      const img = document.createElement('img')
      img.src = src
      outputAppendElement(img)
      outputAppendHtmlString('&nbsp;') // FIXME Otherwise the decoration appears and immediately disappears. Maybe an atom bug?
    }
    function outputAppendText(text) {
      outputAppendElement(document.createTextNode(text))
    }
    const pendingDecoration = editor.decorateMarker(marker, {
      type: 'highlight',
      class: 'notebook-pending',
    })
    const resultDecoration = editor.decorateMarker(marker, {
      type: 'block',
      position: 'after',
      item: container,
    })
    this.hideOverlappingDecorations()
    kernel.execute(code, result => {
      console.debug('kernel.execute: result\n', result)
      if (result.stream === 'execution_count') {
        // outputAppendText(`Out[${result.data}]`)
      } else if (result.output_type === 'stream') {
        outputAppendText(result.text) // lineColor = result.name === 'stderr' ? ...
      } else if (['execute_result', 'display_data'].includes(result.output_type)) {
        if (output && output.textContent && !output.textContent.endsWith('\n')) {
          outputAppendText('\n')
        }
        if (false) {
        // Default 'text/html' for df is crap. No default 'text/html' for ggplot.
        //  - TODO Have to do more jupyter stuff on the python side?
        // } else if (result.data['text/html']) {
        //   outputAppendHtmlString(result.data['text/html'])
        } else if (result.data['image/png']) {
          const src = `data:image/png;base64,${result.data['image/png']}`
          // const src = 'https://s.gravatar.com/avatar/5f18d2a1e05c3fdb7ccbd5c72cc001f6?size=100&default=retro'
          outputAppendImage(src)
        } else {
          outputAppendText(result.data['text/plain'] || '')
        }
        // XXX
        window.container = container
        window.output = output
        window.result = result
        // XXX
      } else if (result.output_type === 'error') {
        result.traceback.forEach(line => {
          line = stripAnsi(line) // TODO Map ansi colors to css (https://github.com/chalk/chalk)
          if (!line.endsWith('\n')) line += '\n' // (e.g. ipykernel does, ijskernel doesn't)
          outputAppendText(line)
        })
      } else if (result.stream === 'status' && result.data == 'ok') {
        output && output.classList.add('ok')
        pendingDecoration.destroy()
        if (!output || !output.textContent) {
          marker.destroy()
        }
      } else if (result.stream === 'status' && result.data == 'error') {
        output && output.classList.add('error')
        pendingDecoration.destroy()
      }
    })
  },

  deleteMarkersForRunCode(editor, range) {
    this.deleteMarkersByFind(editor, {startsInRange: range})
    this.deleteMarkersByFind(editor, {endsInRange: range})
  },

  deleteResultAtCursor() {
    const editor = atom.workspace.getActiveTextEditor()
    this.deleteMarkersByFind(editor, {
      containsBufferPosition: editor.getCursorBufferPosition(),
    })
  },

  deleteMarkersByFind(editor, properties) {
    this.markerLayer(editor).findMarkers(properties).forEach(marker => {
      marker.destroy()
    })
  },

  deleteAllResults() {
    const editor = atom.workspace.getActiveTextEditor()
    this.markerLayer(editor).clear()
  },

  hideOverlappingDecorations() {
    // TODO Is there a good way to do this more generally?
    //  - e.g. find and destroy all overlapping block decorations?
    // Hide autocomplete-plus suggestion list
    const {autocompleteManager} = atom.packages.getActivePackage('autocomplete-plus').mainModule
    autocompleteManager.hideSuggestionList()
  },

  // pymdExecuteResultDecoration(result) {
  //   const div = document.createElement('div')
  //   div.className = 'notebook-result-container'
  //   const pre = document.createElement('pre')
  //   pre.className = 'notebook-result'
  //   pre.textContent = `\n${result.data['text/plain']}\n`
  //   div.appendChild(pre)
  //   return div
  // },

  // XXX For dev
  hydrogen,
  // XXX

}

// XXX For dev
window.notebook = notebook
window.nb = notebook
// XXX

atom.commands.add('atom-workspace', {
  'dan-notebook-v0:run-code-selection': ev => notebook.runCodeSelection(),
  'dan-notebook-v0:run-code-line': ev => notebook.runCodeLine(),
  'dan-notebook-v0:delete-result-at-cursor': ev => notebook.deleteResultAtCursor(),
  'dan-notebook-v0:delete-all-results': ev => notebook.deleteAllResults(),
})

export default notebook
