'use babel';

//
// XXX Danger
//

// Import atom internal modules
const ScopeDescriptor = require(`${atom.packages.resourcePath}/src/scope-descriptor`)
const TokenizedBuffer = require(`${atom.packages.resourcePath}/src/tokenized-buffer`)

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
