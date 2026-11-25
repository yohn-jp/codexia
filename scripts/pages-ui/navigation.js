(() => {
  'use strict';
  const button = document.querySelector('.cx-pages-menu-button');
  const navigation = document.querySelector('.cx-pages-navigation');
  if (!button || !navigation) return;

  const narrow = window.matchMedia('(max-width: 48rem)');
  const setExpanded = expanded => {
    button.setAttribute('aria-expanded', String(expanded));
    navigation.dataset.collapsed = String(!expanded);
  };
  const updateLayout = () => setExpanded(!narrow.matches);
  button.addEventListener('click', () => {
    setExpanded(button.getAttribute('aria-expanded') !== 'true');
  });
  document.querySelector('.cx-pages-header').addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !narrow.matches || button.getAttribute('aria-expanded') !== 'true') return;
    setExpanded(false);
    button.focus();
  });
  narrow.addEventListener('change', updateLayout);
  updateLayout();

  const revealHashTarget = () => {
    if (!window.location.hash) return;
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); }
    catch { return; }
    const target = document.getElementById(id);
    if (!target) return;
    let current = target;
    while (current && current !== document.body) {
      if (current instanceof HTMLDetailsElement) current.open = true;
      current = current.parentElement;
    }
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  };
  revealHashTarget();
  window.addEventListener('hashchange', revealHashTarget);
})();
