(() => {
  const form = document.querySelector('#trace-filter');
  if (!form) return;
  const query = form.elements.namedItem('q');
  const area = form.elements.namedItem('area');
  const status = form.elements.namedItem('status');
  const kind = form.elements.namedItem('kind');
  const rows = [...document.querySelectorAll('[data-trace-row]')];
  const count = document.querySelector('#filter-count');
  const params = new URLSearchParams(window.location.search);
  query.value = params.get('q') ?? '';
  area.value = params.get('area') ?? '';
  status.value = params.get('status') ?? '';
  kind.value = params.get('kind') ?? '';

  const apply = (updateUrl = true) => {
    const q = query.value.trim().toLocaleLowerCase();
    const selectedArea = area.value;
    const selectedStatus = status.value;
    const selectedKind = kind.value;
    let visible = 0;
    for (const row of rows) {
      const statusValues = row.dataset.status.split(/\s+/u).filter(Boolean);
      const matches = (!q || (row.dataset.search + ' ' + row.textContent).toLocaleLowerCase().includes(q))
        && (!selectedArea || row.dataset.area === selectedArea)
        && (!selectedStatus || statusValues.includes(selectedStatus))
        && (!selectedKind || row.dataset.kind === selectedKind);
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    if (count) count.textContent = '表示 ' + visible + ' / ' + rows.length + ' 件';
    if (updateUrl) {
      const next = new URLSearchParams();
      for (const [key, value] of [['q', query.value.trim()], ['area', selectedArea], ['status', selectedStatus], ['kind', selectedKind]]) {
        if (value) next.set(key, value);
      }
      const search = next.toString();
      history.replaceState(null, '', window.location.pathname + (search ? '?' + search : '') + window.location.hash);
    }
  };

  form.addEventListener('submit', event => { event.preventDefault(); apply(); });
  form.addEventListener('input', () => apply());
  form.addEventListener('change', () => apply());
  document.querySelector('#clear-filters')?.addEventListener('click', () => {
    form.reset();
    query.value = '';
    area.value = '';
    status.value = '';
    kind.value = '';
    apply();
  });
  apply(false);
})();
