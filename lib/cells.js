'use babel'

import {Point, Range} from 'atom'
import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
export const {findInEditor, scanEditor} = require(`${atom.packages.resolvePackagePath('vim-mode-plus')}/lib/utils`);
window.findInEditor = findInEditor; // XXX
window.scanEditor = scanEditor; // XXX

// Special API for more-vim-mode-plus MoveToNextCell (Motion)
// previous:
//  - Map first char in cell to first char of previous cell
//  - Map non-first chars in cell to its first char
// next:
//  - Map all chars in cell to first char of next cell
export function nextCodeChunkDelimInDirection(type, editor, direction, from) {
  return codeChunkFindInEditor(type, editor, {direction, from}, ({range}) => {
    // 1+row to skip the leading blank line [assumes delims start with blank line]
    return editor.clipBufferPosition(range.start.translate({row: 1}));
  });
}
window.nextCodeChunkDelimInDirection = nextCodeChunkDelimInDirection // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['next', 'previous'].forEach(direction => ['para', 'cell'].forEach(type => [0,1,2,3,4].forEach(row => console.log(type, direction, row, nextCodeChunkDelimInDirection(type, editor, direction, [row,0])))))
*/

// previous:
//  - Map first char in cell to itself
//  - Map non-first chars in cell to its first char
// next:
//  - Map all chars in cell to first char of next cell
export function enclosingCodeChunkDelimInDirection(type, editor, direction, from) {
  if (direction === 'previous') {
    // Offset by +1 to avoid mapping to the previous cell
    from = editor.clipBufferPosition(Point.fromObject(from).translate({row: 1}));
  }
  return nextCodeChunkDelimInDirection(type, editor, direction, from) || getLastResortPoint(editor, direction);
}
window.enclosingCodeChunkDelimInDirection = enclosingCodeChunkDelimInDirection // XXX dev

// Special API for more-vim-mode-plus Cell (TextObject)
export function codeChunkContainingPoint(type, editor, point) {
  // const pointPlusOne = editor.clipBufferPosition(Point.fromObject(point).translate({row: 1}));
  // const prevDelim = nextCodeChunkDelimInDirection(type, editor, 'previous', pointPlusOne) || getLastResortPoint(editor, 'previous');
  // const nextDelim = nextCodeChunkDelimInDirection(type, editor, 'next', point) || getLastResortPoint(editor, 'next');
  const prevDelim = enclosingCodeChunkDelimInDirection(type, editor, 'previous', point);
  const nextDelim = enclosingCodeChunkDelimInDirection(type, editor, 'next', point);
  return Range(
    prevDelim,
    nextDelim.translate({row: nextDelim.row === editor.getLastBufferRow() ? 0 : -1}), // Assumes delims start with blank line
  );
}

// [Used by HydrogenNotebook.updateCellDecorations]
// [Used by IpynbSync.syncViewFromIpynb]
export function allCodeChunks(type, editor) {
  const delims = codeChunkDelims(type, editor);
  const first = editor.buffer.getFirstPosition();
  const last = editor.buffer.getEndPosition();
  delims.unshift(Range.fromObject({start: first, end: first}));
  delims.push(Range.fromObject({start: last, end: last}));
  return _.zipWith(delims.slice(0, -1), delims.slice(1), (delim, nextDelim) => {
    return Range.fromObject({
      start: delim.start.translate({row: delim.start.row == 0 ? 0 : 1}),
      end: nextDelim.start,
    });
  });
}
window.allCodeChunks = allCodeChunks; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); allCodeChunks(type, editor).forEach(chunk => console.log(chunk.toString())) })
*/

// [Used by HydrogenNotebook.run*]
export function codeChunksForSelection(type, editor, options = {}) {
  return codeChunksForRange(type, editor, editor.getSelectedBufferRange(), options);
}
window.codeChunksForSelection = codeChunksForSelection // XXX dev

