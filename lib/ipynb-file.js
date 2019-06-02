'use babel'

import {File} from 'atom';
import assert from 'assert';
import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
const {CompositeDisposable, Disposable} = require(`${atom.packages.resolvePackagePath('pigments')}/node_modules/event-kit`);

const {cloneClass, readableString, writableString} = require('./util');

// TODO Try using again? I fixed the confounding bugs, and they weren't due to FileLike.
// Reuse implementation without subtyping
//  - ipynbPyFile needs to act like a File without `x instanceof File` being true, since TextBuffer
//    switches behavior based on that (ugh, leaky abstractions)
export const FileLike = cloneClass(File);

// A File-like object for TextBuffer.setFile
//  - References:
//    - https://github.com/atom/text-buffer/blob/56a61d9/src/text-buffer.coffee#L573
//    - https://github.com/atom/node-pathwatcher/blob/master/src/file.coffee
// export class IpynbPyFile extends FileLike { // TODO
export class IpynbPyFile {

  // API expected by TextBuffer:
  //  - getPath()
  //  - createReadStream()
  //  - createWriteStream()
  //  - existsSync()
  //  - onDidChange(f)
  //  - onDidDelete(f)
  //  - onDidRename(f)

  constructor(ipynbSync) {
    // super(ipynbSync.editor.buffer.file.path); // TODO
    this.ipynbSync = ipynbSync;
    this.buffer = ipynbSync.editor.buffer;
    this.file = this.buffer.file; // The file we are a facade over
    this.path = this.file.path; // Many things rely on this (e.g. hydrogen, FileLike)
    console.debug('IpynbPyFile.constructor', {editor: this.ipynbSync.editor.id}); // XXX dev
  }

  // Noop or passthru most of our behavior when our .file is already a IpynbPyFile
  //  - This happens when you clone an .ipynb pane, or open the same file in multiple panes
  //  - Without this guard, various behaviors go wonky and break
  get isProxy() {
    return this.file instanceof IpynbPyFile;
  }

  // Install self as this.buffer.file
  //  - Uninstall on .dispose()
  //  - Called by IpynbSync
  async start() {
    // console.debug('IpynbPyFile.start'); // XXX dev
    if (this.isProxy) {
      return new Disposable(async () => {}); // Noop
    } else {
      await this.toggle(true);
      this.buffer.clearUndoStack(); // So that undo doesn't revert .py -> .ipynb
      return new Disposable(async () => {
        await this.toggle(false);
      });
    }
  }

  // Install/uninstall self as this.buffer.file
  //  - Called by this.start
  async toggle(on = null) {
    console.debug(`IpynbPyFile.toggle(${on})`, {buffer: this.buffer.id}); // XXX dev
    if (!this.isProxy) {
      // TODO Toggle based on buffer contents, not file contents, so we don't have to block on
      // isModified, which isn't 100% safe to have to do (e.g. package deactivate->activate -> errors)
      if (this.buffer.isModified() && !this.buffer.isEmpty()) {
        atom.notifications.addWarning("Can't toggle, is modified");
      } else {
        const curr = this.buffer.file !== this.file;
        on = on !== null ? on : !curr;
        console.debug(`IpynbPyFile.toggle: ${curr} -> ${on}`); // XXX dev
        // Have to .setFile(null) first, since .setFile(file) noops if file.getPath() is the same as the
        // buffer's existing file.getPath()
        this.buffer.setFile(null);
        this.buffer.setFile(on ? this : this.file);
        await this.buffer.reload(); // Else buffer contents don't update to reflect setFile
      }
    }
  }

  // Name this readIpynbSourceSync() i/o readSync(), to avoid confusion between .py vs. .ipynb
  readIpynbSourceSync() {
    return this.isProxy ? this.file.readIpynbSourceSync() : this.file.readSync();
  }

  // Name this writeIpynbSourceSync() i/o writeSync(), to avoid confusion between .py vs. .ipynb
  writeIpynbSourceSync(text) {
    return this.isProxy ? this.file.writeIpynbSourceSync(text) : this.file.writeSync(text);
  }

  // A stream.Readable that can be used to load the file's content
  //  - Called by TextBuffer
  createReadStream() {
    console.debug('IpynbPyFile.createReadStream'); // XXX dev
    // XXX Don't proxy
    // if (this.isProxy) {
    //   return this.file.createReadStream();
    // } else {
      const ipynbSource = this.readIpynbSourceSync();
      const pySource = this.ipynbSync.getPyFromIpynbSource(ipynbSource);
      return readableString(pySource, {encoding: 'utf8'});
    // }
  }

  // A stream.Writable that can be used to save content to the file
  //  - Called by TextBuffer
  createWriteStream() {
    console.debug('IpynbPyFile.createWriteStream', {editor: this.ipynbSync.editor.id}); // XXX dev
    // XXX Don't proxy
    // if (this.isProxy) {
    //   return this.file.createWriteStream();
    // } else {
      return writableString({encoding: 'utf8', onFinish: pySource => {
        // console.debug('IpynbPyFile.createWriteStream: onFinish'); // XXX dev
        // We're going to read straight from this.buffer and ignore pySource, so make sure they match
        assert.equal(pySource, this.buffer.getText());
        // Get .ipynb from the .py buffer, since it has to read both .py source and notebook outputs
        const ipynbSource = this.ipynbSync.getIpynbFromPyEditor();
        this.writeIpynbSourceSync(ipynbSource);
      }});
    // }
  }

  // Unsupported methods, to avoid confusion between .py vs. ipynb
  //  - See above
  // readSync()      { ... }
  // writeSync(text) { ... }

  // Delegation methods
  // get path    ()  { return this.file.path; } // Sticking with the above: this.path = this.file.path
  getPath     ()  { return this.file.getPath(); }
  getParent   ()  { return this.file.getParent(); }
  existsSync  ()  { return this.file.existsSync(); }
  onDidChange (f) { return this.file.onDidChange(f); }
  onDidDelete (f) { return this.file.onDidDelete(f); }
  onDidRename (f) { return this.file.onDidRename(f); }

}
