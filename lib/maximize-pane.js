'use babel';

// A thin wrapper around vim-mode-plus pane-utils
//  - TODO Find a good way to remove the dependency on vim-mode-plus
//    - https://github.com/santip/maximize-panes seems promising, but it hasn't been touched in
//      ~3-4y and has not-great bugs like https://github.com/santip/maximize-panes/pull/21

const {isMaximized, maximizePane} = require(`${atom.packages.resolvePackagePath('vim-mode-plus')}/lib/pane-utils`);

export function maximizeCurrentPane() {
  if (!isMaximized()) {
    maximizePane(false);
  }
}

export function unmaximizeCurrentPane() {
  if (isMaximized()) {
    maximizePane();
  }
}