// TODO TODO v0 -> v1
//  - Simplify body like allCodeChunks
//  - Start at range.start.row instead of 0 (might have to -1?)
//  - Stop at range.end.row instead of eof (might have to +1?)
export function codeChunksForRange(type, editor, range, options = {}) {
  const chunks = [];
  if (range) {
    // Expand range to exterior chunk boundaries
    range = Range(
      enclosingCodeChunkDelimInDirection(type, editor, 'previous', range.start),
      enclosingCodeChunkDelimInDirection(type, editor, 'next', range.end),
    );
    // Split range into the chunk ranges it contains
    let row = 0;
    while (true) {
      const chunk = codeChunkContainingPoint(type, editor, Point(row, 0)); // XXX simplify to prev delim
      const rows = chunk.getRows();
      const nextRow = rows[rows.length - 1];
      if (row >= nextRow) {
        break;
      }
      if (
        options.all ||
        (options.above && chunk.end.isLessThanOrEqual(range.start)) ||
        (options.below && range.end.isLessThanOrEqual(chunk.start)) ||
        (options.selected && range.containsRange(chunk))
      ) {
        chunks.push(chunk);
      }
      row = nextRow + 1;
    }
  }
  return chunks;
}
window.codeChunksForRange = codeChunksForRange; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.error(type); codeChunksForRange(type, editor, editor.buffer.getRange(), {all:true}).forEach(chunk => { console.error(chunk.toString()); console.warn(editor.buffer.getTextInRange(chunk)); })})
*/

export function codeChunkDelims(type, editor, options = {}) {
  const delims = [];
  codeChunkFindInEditor(type, editor, options, ({range}) => {
    delims.push(range);
  });
  return delims;
}
window.codeChunkDelims = codeChunkDelims; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); codeChunkDelims(type, editor).forEach(delim => console.log(delim.toString())) })
*/

export function codeChunkFindInEditor(type, editor, options, f) {

  // Default args
  const direction = options.direction || 'next'; // 'next' | 'previous' (like findInEditor)
  let from = options.from || getLastResortPoint(editor, oppositeDirection(direction));
  let to = options.to || getLastResortPoint(editor, direction);

  // Twiddle from/to
  //  - If current line is blank and next line is delim then moving 'next' will jump over it. Jump
  //    to the previous line to avoid this.
  if (direction !== 'previous' && editor.isBufferRowBlank(from.row)) {
    from = editor.clipBufferPosition(Point.fromObject(from).translate({row: -1}));
  }
  //  - If we're in the middle of a delim then moving 'previous' will jump over it, but if we're at
  //    the first char of the delim then that's what we want. If we're not at the first char, jump
  //    to the next blank line so that we instead jump to the start of our delim.
  if (direction === 'previous' && !(
    // Hacky encoding of "at the first char of a delim": assumes delim always starts with blank line
    editor.isBufferRowBlank(from.row - 1) && editor.getCursorBufferPosition().column == 0
  )) {
    const nextBlankLine = findInEditor(editor, 'next', /^\s*$/g, {from}, ({range}) => {
      return range.start;
    });
    from = nextBlankLine || from; // in case there are no more blank lines in the buffer
  }

  // Add '/g' to workaround bug in findEditor: if scanRange.start is blank line then it's the first result
  let chunkDelimRegex = codeChunkDelimRegex(type, editor);
  chunkDelimRegex = new RegExp(chunkDelimRegex.source, chunkDelimRegex.flags + 'g');

  // Find delims in direction from `from` to `to`
  const scanRange = direction !== 'previous' ? Range(from, to) : Range(to, from);
  return findInEditor(editor, direction, chunkDelimRegex, {scanRange}, ({range}) => {
    // Skip scanRange.start to workaround bug in findEditor: if scanRange.start is blank line then it's the first result
    if (!range.start.isEqual(scanRange.start)) {
      return f({range});
    }
  });

}

