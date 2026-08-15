(function() {
  const desktopBtns = document.querySelectorAll('.sort-btn');
  const mobileBtns = document.querySelectorAll('.sort-menu-item');
  const triggers = document.querySelectorAll('.sort-menu-trigger');
  const dropdowns = document.querySelectorAll('.sort-menu-dropdown');

  if (!desktopBtns.length && !mobileBtns.length) return;

  function getDate(el) {
    const dateEl = el.querySelector('.post-date') || el.querySelector('time');
    if (!dateEl) return 0;
    return new Date(dateEl.textContent.trim()).getTime();
  }

  function getTitle(el) {
    const linkEl = el.querySelector('a');
    if (!linkEl) return '';
    return linkEl.textContent.trim().toLowerCase();
  }

  function sortList(container, items, mode) {
    items.sort((a, b) => {
      if (mode === 'newest') return getDate(b) - getDate(a);
      if (mode === 'oldest') return getDate(a) - getDate(b);
      return getTitle(a).localeCompare(getTitle(b));
    });
    items.forEach(item => container.appendChild(item));
  }

  function sortAll(mode) {
    if (document.querySelector('.series-container')) {
      const container = document.querySelector('.series-container');
      const blocks = Array.from(container.querySelectorAll('.series-block'));
      blocks.sort((a, b) => {
        if (mode === 'latest') return (b.dataset.date || '').localeCompare(a.dataset.date || '');
        return (a.dataset.name || '').localeCompare(b.dataset.name || '');
      });
      blocks.forEach(block => container.appendChild(block));
      return;
    }
    document.querySelectorAll('.tag-posts').forEach(ul => {
      sortList(ul, Array.from(ul.querySelectorAll('li')), mode);
    });
    const grid = document.querySelector('.blog-cards-grid');
    if (grid) {
      sortList(grid, Array.from(grid.querySelectorAll('.blog-card')), mode);
    }
  }

  function setActive(mode) {
    desktopBtns.forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
    mobileBtns.forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
  }

  function closeAllDropdowns() {
    dropdowns.forEach(d => d.classList.remove('open'));
  }

  if (document.querySelector('.series-container')) {
    setActive('latest');
    sortAll('latest');
  }

  desktopBtns.forEach(btn => {
    btn.addEventListener('click', function() {
      setActive(this.dataset.sort);
      sortAll(this.dataset.sort);
    });
  });

  mobileBtns.forEach(btn => {
    btn.addEventListener('click', function() {
      setActive(this.dataset.sort);
      sortAll(this.dataset.sort);
      closeAllDropdowns();
    });
  });

  triggers.forEach(trigger => {
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      const dropdown = this.nextElementSibling;
      if (dropdown) dropdown.classList.toggle('open');
    });
  });

  document.addEventListener('click', function() {
    closeAllDropdowns();
  });
})();
