---
layout: architect
title: Blogs
hide_header: true
---

## Writing


{% for post in site.posts %}
### [{{ post.title }}]({{ post.url }})


<small>{{ post.date | date: "%B %d, %Y" }} • {{ post.content | number_of_words | divided_by: 200 | plus: 1 }} min read</small>


{{ post.excerpt | strip_html | truncatewords: 30 }}


{% if post.tags %}
<small>Tags: {{ post.tags | join: ", " }}</small>
{% endif %}


[Read more →]({{ post.url }})

---
{% endfor %}
