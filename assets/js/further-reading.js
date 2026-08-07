(function () {
  const content = document.querySelector('.post-content');
  if (!content) return;

  content.querySelectorAll('p').forEach(function (p) {
    const match = p.textContent.trim().match(/^(further reading|references)/i);
    if (!match) return;

    const details = document.createElement('details');
    details.className = 'further-reading';

    const summary = document.createElement('summary');
    // summary.textContent = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    summary.textContent = 'References & Further Reading';

    const body = document.createElement('p');
    body.className = 'further-reading-body';
    // Preserve inner HTML (italic/bold markup rendered by kramdown)
    body.innerHTML = p.innerHTML.replace(/^<(em|strong)>(further reading|references):?\s*/i, '<$1>').replace(/^(further reading|references):?\s*/i, '');

    details.appendChild(summary);
    details.appendChild(body);
    p.replaceWith(details);
  });
})();
