(function() {
  const searchToggle = document.getElementById('search-toggle');
  const searchInput = document.getElementById('blog-search');
  const searchClear = document.getElementById('search-clear');
  const searchContainer = document.querySelector('.search-container');
  const noResults = document.getElementById('no-results');
  const clearSearchLink = document.getElementById('clear-search-link');
  
  if (!searchToggle || !searchInput || !searchClear || !searchContainer) return;

  const blogCards = document.querySelectorAll('.blog-card');
  let debounceTimer;
  
  function updateClearButtonVisibility() {
    if (searchInput.value.trim().length > 0) {
      searchContainer.classList.add('has-text');
    } else {
      searchContainer.classList.remove('has-text');
    }
  }
  
  function filterBlogs(searchTerm) {
    let visibleCount = 0;
    
    blogCards.forEach(card => {
      const title = card.querySelector('.card-title')?.textContent.toLowerCase() || '';
      const description = card.querySelector('.card-excerpt')?.textContent.toLowerCase() || '';
      const tags = Array.from(card.querySelectorAll('.card-tags .tag')).map(tag => tag.textContent.toLowerCase()).join(' ');
      
      const matches = title.includes(searchTerm) || 
                     description.includes(searchTerm) || 
                     tags.includes(searchTerm);
      
      card.style.display = matches ? '' : 'none';
      if (matches) visibleCount++;
    });
    
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
      filterBlogs(searchTerm);
    }, 300);
  });
  
  // Clear search button
  searchClear.addEventListener('click', clearSearch);
  
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
})();
