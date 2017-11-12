'use babel'

import path from 'path'

const packageName = 'dan-notebook-v0'

const config = {
  scopes: {
    type: 'array',
    items: {type: 'string'},
    default: ['text.md'],
  },
  imageContainerStyle: {
    type: 'string',
    default: 'text-align: center; padding: 5px; display: none;',
  },
  imageStyle: {
    type: 'string',
    default: 'max-width: 100%;',
  },
}

export default {

  config,

  activate() {
    atom.workspace.observeTextEditors((editor) => {
      if (atom.config.get(`${packageName}.scopes`).includes(editor.getGrammar().scopeName)) {
        editor.onDidStopChanging(this.processTextBuffer.bind(null, editor))
        this.processTextBuffer(editor)
      }
    })
  },

  processTextBuffer(editor) {

    const validMarkers = []
    editor.findMarkers({class: `${packageName}-image`}).forEach((marker) => {
      if (!marker.isValid()) {
        marker.destroy()
      } else {
        validMarkers.push(marker)
      }
    })

    // Extract markdown images
    return editor.scan(/!\[[^\]\n]*\]\(([^)\n]+)\)/g, (mdImage) => {
      let url = mdImage.match[1]

      const isMarked = !!validMarkers.find((marker) => {
        return mdImage.computedRange.start.row == marker.getBufferRange().start.row
      })
      if (!isMarked) {

        // Ensure url is absolute
        if (!isNetworkPath(url) && !path.isAbsolute(url)) {
          url = path.join(path.dirname(editor.buffer.file.path), url)
        }

        const imageContainer = document.createElement('div')
        imageContainer.style = atom.config.get(`${packageName}.imageContainerStyle`)

        const image = document.createElement('img')
        image.style = atom.config.get(`${packageName}.imageStyle`)
        image.src = url
        image.onload = () => imageContainer.style.display = 'block'
        imageContainer.appendChild(image)

        const marker = editor.markBufferRange(mdImage.computedRange, {
          class: `${packageName}-image`,
          invalidate: 'inside',
        })

        return editor.decorateMarker(marker, {
          item: imageContainer,
          type: 'block',
          position: 'after',
        })

      }

    })
  },

}

function isNetworkPath(path) {
  return /^(?:[a-z]+:)?\/\//i.test(path)
}
