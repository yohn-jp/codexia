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
  narrow.addEventListener('change', updateLayout);
  updateLayout();
})();
