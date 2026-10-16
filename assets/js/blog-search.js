(function() {
  const INITIAL_POSTS = (typeof window.getPostsPerPage === 'function') ? window.getPostsPerPage() : 10;

  const searchToggle = document.getElementById('search-toggle');
  const searchInput = document.getElementById('blog-search');
  const searchClear = document.getElementById('search-clear');
  const searchContainer = document.querySelector('.search-container');
  const noResults = document.getElementById('no-results');
  const clearSearchLink = document.getElementById('clear-search-link');
  const resultCount = document.getElementById('search-result-count');
  const resultText = document.getElementById('search-result-text');
  const resultDismiss = document.getElementById('search-result-dismiss');
  const loadMoreBtn = document.getElementById('load-more-btn');
  const loadMoreCount = document.getElementById('load-more-count');

  if (!searchToggle || !searchInput || !searchClear || !searchContainer) return;

  // Auto-expand on desktop
  if (window.innerWidth >= 1025) {
    searchContainer.classList.add('active');
  }

  const blogCards = document.querySelectorAll('.blog-card');
  let debounceTimer;
  let visibleLimit = parseInt(sessionStorage.getItem('blogsVisibleLimit')) || INITIAL_POSTS;
  let isSearchActive = false;

  function showPosts() {
    blogCards.forEach(card => {
      const index = parseInt(card.dataset.index);
      card.style.display = index <= visibleLimit ? '' : 'none';
    });
    const showing = Math.min(visibleLimit, blogCards.length);
    const remaining = blogCards.length - showing;
    if (loadMoreCount) {
      loadMoreCount.textContent = `Showing ${showing} of ${blogCards.length} articles`;
    }
    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle('hidden', visibleLimit >= blogCards.length);
    }
  }

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
    isSearchActive = searchTerm.length > 0;
    let visibleCount = 0;

    blogCards.forEach(card => {
      const titleEl = card.querySelector('.card-title a');
      const excerptEl = card.querySelector('.card-excerpt');
      const title = titleEl?.dataset.original.toLowerCase() || '';
      const excerpt = excerptEl?.dataset.original.toLowerCase() || '';
      const tagEls = card.querySelectorAll('.card-tags .tag');
      const tags = Array.from(tagEls).map(tag => tag.textContent.toLowerCase()).join(' ');

      const matches = !isSearchActive || title.includes(searchTerm) || excerpt.includes(searchTerm) || tags.includes(searchTerm);
      const withinLimit = !isSearchActive && parseInt(card.dataset.index) <= visibleLimit;

      card.style.display = (isSearchActive ? matches : withinLimit) ? '' : 'none';

      // Apply or clear highlights
      if (titleEl) highlightText(titleEl, isSearchActive && matches ? searchTerm : '');
      if (excerptEl) highlightText(excerptEl, isSearchActive && matches ? searchTerm : '');

      // Highlight matching tags
      tagEls.forEach(tag => {
        if (isSearchActive && matches && tag.textContent.toLowerCase().includes(searchTerm)) {
          tag.classList.add('tag-matched');
        } else {
          tag.classList.remove('tag-matched');
        }
      });

      if (isSearchActive && matches) visibleCount++;
    });

    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle('hidden', isSearchActive || visibleLimit >= blogCards.length);
    }
    if (loadMoreCount) {
      loadMoreCount.classList.toggle('hidden', isSearchActive);
    }

    // Update result count
    if (resultCount) {
      if (isSearchActive && visibleCount > 0) {
        resultText.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align: -2px; margin-right: 0.35rem;"><path d="M4 6h16M4 12h10M4 18h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' + visibleCount + (visibleCount === 1 ? ' article' : ' articles') + ' found';
        resultCount.classList.add('visible');
      } else {
        resultText.textContent = '';
        resultCount.classList.remove('visible');
      }
    }

    if (noResults) {
      noResults.classList.toggle('visible', isSearchActive && visibleCount === 0);
    }
  }
  
  function clearSearch() {
    searchInput.value = '';
    updateClearButtonVisibility();
    isSearchActive = false;
    visibleLimit = INITIAL_POSTS;
    sessionStorage.removeItem('blogsVisibleLimit');
    sessionStorage.removeItem('blogsScrollY');
    showPosts();
    searchContainer.classList.remove('active');
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', function() {
      visibleLimit += INITIAL_POSTS;
      sessionStorage.setItem('blogsVisibleLimit', visibleLimit);
      showPosts();
    });
  }

  // Save scroll position on navigation away
  window.addEventListener('pagehide', function() {
    sessionStorage.setItem('blogsScrollY', window.scrollY);
  });
  
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
    } else {
      showPosts();
    }
  });

  // Initialize
  const navType = performance.getEntriesByType('navigation')[0]?.type;
  if (navType !== 'back_forward') {
    sessionStorage.removeItem('blogsVisibleLimit');
    sessionStorage.removeItem('blogsScrollY');
    visibleLimit = INITIAL_POSTS;
  }
  showPosts();
  const savedScrollY = parseInt(sessionStorage.getItem('blogsScrollY'));
  if (savedScrollY) {
    setTimeout(() => window.scrollTo(0, savedScrollY), 400);
  }
})();
