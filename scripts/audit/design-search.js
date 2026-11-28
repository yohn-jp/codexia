const search = document.querySelector('#design-search');
if (search) {
  new window.PagefindUI({
    element: '#design-search',
    bundlePath: new URL('./design-search/', document.baseURI).pathname,
    baseUrl: new URL('./requirements/html/', document.baseURI).pathname,
    showImages: false,
    translations: { placeholder: '設計文書を検索' },
  });
}
