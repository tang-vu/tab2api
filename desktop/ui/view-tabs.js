export function viewState(view, browserMode) {
  const activeView = view === 'docs' ? 'docs' : 'browser';
  return {
    activeView,
    browserHidden: activeView !== 'browser',
    docsHidden: activeView !== 'docs',
    nativeBrowserVisible: browserMode === 'docked' ? activeView === 'browser' : undefined,
  };
}
