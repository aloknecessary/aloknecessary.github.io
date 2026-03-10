function highlightActiveTag() {
  document.querySelectorAll('.tag-block').forEach(el => {
    el.classList.remove('active');
  });

  const hash = window.location.hash.substring(1);
  if (!hash) return;

  const active = document.getElementById(hash);
  if (active) {
    active.classList.add('active');
  }
}

highlightActiveTag();
window.addEventListener('hashchange', highlightActiveTag);

if (window.location.hash) {
  const target = document.querySelector(window.location.hash);
  if (target) {
    target.scrollIntoView({ behavior: "smooth" });
  }
}
