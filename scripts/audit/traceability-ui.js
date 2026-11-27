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
  const clearFilters = () => {
    form.reset();
    query.value = '';
    area.value = '';
    status.value = '';
    kind.value = '';
    apply();
  };
  document.querySelector('#clear-filters')?.addEventListener('click', clearFilters);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href^="#"]');
    if (!link) return;
    const target = document.getElementById(link.getAttribute('href').slice(1));
    if (target?.closest('[data-trace-row]')?.hidden) clearFilters();
  });
  apply(false);

  const live = document.querySelector('#pages-live-confirmation');
  const liveStatus = live?.querySelector('[data-live-status]');
  const expectedSha = live?.dataset.sourceSha;
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const read = async path => {
    const url = new URL(path, location.href);
    url.searchParams.set('live-check', expectedSha);
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('public Pages metadata is unavailable');
    return response.text();
  };
  const verifyLivePublication = async () => {
    if (!live || !liveStatus || !/^[a-f0-9]{40}$/u.test(expectedSha ?? '')) return;
    if (location.origin !== 'https://yohn-jp.github.io' || location.pathname !== '/codexia/requirements/traceability/') {
      liveStatus.textContent = 'Not confirmed for the canonical public URL. This Pages observation is separate from Verify certification and remains pending until the exact-source post-deployment check succeeds.';
      live.dataset.status = 'pending';
      return;
    }
    try {
      const [siteBytes, traceBytes, manifestBytes, html] = await Promise.all([
        read('../../site-manifest.json'), read('./traceability.json'), read('../manifest.json'), read('./index.html'),
      ]);
      const site = JSON.parse(siteBytes);
      const trace = JSON.parse(traceBytes);
      const requirements = JSON.parse(manifestBytes);
      if (site.sourceSha !== expectedSha || trace.sourceSha !== expectedSha || requirements.sourceSha !== expectedSha) throw new Error('served source SHA does not match this page');
      const route = site.routes?.find(item => item.route === '/requirements/traceability/');
      if (route?.generationStatus !== 'ready' || route.sourceSha !== expectedSha) throw new Error('published route identity does not match this page');
      if (trace.pagesQualification?.status !== 'PENDING_PAGES_PUBLISH' || trace.pagesQualification.publicUrlConfirmation !== 'PENDING') throw new Error('build qualification is invalid');
      const outputByName = new Map(requirements.outputs?.map(item => [item.name, item]) ?? []);
      for (const [name, value] of [['traceability/index.html', html], ['traceability/traceability.json', traceBytes]]) {
        const output = outputByName.get(name);
        if (!output || output.bytes !== new TextEncoder().encode(value).length || output.sha256 !== await digest(value)) throw new Error('published traceability digest mismatch');
      }
      const publisher = trace.pagesQualification?.publisherExecution;
      if (!publisher || publisher.status !== 'IN_PROGRESS' || publisher.repository !== 'yohn-jp/codexia' || publisher.sourceSha !== expectedSha || publisher.job !== 'specification' || publisher.task !== 'pages-requirements-trace' || !/^\d+$/u.test(String(publisher.runId)) || !Number.isInteger(publisher.attempt) || publisher.attempt < 1 || publisher.runUrl !== `https://github.com/yohn-jp/codexia/actions/runs/${publisher.runId}`) throw new Error('exact Pages producer run identity is unavailable');
      const runResponse = await fetch(`https://api.github.com/repos/yohn-jp/codexia/actions/runs/${publisher.runId}`, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
      if (!runResponse.ok) throw new Error('exact publisher run evidence is unavailable');
      const run = await runResponse.json();
      if (run.id !== Number(publisher.runId) || run.path !== '.github/workflows/repository-audit.yml' || run.head_sha !== expectedSha || run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed' || run.conclusion !== 'success' || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < publisher.attempt || run.html_url !== publisher.runUrl || run.repository?.full_name !== publisher.repository || run.head_repository?.full_name !== publisher.repository) throw new Error('exact publisher run is stale, foreign, or incomplete');
      const jobsUrl = new URL(`https://api.github.com/repos/yohn-jp/codexia/actions/runs/${publisher.runId}/jobs`);
      jobsUrl.searchParams.set('filter', 'latest');
      jobsUrl.searchParams.set('per_page', '100');
      const jobsResponse = await fetch(jobsUrl, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
      if (!jobsResponse.ok) throw new Error('exact publisher job evidence is unavailable');
      const jobs = await jobsResponse.json();
      if (jobs.jobs?.length !== jobs.total_count) throw new Error('exact publisher job inventory is incomplete');
      const deploys = jobs.jobs.filter(job => job.name === 'deploy');
      const [deploy] = deploys;
      if (deploys.length !== 1 || deploy.run_id !== run.id || deploy.run_attempt !== run.run_attempt || deploy.head_sha !== expectedSha || deploy.status !== 'completed' || deploy.conclusion !== 'success') throw new Error('latest deploy job did not succeed');
      // The deploy step verifies bytes against this digest from the trusted pack job.
      const proofName = `Verify published Pages (${await digest(manifestBytes)})`;
      const proofs = deploy.steps?.filter(step => step.name === proofName);
      if (proofs?.length !== 1 || proofs[0].status !== 'completed' || proofs[0].conclusion !== 'success') throw new Error('exact publisher run has no successful confirmation for this manifest');
      liveStatus.textContent = '';
      const label = document.createElement('strong');
      label.textContent = 'Confirmed';
      const text = document.createTextNode(' · public Pages traceability outputs, manifest digests, source SHA, and post-deployment verifier all match ' + expectedSha + ' · ');
      const link = document.createElement('a');
      link.href = publisher.runUrl;
      link.textContent = 'Open publisher and live verification run';
      link.rel = 'noopener noreferrer';
      liveStatus.append(label, text, link);
      live.dataset.status = 'confirmed';
    } catch {
      liveStatus.textContent = 'Not confirmed for the canonical public URL. This Pages observation is separate from Verify certification and remains pending until the exact-source post-deployment check succeeds.';
      live.dataset.status = 'pending';
    }
  };
  void verifyLivePublication();
})();
