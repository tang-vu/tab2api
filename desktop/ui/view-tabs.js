export function viewState(view, browserMode) {
  const activeView = view === 'docs' || view === 'admin' ? view : 'browser';
  return {
    activeView,
    browserHidden: activeView !== 'browser',
    docsHidden: activeView !== 'docs',
    adminHidden: activeView !== 'admin',
    nativeBrowserVisible: browserMode === 'docked' ? activeView === 'browser' : undefined,
  };
}
