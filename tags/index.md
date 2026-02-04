---
layout: default
title: Tags
hide_header: true
---

<nav style="margin-bottom:24px; margin-left: -20px; margin-top: 20px; font-size:0.95rem;">
  <a href="{{ '/blogs' | relative_url }}">← Back to Blogs</a> |
  <a href="{{ '/' | relative_url }}">Home</a>
</nav>

<h1>Tags</h1>

<p style="color:#6b7280; margin-bottom:32px;">
  Browse posts by topic.
</p>

{% assign all_tags = "" | split: "" %}

{%- for post in site.blogs -%}
{%- for tag in post.tags -%}
{%- unless all_tags contains tag -%}
{% assign all_tags = all_tags | push: tag %}
{%- endunless -%}
{%- endfor -%}
{%- endfor -%}

{% assign all_tags = all_tags | sort %}

{% for tag in all_tags %}

{% assign tagged_posts = site.blogs | where_exp: "post", "post.tags contains tag" %}
{% assign count = tagged_posts | size %}

  <section style="margin-bottom:40px;">
    <h2 id="{{ tag | slugify }}" class="tag-heading">
      #{{ tag }}
      <span style="color:#6b7280; font-size:0.9rem;">({{ count }})</span>
    </h2>

    <ul style="padding-left:18px;">
      {% for post in tagged_posts %}
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
  h2::before {
    top: 10px;
  }

  h2.active::before {
    display: none !important;
  }
  
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
    padding-left: 20px;
    margin-left: -14px;
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
