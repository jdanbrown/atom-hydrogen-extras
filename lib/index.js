'use babel'

import path from 'path'

const stripAnsi = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/strip-ansi`);
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
}

const packageName = 'dan-notebook-v0'

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
      } else {
        hydrogen.kernelManager.startKernelFor(grammar, editor, filePath, kernel => resolve(kernel))
      }
    })
  },

  // TODO TODO How to restore decorations after delete/undo, cut/paste?
  // TODO TODO Cmds for motion (line, para, block)
  // TODO TODO Reuse ipython display (plots, dfs)
  async runCodeLine() {
    const editor = atom.workspace.getActiveTextEditor()
    const kernel = await this.ensureKernel(editor)
    const range = editor.buffer.rangeForRow(editor.getCursorBufferPosition().row)
    const code = editor.buffer.getTextInRange(range)
    if (!code) return
    this.deleteMarkersByFind(editor, {
      startBufferPosition: range.start,
      endBufferPosition: range.end,
    })
    const marker = this.markerLayer(editor).markBufferRange(range, {
      class: 'notebook-marker',
      invalidate: 'inside',
    })
    // Clean up marker on invalidate
    console.log('Created marker', marker)
    marker.onDidChange(ev => {
      console.log(ev)
      if (!ev.isValid) {
        marker.destroy()
        console.log('Destroyed marker', marker)
      }
    })
    const container = document.createElement('div')
    container.className = 'notebook-result-container'
    let output = null
    function outputAppend(text) {
      if (!output) {
        output = document.createElement('div')
        output.className = 'notebook-result'
        container.appendChild(output)
      }
      output.textContent += text
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
    kernel.execute(code, result => {
      console.log('result', result)
      if (result.stream === 'execution_count') {
        // outputAppend(`Out[${result.data}]`)
      } else if (result.output_type === 'stream') {
        outputAppend(result.text) // lineColor = result.name === 'stderr' ? ...
      } else if (result.output_type === 'execute_result') {
        if (output && output.textContent && !output.textContent.endsWith('\n')) {
          outputAppend('\n')
        }
        outputAppend(result.data['text/plain'])
      } else if (result.output_type === 'error') {
        result.traceback.forEach(line => {
          outputAppend(stripAnsi(line)) // Map to css? https://github.com/chalk/chalk
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
  'dan-notebook-v0:run-code-line': ev => notebook.runCodeLine(),
  'dan-notebook-v0:delete-result-at-cursor': ev => notebook.deleteResultAtCursor(),
  'dan-notebook-v0:delete-all-results': ev => notebook.deleteAllResults(),
})

export default notebook
