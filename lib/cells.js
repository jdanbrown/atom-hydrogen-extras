'use babel'

import {Point, Range} from 'atom'

// TODO package.json so we don't break if these packages aren't installed
export const configDir = atom.getConfigDirPath();
export const {findInEditor, scanEditor} = require(`${configDir}/packages/vim-mode-plus/lib/utils`);
window.findInEditor = findInEditor; // XXX
window.scanEditor = scanEditor; // XXX

export function codeChunksForSelection(type, editor, options = {}) {
  const outerRange = expandRangeToCodeChunks(type, editor, editor.getSelectedBufferRange());
  let row = 0;
  const ranges = [];
  while (true) {
    const range = codeChunkContainingPoint(type, editor, Point(row, 0));
    const rows = range.getRows();
    const nextRow = rows[rows.length - 1];
    if (row >= nextRow) {
      break;
    }
    if (
      options.all ||
      (options.above && range.end.isLessThanOrEqual(outerRange.start)) ||
      (options.below && outerRange.end.translate({row: -1}).isLessThanOrEqual(range.start)) ||
      (options.selected && outerRange.containsRange(range))
    ) {
      ranges.push(range);
      // console.warn(range.toString(), editor.buffer.getTextInRange(range)); // XXX Debug
    } else {
      // console.error(range.toString(), editor.buffer.getTextInRange(range)); // XXX Debug
    }
    row = nextRow + 1;
  }
  return ranges;
}
window.codeChunksForSelection = codeChunksForSelection // XXX dev

export function expandRangeToCodeChunks(type, editor, range) {
  return Range(
    codeChunkContainingPoint(type, editor, range.start).start,
    codeChunkContainingPoint(type, editor, range.end).end,
  );
}

export function codeChunkContainingPoint(type, editor, point) {
  const pointPlusOne = editor.clipBufferPosition(point.translate({row: 1}));
  const prevDelim = codeChunkStartPointInDirection(type, editor, 'previous', pointPlusOne) || getLastResortPoint(editor, 'previous');
  const nextDelim = codeChunkStartPointInDirection(type, editor, 'next', point) || getLastResortPoint(editor, 'next');
  return Range(
    prevDelim,
    nextDelim.translate({row: nextDelim.row === editor.getLastBufferRow() ? 0 : -1}),
  );
}

export function codeChunkStartPointInDirection(type, editor, direction, from) {
  if (type === 'para') {
    return codeParaStartPointInDirection(editor, direction, from);
  } else if (type === 'cell') {
    return codeCellStartPointInDirection(editor, direction, from);
  } else {
    throw `Unknown code chunk type: ${type}`;
  }
}

export function codeParaStartPointInDirection(editor, direction, from) {
  const space = '[ \\t]*'; // Careful! \s matches \n, which we don't want
  const emptyLine = `^${space}$`;
  const delim = emptyLine;
  const pattern = new RegExp(delim, 'g');
  return _codeChunkStartPointInDirection(editor, direction, from, pattern);
}
window.codeParaStartPointInDirection = codeParaStartPointInDirection // XXX dev

export function codeCellStartPointInDirection(editor, direction, from) {
  // TODO Still some bugs when delims are separated by non-empty blank lines instead of empties
  //  - e.g. '////\n\n////' works forward + backward, but '////\n  \n////' doesn't work backward
  const comment = getLineComment(editor.getGrammar());
  const space = '[ \\t]*'; // Careful! \s matches \n, which we don't want
  const begin = `^${space}`;
  const end = `${space}$`;
  const blank = `^${space}$`;
  const stuff = '(| .*)';
  const double = `${begin}${comment}${comment}${stuff}${end}`; // No trailing blank required
  const single = `${begin}${comment}${stuff}${end}`;
  const singleNoStuff = `${begin}${comment}${end}`;
  const heading = `${singleNoStuff}\\n(${single}\\n)*${singleNoStuff}\\n${blank}`; // Trailing blank required
  const jupyterCellMagic = `${begin}%%.*${end}`; // No trailing blank required
  const delim = `${blank}\\n(${double}|${heading}|${jupyterCellMagic})`;
  const pattern = new RegExp(delim, 'm');
  return _codeChunkStartPointInDirection(editor, direction, from, pattern);
}
window.codeCellStartPointInDirection = codeCellStartPointInDirection // XXX dev

export function _codeChunkStartPointInDirection(editor, direction, from, chunkDelimRegex) {
  if (direction === 'previous' && !editor.isBufferRowBlank(from.row - 1)) {
    const nextBlankLine = findInEditor(editor, 'next', /^\s*$/g, {from}, ({range}) => {
      return range.start;
    });
    from = nextBlankLine || from; // in case there are no more blank lines in the buffer
  }
  return findInEditor(editor, direction, chunkDelimRegex, {from}, ({range}) => {
    // Workaround bug in findInEditor('previous', /^$/g) where from is always returned first
    if (!range.start.isEqual(from)) {
      return editor.clipBufferPosition(range.start.translate({row: 1}));
    }
  });
}
window._codeChunkStartPointInDirection = _codeChunkStartPointInDirection // XXX dev

export function getLastResortPoint(editor, direction) {
  if (direction === 'previous') {
    return editor.buffer.getFirstPosition();
  } else {
    return editor.buffer.clipPosition({row: editor.buffer.getLastRow()});
  }
}

// TODO Can we avoid hardcoding these?
export const knownLineComments = [
  '#',
  '//',
  '--',
  '%',
  ';',
  '"',
];

export function getLineComment(grammar) {
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
/* TODO "Tests"
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
