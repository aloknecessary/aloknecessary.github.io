(function() {
  const searchToggle = document.getElementById('search-toggle');
  const searchInput = document.getElementById('blog-search');
  const searchClear = document.getElementById('search-clear');
  const searchContainer = document.querySelector('.search-container');
  const noResults = document.getElementById('no-results');
  const clearSearchLink = document.getElementById('clear-search-link');
  const resultCount = document.getElementById('search-result-count');
  const resultText = document.getElementById('search-result-text');
  const resultDismiss = document.getElementById('search-result-dismiss');
  
  if (!searchToggle || !searchInput || !searchClear || !searchContainer) return;

  // Auto-expand on desktop
  if (window.innerWidth >= 1025) {
    searchContainer.classList.add('active');
  }

  const blogCards = document.querySelectorAll('.blog-card');
  let debounceTimer;

  // Store original text content for restoring after highlight removal
  blogCards.forEach(card => {
    const title = card.querySelector('.card-title a');
    const excerpt = card.querySelector('.card-excerpt');
    if (title) title.dataset.original = title.textContent;
    if (excerpt) excerpt.dataset.original = excerpt.textContent;
  });
  
  function updateClearButtonVisibility() {
    if (searchInput.value.trim().length > 0) {
      searchContainer.classList.add('has-text');
    } else {
      searchContainer.classList.remove('has-text');
    }
  }

  function highlightText(element, term) {
    const original = element.dataset.original;
    if (!term) {
      element.innerHTML = original;
      return;
    }
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    element.innerHTML = original.replace(regex, '<mark class="search-highlight">$1</mark>');
  }
  
  function filterBlogs(searchTerm) {
    let visibleCount = 0;
    
    blogCards.forEach(card => {
      const titleEl = card.querySelector('.card-title a');
      const excerptEl = card.querySelector('.card-excerpt');
      const title = titleEl?.dataset.original.toLowerCase() || '';
      const excerpt = excerptEl?.dataset.original.toLowerCase() || '';
      const tagEls = card.querySelectorAll('.card-tags .tag');
      const tags = Array.from(tagEls).map(tag => tag.textContent.toLowerCase()).join(' ');
      
      const matches = title.includes(searchTerm) || 
                     excerpt.includes(searchTerm) || 
                     tags.includes(searchTerm);
      
      card.style.display = matches ? '' : 'none';

      // Apply or clear highlights
      if (titleEl) highlightText(titleEl, matches ? searchTerm : '');
      if (excerptEl) highlightText(excerptEl, matches ? searchTerm : '');

      // Highlight matching tags
      tagEls.forEach(tag => {
        if (searchTerm && matches && tag.textContent.toLowerCase().includes(searchTerm)) {
          tag.classList.add('tag-matched');
        } else {
          tag.classList.remove('tag-matched');
        }
      });

      if (matches) visibleCount++;
    });
    
    // Update result count
    if (resultCount) {
      if (searchTerm.length > 0 && visibleCount > 0) {
        resultText.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align: -2px; margin-right: 0.35rem;"><path d="M4 6h16M4 12h10M4 18h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' + visibleCount + (visibleCount === 1 ? ' article' : ' articles') + ' found';
        resultCount.classList.add('visible');
      } else {
        resultText.textContent = '';
        resultCount.classList.remove('visible');
      }
    }

    if (noResults) {
      noResults.classList.toggle('visible', searchTerm.length > 0 && visibleCount === 0);
    }
  }
  
  function clearSearch() {
    searchInput.value = '';
    updateClearButtonVisibility();
    filterBlogs('');
    searchContainer.classList.remove('active');
  }
  
  // Toggle search bar
  searchToggle.addEventListener('click', function() {
    searchContainer.classList.toggle('active');
    if (searchContainer.classList.contains('active')) {
      searchInput.focus();
    }
  });
  
  // Search input
  searchInput.addEventListener('input', function(e) {
    const searchTerm = e.target.value.toLowerCase().trim();
    updateClearButtonVisibility();
    
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      filterBlogs(searchTerm.length >= 2 ? searchTerm : '');
    }, 300);
  });
  
  // Clear search button
  searchClear.addEventListener('click', clearSearch);

  // Dismiss result count
  if (resultDismiss) {
    resultDismiss.addEventListener('click', clearSearch);
  }
  
  // Clear search link in no results
  if (clearSearchLink) {
    clearSearchLink.addEventListener('click', clearSearch);
  }
  
  // Close search on outside click
  document.addEventListener('click', function(e) {
    if (!searchContainer.contains(e.target) && searchInput.value.trim() === '') {
      searchContainer.classList.remove('active');
    }
  });

  // Restore state on back-navigation (browser preserves input value)
  window.addEventListener('pageshow', function() {
    const restored = searchInput.value.toLowerCase().trim();
    if (restored.length >= 2) {
      searchContainer.classList.add('active');
      updateClearButtonVisibility();
      filterBlogs(restored);
    }
  });
})();
