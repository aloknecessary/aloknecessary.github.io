---
layout: default
title: Tags
---

<h1>Tags</h1>

<p>Browse posts by topic.</p>

{% assign tags = site.tags | sort %}

{% for tag in tags %}
  <h2 id="{{ tag[0] }}">#{{ tag[0] }}</h2>
  <ul>
    {% for post in tag[1] %}
      <li>
        <a href="{{ post.url | relative_url }}">
          {{ post.title }}
        </a>
        <small style="color:#6b7280;">
          — {{ post.date | date: "%B %d, %Y" }}
        </small>
      </li>
    {% endfor %}
  </ul>
{% endfor %}
