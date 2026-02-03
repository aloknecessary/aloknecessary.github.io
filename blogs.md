---
layout: architect
title: Blogs
hide_header: true
---


## Writing

{% for post in site.posts %}

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
