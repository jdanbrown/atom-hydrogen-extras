'use babel'

import clipboard from 'clipboard'
import {app, nativeImage} from 'electron'
import fs from 'fs'
import path from 'path'
import vm from 'vm'

const chance = require(`${atom.configDirPath}/packages/random/node_modules/chance`).Chance()
const hydrogen = {
  main: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/main`),
  store: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/store`).default,
  kernelManager: require(`${atom.packages.resolvePackagePath('Hydrogen')}/lib/kernel-manager`).default,
}
const stripAnsi = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/strip-ansi`);

const packageName = 'dan-notebook-v0'

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

const notebook = {

  config: {
    scopes: {
      type: 'array',
      items: {type: 'string'},
      default: ['text.md'],
    },
  },

  // For dev
  skipHtml: false,

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
    const resultElem = document.createElement('div')
    resultElem.className = 'notebook-result pending'
    resultElem.hidden = true
    container.append(resultElem)
    let resultLastTextElem = null

    function resultShow() {
      resultElem.hidden = false
    }

    function resultAppend(...elements) {
      resultShow()
      resultElem.append(...elements)
      resultLastTextElem = null
      return resultElem
    }

    async function resultOpenInPane({data, prefix, suffix}) {
      const tmpPath = mktemp({prefix, suffix})
      fs.writeFileSync(tmpPath, data)
      await atom.workspace.open(tmpPath)
      // TODO Package these commands up so we can declare a package dependency on them
      atom.commands.dispatch(atom.workspace.element, 'user:window-move-active-item-to-pane-on-right')
      atom.commands.dispatch(atom.workspace.element, 'user:window-focus-pane-on-left')
    }

    function resultAppendElementsFromHtml(html, {textForClipboardCopy}) {
      const elems = elementsFromHtml(html)
      resultAppend(...elems)
      if (textForClipboardCopy) {
        elems.forEach((elem) => {
          elem.onclick = (ev) => {
            if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
              // cmd-click -> copy
              clipboard.writeText(textForClipboardCopy)
              atom.notifications.addSuccess('Copied to clipboard (text for html)')
            }
          }
          elem.ondblclick = (ev) => {
            if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
              // dblclick -> open in new tab
              resultOpenInPane({
                data: textForClipboardCopy,
                prefix: 'notebook-html-',
                suffix: '.txt',
              })
            }
          }
        })
      }
    }

    function resultAppendText(text) {
      if (text) {
        if (!resultLastTextElem) {
          const textElem = document.createElement('div')
          textElem.classList.add('notebook-result-text')
          textElem.onclick = (ev) => {
            if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
              // cmd-click -> copy
              clipboard.writeText(textElem.textContent)
              atom.notifications.addSuccess('Copied to clipboard (text)')
            }
          }
          textElem.ondblclick = (ev) => {
            if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
              // dblclick -> open in new tab
              resultOpenInPane({
                data: textElem.textContent,
                prefix: 'notebook-text-',
                suffix: '.txt',
              })
            }
          }
          resultAppend(textElem)
          resultLastTextElem = textElem
        }
        text = stripAnsi(text) // TODO Map ansi colors to css (https://github.com/chalk/chalk)
        resultLastTextElem.append(document.createTextNode(text))
      }
    }

    function resultAppendImgFromSrc(src) {
      const img = document.createElement('img')
      img.src = src
      img.onclick = (ev) => {
        if (!ev.altKey && !ev.ctrlKey && ev.metaKey && !ev.shiftKey) {
          // cmd-click -> copy
          clipboardCopyImg(img)
          atom.notifications.addSuccess('Copied to clipboard (image)')
        }
      }
      img.ondblclick = (ev) => {
        if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
          // dblclick -> open in new tab
          if (!src.startsWith('data:image/png;')) {
            // TODO Map src data url to NativeImage.to* + file suffix
            throw `Expected 'data:image/png', got src[${src.slice(0, 50)}...]`
          }
          resultOpenInPane({
            data: nativeImage.createFromDataURL(img.src).toPng(),
            prefix: 'notebook-img-',
            suffix: '.png',
          })
        }
      }
      resultAppend(img)
    }

    function resultAppendSvgFromXml(svgXml) {
      const elements = elementsFromHtml(svgXml)
      const parent = resultAppend(...elements)
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
        svg.ondblclick = (ev) => {
          if (!ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
            // dblclick -> open in new tab
            resultOpenInPane({
              data: svg.outerHTML,
              prefix: 'notebook-svg-',
              suffix: '.svg',
            })
          }
        }
      })
    }

    function resultEnsureNewline() {
      if (resultLastTextElem && !resultLastTextElem.textContent.endsWith('\n')) {
        resultAppendText('\n')
      }
    }

    const pendingDecoration = editor.decorateMarker(marker, {
      type: 'highlight',
      class: 'notebook-code-pending',
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
        // Ignored, e.g. `Out[${result.data}]`
      } else if (result.output_type === 'stream') {
        resultAppendText(result.text) // lineColor = result.name === 'stderr' ? ...
      } else if (['execute_result', 'display_data'].includes(result.output_type)) {
        resultEnsureNewline()
        if (false) {
        } else if (result.data['text/html'] && !this.skipHtml) {
          resultAppendElementsFromHtml(result.data['text/html'], {
            textForClipboardCopy: result.data['text/plain']
          })
        } else if (result.data['image/svg+xml']) {
          resultAppendSvgFromXml(result.data['image/svg+xml'])
        } else if (result.data['image/png']) {
          resultAppendImgFromSrc(`data:image/png;base64,${result.data['image/png']}`)
        } else if (result.data['image/jpeg']) {
          resultAppendImgFromSrc(`data:image/jpeg;base64,${result.data['image/jpeg']}`)
        } else {
          resultAppendText(result.data['text/plain'] || '')
        }
        window.container = container // XXX
        window.resultElem = resultElem // XXX
        window.result = result // XXX
      } else if (result.output_type === 'error') {
        result.traceback.forEach(line => {
          if (!line.endsWith('\n')) line += '\n' // (e.g. ipykernel does, ijskernel doesn't)
          resultAppendText(line)
        })
      } else if (result.stream === 'status' && result.data == 'ok') {
        resultElem.classList.remove('pending')
        resultElem.classList.add('ok')
        pendingDecoration.destroy()
        if (resultElem.hidden) marker.destroy()
      } else if (result.stream === 'status' && result.data == 'error') {
        resultElem.classList.remove('pending')
        resultElem.classList.add('error')
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

  // XXX For dev
  hydrogen,
  // XXX

}

// XXX For dev
window.nb = notebook
// XXX

atom.commands.add('atom-workspace', {
  'dan-notebook-v0:run-code-selection': ev => notebook.runCodeSelection(),
  'dan-notebook-v0:run-code-line': ev => notebook.runCodeLine(),
  'dan-notebook-v0:delete-result-at-cursor': ev => notebook.deleteResultAtCursor(),
  'dan-notebook-v0:delete-all-results': ev => notebook.deleteAllResults(),
})

export default notebook
