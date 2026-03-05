(function() {
  const searchToggle = document.getElementById('search-toggle');
  const searchInput = document.getElementById('blog-search');
  const searchClear = document.getElementById('search-clear');
  const searchContainer = document.querySelector('.search-container');
  
  if (!searchToggle || !searchInput || !searchClear || !searchContainer) return;

  const blogCards = document.querySelectorAll('.blog-card');
  let debounceTimer;
  
  function filterBlogs(searchTerm) {
    blogCards.forEach(card => {
      const title = card.querySelector('.card-title')?.textContent.toLowerCase() || '';
      const description = card.querySelector('.card-excerpt')?.textContent.toLowerCase() || '';
      const tags = Array.from(card.querySelectorAll('.card-tags .tag')).map(tag => tag.textContent.toLowerCase()).join(' ');
      
      const matches = title.includes(searchTerm) || 
                     description.includes(searchTerm) || 
                     tags.includes(searchTerm);
      
      card.style.display = matches ? '' : 'none';
    });
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
    
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      filterBlogs(searchTerm);
    }, 300);
  });
  
  // Clear search
  searchClear.addEventListener('click', function() {
    searchInput.value = '';
    filterBlogs('');
    searchContainer.classList.remove('active');
  });
  
  // Close search on outside click
  document.addEventListener('click', function(e) {
    if (!searchContainer.contains(e.target) && searchInput.value.trim() === '') {
      searchContainer.classList.remove('active');
    }
  });
})();