export function codeChunkDelimRegex(type, editor) {
  if (type === 'para') {
    // Para delims are easy
    const s = '[ \\t]*'; // Careful! \s matches \n, which we don't want
    const delim = `^${s}$`;
    return new RegExp(delim);
  } else if (type === 'cell') {
    // Big regex to match the various kinds of cell delims
    //  - Bug: since atom-1.25.0, '^...$\n^...$' is unreliable, stick to '^...\n...$' instead
    //  - TODO Still some bugs when delims are separated by non-empty blank lines instead of empties
    //    - e.g. '////\n\n////' works forward + backward, but '////\n  \n////' doesn't work backward
    const comment = getLineComment(editor.getGrammar(), editor);
    const s = '[ \\t]*'; // Careful! \s matches \n, which we don't want
    const afterComment = '(| .*)';
    const double = `${comment}${comment}${afterComment}`; // No trailing blank line required
    const single = `${comment}${afterComment}`;
    const singleNoStuff = `${comment}`;
    const heading = `${singleNoStuff}${s}\\n(${s}${single}${s}\\n)*${s}${singleNoStuff}${s}\\n`; // Trailing blank line required
    const jupyterCellMagic = `%%.*`; // No trailing blank line required
    const delim = `^${s}\\n${s}(${double}|${heading}|${jupyterCellMagic})${s}$`; // Leading blank line required
    return new RegExp(delim, 'm');
  } else {
    throw `Unknown code chunk type: ${type}`;
  }
}

export function getLineComment(grammar, editor = null) {
  if (grammar) {
    if (
      editor &&
      editor.buffer.file &&
      '.ipynb' === path.extname(editor.buffer.file.path).toLowerCase() &&
      grammar.scopeName === 'source.python'
    ) {
      // HACK Use '%%' instead of '##' in .ipynb .py to avoid colliding with markdown h2's
      return '%%';
    } else if (grammar.tokenizeLines) {
      let result;
      knownLineComments.forEach(lineComment => {
        const [line] = grammar.tokenizeLines(lineComment);
        const [token, ...tokens] = line;
        if (
          token.scopes.findIndex(scope => scope.startsWith('comment.line.')) !== -1 &&
          tokens.length === 0
        ) {
          result = lineComment;
        }
      })
      return result && result.trim();
    }
  }
}
/* TODO Tests
getLineComment = notebookHydrogen.moreVmp.getLineComment; undefined
getLineComment(atom.grammars.grammarForScopeName('source.python'))
getLineComment(atom.grammars.grammarForScopeName('source.js'))
getLineComment(atom.grammars.grammarForScopeName('source.go'))
getLineComment(atom.grammars.grammarForScopeName('source.sql'))
getLineComment(atom.grammars.grammarForScopeName('text.md'))
getLineComment(atom.grammars.grammarForScopeName('source.r'))
getLineComment(atom.grammars.grammarForScopeName('text.xml'))
getLineComment(atom.grammars.grammarForScopeName('source.viml'))
getLineComment(atom.grammars.grammarForScopeName('source.clojure'))
*/

// TODO Can we avoid hardcoding these?
export const knownLineComments = [
  '#',
  '//',
  '--',
  '%',
  ';',
  '"',
];

export function trimCodeRange(buffer, range) {
  // TODO Trim all whitespace, not just \n
  while (buffer.getTextInRange(range).startsWith('\n')) {
    range = range.translate([1, 0], [0, 0]);
  }
  while (buffer.getTextInRange(range).endsWith('\n')) {
    range = range.translate([0, 0], [-1, buffer.rangeForRow(range.end.row - 1).end.column]);
  }
  // Allow a trailing blank line if we contain any blank lines, e.g. for cells vs. paragraphs
  //  - TODO Oops, doing this abuts our output with the top of the next cell, which is worse...
  //  - TODO How do we want this to look? Should we resort to css styling...?
  // if (/^\s*$/m.test(buffer.getTextInRange(range))) {
  //   range = range.translate([0, 0], [1, 0]);
  // }
  return range;
}

export function getLastResortPoint(editor, direction) {
  if (direction !== 'previous') {
    return editor.buffer.getEndPosition();
    // return editor.buffer.clipPosition({row: editor.buffer.getLastRow()}); // vmp does this. Should we?
  } else {
    return editor.buffer.getFirstPosition();
  }
}

export function oppositeDirection(direction) {
  if (direction !== 'previous') {
    return 'previous';
  } else {
    return 'next';
  }
}
