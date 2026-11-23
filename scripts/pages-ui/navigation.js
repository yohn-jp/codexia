(() => {
  'use strict';
  const button = document.querySelector('.cx-pages-menu-button');
  const navigation = document.querySelector('.cx-pages-navigation');
  if (!button || !navigation) return;

  const narrow = window.matchMedia('(max-width: 48rem)');
  const updateLayout = () => {
    if (narrow.matches) {
      navigation.dataset.collapsed = button.getAttribute('aria-expanded') === 'true' ? 'false' : 'true';
    } else {
      delete navigation.dataset.collapsed;
      button.setAttribute('aria-expanded', 'true');
    }
  };
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    updateLayout();
  });
  narrow.addEventListener('change', updateLayout);
  updateLayout();
})();
