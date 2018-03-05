'use babel'

const {CompositeDisposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);

const {packageName} = require('./util');

// Old markdown thing, still useful as an example if nothing else
export const markdownNotebooks = {

  _config: {
    scopes: ['text.md'],
  },

  disposables: null,
  markerLayers: new Map(), // TextEditor -> DisplayMarkerLayer

  activate() {
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      atom.workspace.observeTextEditors(editor => {
        if (!this.markerLayers.has(editor)) {
          const markerLayer = editor.addMarkerLayer({maintainHistory: true, persistent: true});
          // warnIfTextEditorIdsAreNotUnique(); // XXX if the switch from editor.id -> editor worked...
          this.markerLayers.set(editor, markerLayer);
          this.disposables.add(
            editor.onDidDestroy(() => this.markerLayers.delete(editor)),
          );
          if (this._config.scopes.includes(editor.getGrammar().scopeName)) {
            this.disposables.add(
              editor.onDidStopChanging(() => this.refreshEditor(editor)),
            );
            this.refreshEditor(editor);
          }
        }
      })
    );
  },

  deactivate() {
    this.disposables.dispose();
  },

  refreshEditor(editor) {

    // Decorate markdown images: ![...](url)
    editor.scan(/!\[[^\]\n]*\]\(([^)\n]+)\)/g, mdImage => {
      const mdImageUrl = mdImage.match[1];

      // If not already decorated
      const decorations = editor.findMarkers({
        class: `${packageName}-image`,
        containsBufferPosition: mdImage.range.start,
      });
      if (decorations.length === 0) {

        // Make marker + decoration
        const marker = editor.markBufferRange(mdImage.range, {
          class: `${packageName}-image`,
          invalidate: 'inside',
        });
        editor.decorateMarker(marker, {
          type: 'block',
          position: 'after',
          item: this.imageDecoration(
            this.ensureUrlIsAbsolute(mdImageUrl, path.dirname((editor.buffer.file || {}).path)),
          ),
        });

        // Clean up marker on invalidate
        marker.onDidChange(ev => {
          if (!ev.isValid) {
            marker.destroy();
          }
        });

      }
    });
  },

  imageDecoration(imageUrl) {
    const div = document.createElement('div');
    div.className = 'notebook-result-container';
    const img = document.createElement('img');
    img.className = 'notebook-result';
    img.src = imageUrl;
    div.append(img);
    return div;
  },

  ensureUrlIsAbsolute(url, relativeToDir) {
    if (/^[a-zA-Z][-a-zA-Z0-9+.]*:/.test(path)) {
      return url;
    } else {
      return path.resolve(relativeToDir, url); // Noop if url is absolute path
    }
  },

}
