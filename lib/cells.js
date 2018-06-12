'use babel'

import {Point, Range} from 'atom'
import path from 'path';

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);
export const {findInEditor, scanEditor} = require(`${atom.packages.resolvePackagePath('vim-mode-plus')}/lib/utils`);
window.findInEditor = findInEditor; // XXX
window.scanEditor = scanEditor; // XXX

// For HydrogenNotebook.updateCellDecorations + IpynbSync.syncViewFromIpynb
export function allCodeChunks(type, editor) {
  return codeChunksForRange(type, editor, null, {all: true});
}
window.allCodeChunks = allCodeChunks; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); allCodeChunks(type, editor).forEach(chunk => console.log(chunk.toString())) })
*/

// For HydrogenNotebook.run*
export function codeChunksForSelection(type, editor, options = {}) {
  return codeChunksForRange(type, editor, editor.getSelectedBufferRange(), options);
}
window.codeChunksForSelection = codeChunksForSelection // XXX dev

export function codeChunksForRange(type, editor, range = null, options = {}) {
  const bufRange = editor.buffer.getRange();
  // Performance: skip two regex ops when !range (e.g. from allCodeChunks <- updateCellDecorations)
  const selectedChunks = !range ? bufRange : Range(
    enclosingCodeChunkDelim(type, editor, 'previous', range.start),
    enclosingCodeChunkDelim(type, editor, 'next', range.end),
  )
  const scanOptions = {
    direction: 'next',
    from: (
      options.all || options.above ? bufRange.start :
      options.selected ? selectedChunks.start :
      selectedChunks.end
    ),
    to: (
      options.all || options.below ? bufRange.end :
      options.selected ? selectedChunks.end :
      selectedChunks.start
    ),
  };
  const delims = codeChunkDelimsScan(type, editor, scanOptions);
  if (!scanOptions.from.isEqual(selectedChunks.end)) delims.unshift(Range(scanOptions.from, scanOptions.from));
  if (!scanOptions.to.isEqual(selectedChunks.start)) delims.push(Range(scanOptions.to, scanOptions.to));
  return _.zipWith(delims.slice(0, -1), delims.slice(1), (delim, nextDelim) => {
    return Range(
      delim.start,
      // Row -1 to exclude the blank line between chunks [assumes delim starts with blank line]
      nextDelim.start.translate({row: !nextDelim.start.isEqual(scanOptions.to) ? -1 : 0}),
    );
  });
}
window.codeChunksForRange = codeChunksForRange; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.error(type); codeChunksForRange(type, editor, editor.buffer.getRange(), {all:true}).forEach(chunk => { console.error(chunk.toString()); console.warn(editor.buffer.getTextInRange(chunk)); })})
*/

// Similar to nextCodeChunkDelim, except:
//  - 'previous':
//    - Map first char in cell to itself
//    - Map non-first chars in cell to its first char
//  - 'next':
//    - Map all chars in cell to first char of next cell
export function enclosingCodeChunkDelim(type, editor, direction, from) {
  if (direction === 'previous') {
    // Offset to the start of the next row to stay within the current cell instead of jumping to the
    // previous cell's delim
    from = editor.clipBufferPosition(Point(from.row + 1, 0));
  }
  return nextCodeChunkDelim(type, editor, direction, from) || getLastResortPoint(editor, direction);
}
window.enclosingCodeChunkDelim = enclosingCodeChunkDelim // XXX dev

// Special API for more-vim-mode-plus MoveToNextCell (Motion)
//  - 'previous':
//    - Map first char in cell to first char of previous cell
//    - Map non-first chars in cell to its first char
//  - 'next':
//    - Map all chars in cell to first char of next cell
export function nextCodeChunkDelim(type, editor, direction, from) {
  return codeChunkDelimScan(type, editor, {direction, from}, ({delim}) => delim.start);
}
window.nextCodeChunkDelim = nextCodeChunkDelim // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['next', 'previous'].forEach(direction => ['para', 'cell'].forEach(type => [0,1,2,3,4].forEach(row => console.log(type, direction, row, nextCodeChunkDelim(type, editor, direction, [row,0])))))
*/

// Special API for more-vim-mode-plus Cell (TextObject)
export function codeChunkContainingPoint(type, editor, point) {
  const prevDelim = enclosingCodeChunkDelim(type, editor, 'previous', point);
  const nextDelim = enclosingCodeChunkDelim(type, editor, 'next', point);
  return Range(
    prevDelim,
    nextDelim.translate({row: nextDelim.row === editor.getLastBufferRow() ? 0 : -1}), // Assumes delims start with blank line
  );
}

export function codeChunkDelimsScan(type, editor, options = {}) {
  const delims = [];
  codeChunkDelimScan(type, editor, options, ({delim}) => {
    delims.push(delim);
  });
  return delims;
}
window.codeChunkDelimsScan = codeChunkDelimsScan; // XXX dev
/* TODO Tests
editor = atom.workspace.getActiveTextEditor()
['para', 'cell'].forEach(type => { console.log(type); codeChunkDelimsScan(type, editor).forEach(delim => console.log(delim.toString())) })
*/

export function codeChunkDelimScan(type, editor, options, f) {

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
  return findInEditor(editor, direction, chunkDelimRegex, {scanRange}, ({range: delim}) => {
    // Skip scanRange.start to workaround bug in findEditor: if scanRange.start is blank line then it's the first result
    if (!delim.start.isEqual(scanRange.start)) {
      return f({delim: Range(
        delim.start.translate({row: 1}), // Skip delim's leading blank line [assumes delims always start with blank line]
        delim.end,
      )});
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
    // Special-cased cell delims, by grammar scope name
    const regex = codeCellDelimRegexForScopeName((editor.getGrammar() || {}).scopeName);
    if (regex) {
      return regex;
    } else {
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
    }
  } else {
    throw `Unknown code chunk type: ${type}`;
  }
}

export function codeCellDelimRegexForScopeName(scopeName) {
  const s = '[ \\t]*'; // Careful! \s matches \n, which we don't want
  return {
    'text.md': new RegExp(`^${s}\\n#.*$`),
  }[scopeName];
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
