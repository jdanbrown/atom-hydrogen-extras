'use babel'

window.vegaUtil = module.exports; // XXX Debug

// TODO package.json so we don't break if these packages aren't installed
const _ = require(`${atom.packages.resolvePackagePath('Hydrogen')}/node_modules/lodash`);

// Initialize listeners at most once
let _listenersInitialized = false;
export function ensureListenersInitialized() {
  if (!_listenersInitialized) {
    console.log('vegaUtil.ensureListenersInitialized');

    // Must manually trigger window.resize event when atom changes font size (cmd--/cmd-=/cmd-0)
    //  - https://vega.github.io/vega-lite/docs/size.html#specifying-responsive-width-and-height
    atom.config.observe('editor.fontSize', fontSize => manuallyTriggerWindowResize());

    _listenersInitialized = true;
  }
}

// Sometimes we need to manually trigger window.resize events for vega to know to update its plot sizes
//  - https://vega.github.io/vega-lite/docs/size.html#specifying-responsive-width-and-height
//  - e.g. plots with width/height:'container' inside a container div of width:'120ch' don't resize on atom
//    increase/decrease font size, because atom doesn't trigger window.resize on atom.config changing 'editor.fontSize'
export function manuallyTriggerWindowResize() {
  console.log('vegaUtil.manuallyTriggerWindowResize');
  window.dispatchEvent(new Event('resize'));
}

export function isHtmlFromAltairHtmlRenderer(html) {
  return html.match(/^\s*<div id="altair-viz-/);
}

export function extractVegaSpecFromAltairHtmlRenderer(html) {
  // console.log('extractVegaSpecFromAltairHtmlRenderer: html', html); // Noisy
  const [_all, specCommaOpt] = html.match(/[^{]*(.*"\$schema":.*?)[^}]*$/) || [];
  if (!specCommaOpt) {
    throw Error(`Failed to parse html as altair html renderer: ${html}`);
  } else {
    // console.log('extractVegaSpecFromAltairHtmlRenderer: specCommaOpt', specCommaOpt); // Noisy
    const [spec, opt] = JSON.parse(`[${specCommaOpt}]`);
    return spec;
  }
}
