---
layout: default
title: Blogs
hide_header: false
---
<nav style="margin-bottom:24px; font-size:0.95rem;">
  <a href="{{ '/' | relative_url }}">Home</a>
</nav>

## The Technical Compendium
{% assign blogs = site.blogs | sort: "date" | reverse %}
{% for post in blogs %}

### [{{ post.title }}]({{ post.url }})

<small>{{ post.date | date: "%B %d, %Y" }} • {{ post.content | number_of_words | divided_by: 200 | plus: 1 }} min read</small>

{{ post.excerpt | strip_html | truncatewords: 65 }}

{% if post.tags %}
  <div class="post-tags">
    {% for tag in post.tags %}
    <a href="{{ '/tags/#' | append: tag | relative_url }}" class="tag"> #{{ tag }}
    </a>
    {% endfor %}
  </div>
{% endif %}

[Read more →]({{ post.url }})

---

{% endfor %}
