---
layout: default
title: Tags
---

<nav style="margin-bottom:24px; font-size:0.95rem;">
  <a href="{{ '/blogs' | relative_url }}">← Back to Blogs</a> |
  <a href="{{ '/' | relative_url }}">Home</a>
</nav>

<h1>Tags</h1>

<p style="color:#6b7280; margin-bottom:32px;">
  Browse posts by topic.
</p>

{% assign tags = site.tags | sort %}

{% for tag in tags %}
{% assign tag_name = tag[0] %}
{% assign posts = tag[1] %}
{% assign count = posts | size %}

  <section style="margin-bottom:40px;">
    <h2 id="{{ tag_name }}" class="tag-heading">
      #{{ tag_name }}
      <span style="color:#6b7280; font-size:0.9rem;">({{ count }})</span>
    </h2>

    <ul style="padding-left:18px;">
      {% for post in posts %}
        <li style="margin-bottom:6px;">
          <a href="{{ post.url | relative_url }}">
            {{ post.title }}
          </a>
          <small style="color:#6b7280;">
            — {{ post.date | date: "%B %d, %Y" }}
          </small>
        </li>
      {% endfor %}
    </ul>

  </section>
{% endfor %}

<style>
  .tag-heading {
    scroll-margin-top: 80px;
    transition: background-color 0.3s ease;
    padding: 4px 6px;
    border-radius: 6px;
  }

  .tag-heading.active {
    background-color: #eef2ff;
    color: #1e3a8a;
    border-left: 4px solid #6366f1;
    padding-left: 10px;
  }
</style>

<script>
  function highlightActiveTag() {
    // Remove existing highlights
    document.querySelectorAll('.tag-heading').forEach(el => {
      el.classList.remove('active');
    });

    // Get hash without #
    const hash = window.location.hash.substring(1);
    if (!hash) return;

    const active = document.getElementById(hash);
    if (active) {
      active.classList.add('active');
    }
  }

  // Run on load
  highlightActiveTag();

  // Run when hash changes
  window.addEventListener('hashchange', highlightActiveTag);
</script>

