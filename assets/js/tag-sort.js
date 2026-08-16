(function() {
  const desktopBtns = document.querySelectorAll('.sort-btn');
  const mobileBtns = document.querySelectorAll('.sort-menu-item');
  const triggers = document.querySelectorAll('.sort-menu-trigger');
  const dropdowns = document.querySelectorAll('.sort-menu-dropdown');

  if (!desktopBtns.length && !mobileBtns.length) return;

  const DOMAIN_ORDER = ['ai engineering', 'infrastructure', 'platform', 'networking'];

  function sortAll(mode) {
    if (document.querySelector('.series-container')) {
      const container = document.querySelector('.series-container');
      const blocks = Array.from(container.querySelectorAll('.series-block'));
      blocks.sort((a, b) => {
        if (mode === 'newest') return (b.dataset.date || '').localeCompare(a.dataset.date || '');
        if (mode === 'domain') {
          const ai = DOMAIN_ORDER.indexOf(a.dataset.domain || '');
          const bi = DOMAIN_ORDER.indexOf(b.dataset.domain || '');
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        }
        return (a.dataset.name || '').localeCompare(b.dataset.name || '');
      });
      blocks.forEach(block => container.appendChild(block));
      return;
    }
    if (document.querySelector('.tags-container')) {
      const container = document.querySelector('.tags-container');
      const blocks = Array.from(container.querySelectorAll('.tag-block'));
      blocks.sort((a, b) => {
        if (mode === 'newest') return (b.dataset.date || '').localeCompare(a.dataset.date || '');
        if (mode === 'oldest') return (a.dataset.date || '').localeCompare(b.dataset.date || '');
        return (a.dataset.name || '').localeCompare(b.dataset.name || '');
      });
      blocks.forEach(block => container.appendChild(block));
      return;
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
    setActive('newest');
    sortAll('newest');
  }

  if (document.querySelector('.tags-container')) {
    setActive('newest');
    sortAll('newest');
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

  // --- Inline per-block sort button ---
  function getItemOrder(li) {
    const indicator = li.querySelector('.step-indicator');
    if (indicator) return parseInt(indicator.textContent.trim(), 10) || 0;
    const dateEl = li.querySelector('.post-date');
    return dateEl ? new Date(dateEl.textContent.trim()).getTime() : 0;
  }

  function sortBlockItems(list, isAsc) {
    const items = Array.from(list.querySelectorAll('li'));
    items.sort((a, b) => isAsc ? getItemOrder(a) - getItemOrder(b) : getItemOrder(b) - getItemOrder(a));
    items.forEach(item => list.appendChild(item));
  }

  document.querySelectorAll('.inline-sort-btn').forEach(btn => {
    btn.setAttribute('title', 'Newest first — click to sort oldest first');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const block = this.closest('.series-block, .tag-block');
      const list = block && (block.querySelector('.series-posts') || block.querySelector('.tag-posts'));
      if (!list) return;
      const isAsc = this.classList.toggle('asc');
      this.setAttribute('title', isAsc ? 'Oldest first — click to sort newest first' : 'Newest first — click to sort oldest first');
      sortBlockItems(list, isAsc);
    });
  });
})();
