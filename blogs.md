---
layout: architect
title: Blogs
hide_header: true
---

## Writing

Thoughts on architecture, system design, cloud trade-offs, and lessons learned while building real-world systems.

---

{% for post in site.posts %}
### [{{ post.title }}]({{ post.url }})

<small>{{ post.date | date: "%B %d, %Y" }}</small>

{{ post.excerpt | strip_html | truncatewords: 65 }}

[Read more →]({{ post.url }})

---
{% endfor %}
