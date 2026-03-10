---
layout: architect
title: Byteridge Journey | Alok Ranjan Daftuar
hide_header: false
---

<link rel="stylesheet" href="{{ '/assets/css/journey.css' | relative_url }}" />

<header class="hero" role="banner">
  <div class="hero-bg"></div>
  <div class="hero-content">
    <a href="{{ '/' | relative_url }}" class="hero-back">← Back to Portfolio</a>
    <p class="hero-eyebrow">Engineering Journey · Byteridge</p>
    <h1 class="hero-name">10+ Years of<br><span>Building & Leading</span></h1>
    <p class="hero-role">Full Stack Developer → Engineering Lead → Solution Architect  ·  2014 – Present</p>
    <p class="hero-tagline">
      A decade-long journey across fintech, hospitality IoT, enterprise security, media, developer tooling,
      and global tech — evolving from a solo developer with total stack ownership to leading 40+ person
      engineering organisations and defining architectural strategy at scale.
    </p>
    <div class="hero-stats">
      <div class="stat"><span class="stat-value">10<span>+</span></span><span class="stat-label">Years at Byteridge</span></div>
      <div class="stat"><span class="stat-value">9<span>+</span></span><span class="stat-label">Projects Delivered</span></div>
      <div class="stat"><span class="stat-value">40<span>+</span></span><span class="stat-label">Team Members Led</span></div>
      <div class="stat"><span class="stat-value">100K<span>+</span></span><span class="stat-label">Records / Import</span></div>
    </div>
  </div>
</header>

<section class="timeline-section" aria-label="Project timeline">
  <div class="container">
    <div class="section-header reveal">
      <p class="section-tag">Chronological Journey</p>
      <h2 class="section-title">Projects & Impact</h2>
      <p class="section-subtitle">Every engagement — internal client and contracted — that shaped the engineer and leader.</p>
    </div>
    <div class="timeline">
      <!-- CCMR3 -->
      <article class="timeline-item" data-color="blue" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Jun 2023 — Present</span>
          <span class="timeline-badge badge-arch badge-current">Solution Architect</span>
          <span class="timeline-badge badge-lead">Engineering Lead</span>
        </div>
        <h3 class="timeline-title" itemprop="name">CCMR3 — CollectLogic</h3>
        <p class="timeline-company">Financial Services · Debt Collection & Management Platform</p>
        <div class="project-card reveal">
          <div class="card-top">
            <span class="card-title">Fintech Platform Modernisation</span>
            <div class="metrics-row">
              <div class="metric-chip"><span class="metric-icon">👥</span><span class="metric-val">40<span style="color:var(--muted)">+</span></span><span class="metric-key">Team</span></div>
              <div class="metric-chip"><span class="metric-icon">📊</span><span class="metric-val">500<span style="color:var(--muted)">+</span></span><span class="metric-key">Daily Active Users</span></div>
              <div class="metric-chip"><span class="metric-icon">📦</span><span class="metric-val">100K<span style="color:var(--muted)">+</span></span><span class="metric-key">Records / Import</span></div>
            </div>
          </div>
          <p class="card-desc">A prominent financial services company specialising in debt collection rebuilt their core platform — CollectLogic — from a legacy system into a modern, cloud-native application handling complex regulatory operations at scale.</p>
          <div class="divider"></div>
          <p class="card-section-label">Phase 1 — Engineering Lead</p>
          <ul class="highlight-list">
            <li>Architected containerised infrastructure; defined Docker/Kubernetes deployment topology on Azure AKS from scratch.</li>
            <li>Designed and implemented GitHub Actions CI/CD pipelines across all services — backend APIs, frontend, and integration workers.</li>
            <li>Led complex database migration: schema normalisation, deduplication, and data integrity enforcement across a large legacy dataset.</li>
            <li>Integrated third-party payment and data services: <strong>Live Vox, Tradeline, USAePay, Choice,</strong> and <strong>Razorpay</strong>.</li>
            <li>Implemented Redis caching delivering significant, measurable performance improvements over the legacy system.</li>
            <li>Coordinated 40+ team members across Dev, QA, and Leads to a successful <strong>Go-Live on April 29th 2024</strong>.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Phase 2 — Solution Architect</p>
          <ul class="highlight-list">
            <li>Defined long-term technical strategy, architectural roadmap, and cross-team design standards.</li>
            <li>Drove system design reviews ensuring all new development aligns with architectural principles and NFRs.</li>
            <li>Collaborated with Business Analysts to translate business requirements into concrete architecture decisions.</li>
            <li>Mentored senior engineers and maintained alignment between stakeholder expectations and delivery.</li>
          </ul>
          <div class="callout-box">
            <strong>Bulk Data Operations at Scale</strong><br>
            Designed and delivered a high-throughput bulk import system supporting <strong>100,000+ records per operation</strong>.
            The system handles both workflow-driven imports (via configurable business workflows) and direct generic update
            modules for mass record updates. Additionally, automated SFTP-based ingestion pipelines allow records to be
            updated from controlled SFTP endpoints configured via a third-party service — enabling scheduled,
            zero-touch data synchronisation for client integrations.
          </div>
          <div class="callout-box" style="border-left-color: var(--accent3); background: rgba(139,92,246,0.06); border-color: rgba(139,92,246,0.18);">
            <strong>Automated & Manual Workflows — Quartz Scheduler Microservice</strong><br>
            Built a dedicated workflow engine powered by <strong>Quartz Scheduler</strong>, deployed as a standalone
            microservice. The system supports both <em>automated</em> workflows (time-triggered or event-driven, running
            hands-free on schedule) and <em>manual</em> workflows (operator-initiated, configurable multi-step processes).
            Workflows orchestrate actions across the platform — from data updates and bulk operations to notifications and
            status transitions — giving business stakeholders full control over operational logic without touching code.
          </div>
          <div class="callout-box" style="border-left-color: var(--accent2); background: rgba(6,182,212,0.06); border-color: rgba(6,182,212,0.18);">
            <strong>Custom SQL Query Module — Secure Read-only Execution</strong><br>
            Delivered a powerful in-app SQL query execution module enabling DBAs and authorised stakeholders to write and
            run custom SQL queries directly within the platform — with results rendered inline. For security, the module
            is strictly <strong>read-only</strong>: all write operations are blocked at the application layer, ensuring
            no risk of accidental or unauthorised data modification while still giving technical users the flexibility
            they need for ad-hoc analysis and reporting.
          </div>
          <div class="callout-box" style="border-left-color: var(--green); background: rgba(16,185,129,0.06); border-color: rgba(16,185,129,0.18);">
            <strong>Task Management Module</strong><br>
            Built a purpose-built task system where administrators can create, assign, and track tasks for individual
            agents — enabling structured work management across the collections team. Tasks carry priority, due dates,
            status tracking, and assignment history, giving supervisors visibility into workload distribution and
            ensuring no follow-up or action item falls through the cracks.
          </div>
          <div class="callout-box" style="border-left-color: var(--gold); background: rgba(245,158,11,0.06); border-color: rgba(245,158,11,0.18);">
            <strong>Role-aware Dashboards — Agent & Admin Views</strong><br>
            Designed a dual-mode dashboard system. Each <em>agent</em> sees a personalised dashboard reflecting their
            own daily progress — calls handled, tasks completed, targets vs. actuals — keeping individuals accountable
            and motivated. <em>Admins</em> get a consolidated team-wide view with the ability to filter by agent, date
            range, or metric — enabling supervisors to monitor overall team health and drill into individual performance
            without leaving the platform.
          </div>
          <div class="divider"></div>
          <p class="card-section-label">Architectural Decisions</p>
          <div class="arch-pills">
            <span class="arch-pill">Redis Caching</span>
            <span class="arch-pill">Azure AKS</span>
            <span class="arch-pill">GitHub Actions CI/CD</span>
            <span class="arch-pill">Bulk Import Engine (100K+)</span>
            <span class="arch-pill">SFTP Automated Ingestion</span>
            <span class="arch-pill">Quartz Scheduler Microservice</span>
            <span class="arch-pill">Read-only SQL Execution Module</span>
            <span class="arch-pill">Role-aware Dashboards</span>
            <span class="arch-pill">Schema Normalisation</span>
            <span class="arch-pill">Containerised Microservices</span>
          </div>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">.NET</span><span class="tech-tag">React</span><span class="tech-tag">Node.js</span>
            <span class="tech-tag">MSSQL</span><span class="tech-tag">Redis</span><span class="tech-tag">Azure AKS</span>
            <span class="tech-tag">Docker</span><span class="tech-tag">Kubernetes</span><span class="tech-tag">GitHub Actions</span>
            <span class="tech-tag">Quartz Scheduler</span><span class="tech-tag">SFTP Integration</span>
          </div>
        </div>
      </article>
      <!-- TASC -->
      <article class="timeline-item" data-color="cyan" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Jan 2023 — May 2023</span>
          <span class="timeline-badge badge-lead">Engineering Lead</span>
        </div>
        <h3 class="timeline-title" itemprop="name">TASC — Threat Assessment &amp; Security Centre</h3>
        <p class="timeline-company">Enterprise Security · Crisis Management &amp; Business Continuity Platform</p>
        <div class="project-card reveal">
          <div class="card-top">
            <span class="card-title">Greenfield Build in 5 Months</span>
            <div class="metrics-row">
              <div class="metric-chip"><span class="metric-icon">👥</span><span class="metric-val">5–8</span><span class="metric-key">Team Size</span></div>
              <div class="metric-chip"><span class="metric-icon">🚀</span><span class="metric-val">0 → 1</span><span class="metric-key">Greenfield</span></div>
            </div>
          </div>
          <p class="card-desc">TASC helps enterprises remain resilient — democratising crisis management, travel security, and business continuity by lifting the exclusivity that typically surrounds these critical practices.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Led a compact 5–8 person team delivering a complete platform from greenfield to production.</li>
            <li>Applied caching strategies ensuring reliable, low-latency performance for a security-critical platform.</li>
            <li>Managed sprint execution with the Scrum Master; conducted detailed story grooming with BAs.</li>
            <li>Architected and deployed the full application on AWS with complete CI/CD automation.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">React (Next.js)</span><span class="tech-tag">Node.js</span><span class="tech-tag">Tailwind</span>
            <span class="tech-tag">PostgreSQL</span><span class="tech-tag">AWS</span><span class="tech-tag">GitHub Actions</span>
          </div>
        </div>
      </article>
      <!-- DeviceThread -->
      <article class="timeline-item" data-color="purple" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Jan 2022 — Jan 2023</span>
          <span class="timeline-badge badge-lead">Engineering Lead</span>
        </div>
        <h3 class="timeline-title" itemprop="name">DeviceThread</h3>
        <p class="timeline-company">Hospitality IoT · Smart Hotel Infrastructure &amp; Device Management</p>
        <div class="project-card reveal">
          <div class="card-top">
            <span class="card-title">IoT Platform for Smart Hotels</span>
            <div class="metrics-row">
              <div class="metric-chip"><span class="metric-icon">👥</span><span class="metric-val">10<span style="color:var(--muted)">+</span></span><span class="metric-key">Team</span></div>
              <div class="metric-chip"><span class="metric-icon">🏨</span><span class="metric-val">10–15</span><span class="metric-key">Hotel Deployments</span></div>
            </div>
          </div>
          <p class="card-desc">DeviceThread is the digital backbone for hospitality properties hosting smart devices — enabling owners, managers, and staff to monitor, manage, secure, and automate their entire digital infrastructure from a single platform.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Led backend and frontend teams across 10+ members, coordinating microservices integration across IoT device layers.</li>
            <li>Introduced <strong>message queue architecture</strong> for asynchronous device event processing — the foundational reliability decision for the platform.</li>
            <li>Implemented caching to reduce response latency for real-time device state queries across all hotel properties.</li>
            <li>Delivered platform from greenfield — live across 10–15 hotel properties at project close.</li>
            <li>Managed containerised deployments and CI/CD pipelines via Docker and GitHub Actions on AWS.</li>
          </ul>
          <div class="callout-box">
            <strong>Samsung SmartThings — Deep IoT Integration</strong><br>
            SmartThings served as the backbone of all smart device control within the platform. The integration enabled
            real-time monitoring and remote management of smart locks, thermostats, lighting, switches, and sensors across
            hotel properties. Events from SmartThings were ingested asynchronously via message queues, processed, and
            surfaced to staff and management dashboards — ensuring no device state change was ever missed or delayed.
          </div>
          <div class="callout-box" style="border-left-color: var(--accent2); background: rgba(6,182,212,0.06); border-color: rgba(6,182,212,0.18);">
            <strong>CloudBeds — Property Management System Integration</strong><br>
            CloudBeds provided the hospitality operations layer — guest reservations, room assignments, check-in/check-out
            events, and billing. DeviceThread integrated deeply with the CloudBeds API so that device automations could
            be triggered by PMS events: room access credentials auto-provisioned on guest check-in, revoked on check-out,
            and thermostat schedules adjusted based on occupancy state — creating a fully connected, automated guest experience.
          </div>
          <div class="divider"></div>
          <p class="card-section-label">Architectural Decisions</p>
          <div class="arch-pills">
            <span class="arch-pill">SmartThings IoT Integration</span>
            <span class="arch-pill">CloudBeds PMS Integration</span>
            <span class="arch-pill">Message Queues (async events)</span>
            <span class="arch-pill">Caching Layer</span>
            <span class="arch-pill">Microservices</span>
            <span class="arch-pill">Docker + AWS</span>
            <span class="arch-pill">CI/CD via GitHub Actions</span>
          </div>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">Node.js</span><span class="tech-tag">Flutter</span><span class="tech-tag">PostgreSQL</span>
            <span class="tech-tag">AWS</span><span class="tech-tag">Docker</span><span class="tech-tag">GitHub Actions</span>
            <span class="tech-tag">SmartThings API</span><span class="tech-tag">CloudBeds API</span><span class="tech-tag">Message Queues</span>
          </div>
        </div>
      </article>
      <!-- Arre CMS -->
      <article class="timeline-item" data-color="cyan" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Jan 2022 — Jun 2022</span>
          <span class="timeline-badge badge-lead">Engineering Lead</span>
        </div>
        <h3 class="timeline-title" itemprop="name">Arre CMS — Arre Voice</h3>
        <p class="timeline-company">Media &amp; Entertainment · Women-first Mobile App Content Platform</p>
        <div class="project-card reveal">
          <p class="card-desc">A content management system for Arre's women-first mobile app, <em>Arre Voice</em> — managing content delivery, user engagement monitoring, push notifications, and analytics.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Led backend and frontend teams, ensuring seamless API integration between CMS and the mobile app.</li>
            <li>Managed AWS cloud deployments and ArangoDB cloud database operations.</li>
            <li>Delivered CMS features including notification dispatch, analytics dashboards, and content scheduling.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">React</span><span class="tech-tag">Node.js</span><span class="tech-tag">ArangoDB</span><span class="tech-tag">AWS</span>
          </div>
        </div>
      </article>
      <!-- ifUiWill -->
      <article class="timeline-item" data-color="green" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">May 2020 — Dec 2020</span>
          <span class="timeline-badge badge-lead">Engineering Lead</span>
        </div>
        <h3 class="timeline-title" itemprop="name">ifUiWill</h3>
        <p class="timeline-company">Social Mobile Application · Challenge &amp; Task Collaboration</p>
        <div class="project-card reveal">
          <p class="card-desc">ifUiWill is a mobile platform where users create and issue challenges to each other — community-driven task engagement with a "you go, then I go" mechanic at its core.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Designed the application architecture, built RESTful APIs, and led frontend development for a seamless cross-platform experience.</li>
            <li>Managed a team of developers — code reviews, push notification integration, testing, and debugging.</li>
            <li>Handled full deployment to both App Store and Play Store; received positive reception on usability.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">Node.js</span><span class="tech-tag">React Native</span><span class="tech-tag">MongoDB</span>
            <span class="tech-tag">AWS</span><span class="tech-tag">App Store</span><span class="tech-tag">Play Store</span>
          </div>
        </div>
      </article>
      <!-- Microsoft -->
      <article class="timeline-item" data-color="blue" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Dec 2020 — Dec 2021</span>
          <span class="timeline-badge badge-ic">Individual Contributor</span>
          <span class="timeline-badge badge-react">React Engineer</span>
        </div>
        <h3 class="timeline-title" itemprop="name">Microsoft — Bing &amp; MS Admin Portal</h3>
        <p class="timeline-company">External engineer via Byteridge · Global Search &amp; Enterprise Productivity</p>
        <div class="project-card reveal">
          <div class="callout-box" style="margin-top:0; margin-bottom:1.5rem;">
            Engaged as a contracted React engineer via Byteridge — contributing directly to two of Microsoft's most
            high-scale web products: <strong>Bing Search</strong> and the <strong>Microsoft 365 Admin Portal</strong>.
            Working in this environment meant operating at a scale where UI decisions affect millions of users daily.
          </div>
          <p class="card-section-label">Bing Search — Work Vertical</p>
          <ul class="highlight-list">
            <li>Contributed to the <strong>"Files Result in Work Vertical"</strong> feature — integrating work-related file search results directly into Bing's enterprise search experience.</li>
            <li>Integrated the <strong>"Did You Mean?"</strong> suggestion service, surfacing alternative queries for typos and improving search accuracy and user satisfaction at scale.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Microsoft 365 Admin Portal</p>
          <ul class="highlight-list">
            <li>Modernised a legacy location service to consume updated API response schemas — ensuring accurate, real-time location data across enterprise admin workflows.</li>
            <li>Participated in cross-functional code reviews, adhering to Microsoft's exacting standards for code quality and performance.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">React.js</span><span class="tech-tag">TypeScript</span>
            <span class="tech-tag">REST APIs</span><span class="tech-tag">Enterprise Design Systems</span>
          </div>
        </div>
      </article>
      <!-- Singlefile -->
      <article class="timeline-item" data-color="purple" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">May 2019 — Apr 2020</span>
          <span class="timeline-badge badge-react">React Engineer</span>
        </div>
        <h3 class="timeline-title" itemprop="name">Singlefile — Techstars</h3>
        <p class="timeline-company">External engineer via Byteridge · Compliance Filing Platform (Techstars-backed)</p>
        <div class="project-card reveal">
          <p class="card-desc">SingleFile.io is a digital filing platform enabling companies, advisory firms, and investor organisations to streamline the required filing of secretary of state documents — turning complex regulatory workflows into clean digital experiences.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Developed and enhanced user interfaces for compliance filing workflows — dynamic form rendering, multi-step validation, and guided filing flows.</li>
            <li>Implemented robust client-side state management to ensure form data integrity across complex, multi-field compliance submissions.</li>
            <li>Collaborated with backend teams to integrate APIs and handle edge cases in regulatory data requirements.</li>
            <li>Transformed complex regulatory filing tasks into intuitive UI flows — measurably improving user efficiency.</li>
            <li>Operated in a Techstars-grade engineering culture: fast iteration, high code standards, strong product ownership.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">React</span><span class="tech-tag">React Native</span><span class="tech-tag">Tailwind</span><span class="tech-tag">AWS</span><span class="tech-tag">REST APIs</span>
          </div>
        </div>
      </article>
      <!-- Rhythmos -->
      <article class="timeline-item" data-color="gold" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Nov 2018 — Apr 2019</span>
          <span class="timeline-badge badge-full">.NET Engineer</span>
        </div>
        <h3 class="timeline-title" itemprop="name">Rhythmos — Unity Dockworks</h3>
        <p class="timeline-company">Developer Tooling · Automated Documentation Generation from Source Code</p>
        <div class="project-card reveal">
          <p class="card-desc">Unity Dockworks was an application designed to generate structured technical documentation directly from source code — pulling repositories, analysing each file, and producing human-readable documentation automatically.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Designed and implemented backend APIs in .NET to automate documentation generation from code repository analysis.</li>
            <li>Built and optimised backend services enabling seamless integration with diverse repository structures and file types.</li>
            <li>Collaborated closely with frontend developers on API contracts and data flow; contributed to team bug fixes and iterations.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">.NET</span><span class="tech-tag">REST APIs</span><span class="tech-tag">Source Code Analysis</span>
          </div>
        </div>
      </article>
      <!-- Aeries -->
      <article class="timeline-item" data-color="cyan" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">Apr 2018 — Oct 2018</span>
          <span class="timeline-badge badge-react">Frontend Engineer</span>
        </div>
        <h3 class="timeline-title" itemprop="name">Aeries — Project Mitra</h3>
        <p class="timeline-company">Web Application · Full Frontend Ownership</p>
        <div class="project-card reveal">
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Owned the end-to-end frontend build with no predefined UX designs — conceptualised, designed, and built the full UI from scratch.</li>
            <li>Integrated APIs ensuring seamless communication between frontend and backend services.</li>
            <li>Conducted thorough frontend testing and managed cloud deployment of the production build independently.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">React</span><span class="tech-tag">REST APIs</span><span class="tech-tag">Cloud Deployment</span>
          </div>
        </div>
      </article>
      <!-- Valley Proteins -->
      <article class="timeline-item" data-color="gold" itemscope itemtype="https://schema.org/Project">
        <div class="timeline-node"></div>
        <div class="timeline-meta">
          <span class="timeline-date">2014 — Apr 2018</span>
          <span class="timeline-badge badge-full">Full Stack Developer</span>
        </div>
        <h3 class="timeline-title" itemprop="name">Valley Proteins — "Blue" CRM</h3>
        <p class="timeline-company">Enterprise CRM · Sales &amp; Lead Management Modernisation</p>
        <div class="project-card reveal">
          <p class="card-desc">Valley Proteins required a full rebuild of their legacy desktop VB-based CRM — into a web-accessible system with a normalised database, real-time sales reporting, and a clean, maintainable architecture.</p>
          <p class="card-section-label">Contributions &amp; Impact</p>
          <ul class="highlight-list">
            <li>Sole developer for ~3 years — owned everything: database design, stored procedures, APIs, full frontend, and IIS deployment.</li>
            <li>Designed the complete database schema and wrote complex stored procedures to replace a tightly coupled, un-normalised legacy data layer.</li>
            <li>Built a custom Crystal Reports module delivering numerous uniquely specified reports with precision and iteration speed.</li>
            <li>Handled production deployment on a physical IIS server via remote desktop — total end-to-end ownership including ops.</li>
            <li>Maintained daily client communication — gathering requirements directly and translating them into working software.</li>
            <li>This project established the foundation of self-reliance, full-cycle ownership, and direct client communication that has defined every role since.</li>
          </ul>
          <div class="divider"></div>
          <p class="card-section-label">Tech Stack</p>
          <div class="tech-stack">
            <span class="tech-tag">.NET</span><span class="tech-tag">jQuery</span><span class="tech-tag">Bootstrap</span><span class="tech-tag">MSSQL</span>
            <span class="tech-tag">Crystal Reports</span><span class="tech-tag">IIS</span>
          </div>
        </div>
      </article>
    </div>
  </div>
</section>

<!-- SKILLS -->
<section class="skills-section" aria-label="Core competencies">
  <div class="container">
    <div class="section-header reveal">
      <p class="section-tag">Core Competencies</p>
      <h2 class="section-title">Technical Arsenal</h2>
      <p class="section-subtitle">The full-stack of skills forged across every engagement.</p>
    </div>
    <div class="skills-grid">
      <div class="skill-card reveal">
        <div class="skill-card-title">Frontend Engineering</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=white" alt="React" />
          <img src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js" />
          <img src="https://img.shields.io/badge/React_Native-61DAFB?style=for-the-badge&logo=react&logoColor=white" alt="React Native" />
          <img src="https://img.shields.io/badge/Flutter-02569B?style=for-the-badge&logo=flutter&logoColor=white" alt="Flutter" />
          <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
          <img src="https://img.shields.io/badge/Angular-DD0031?style=for-the-badge&logo=angular&logoColor=white" alt="Angular" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">Backend Engineering</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
          <img src="https://img.shields.io/badge/.NET-512BD4?style=for-the-badge&logo=dotnet&logoColor=white" alt=".NET" />
          <img src="https://img.shields.io/badge/C%23-239120?style=for-the-badge&logo=sharp&logoColor=white" alt="C#" />
          <img src="https://img.shields.io/badge/REST_APIs-FF6B6B?style=for-the-badge" alt="REST APIs" />
          <img src="https://img.shields.io/badge/Microservices-FF6B6B?style=for-the-badge" alt="Microservices" />
          <img src="https://img.shields.io/badge/Message_Queues-FFA500?style=for-the-badge" alt="Message Queues" />
          <img src="https://img.shields.io/badge/SFTP_Integration-4ECDC4?style=for-the-badge" alt="SFTP Integration" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">Cloud & Infrastructure</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/AWS-FF9900?style=for-the-badge&logo=amazon&logoColor=white" alt="AWS" />
          <img src="https://img.shields.io/badge/Azure_AKS-0078D4?style=for-the-badge&logo=microsoft-azure&logoColor=white" alt="Azure AKS" />
          <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
          <img src="https://img.shields.io/badge/Kubernetes-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white" alt="Kubernetes" />
          <img src="https://img.shields.io/badge/IIS-0078D4?style=for-the-badge" alt="IIS" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">CI/CD & DevOps</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white" alt="GitHub Actions" />
          <img src="https://img.shields.io/badge/Docker_Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Compose" />
          <img src="https://img.shields.io/badge/Container_Registry-4ECDC4?style=for-the-badge" alt="Container Registry" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">Databases & Data</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/PostgreSQL-336791?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
          <img src="https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
          <img src="https://img.shields.io/badge/MSSQL-CC2927?style=for-the-badge&logo=microsoft-sql-server&logoColor=white" alt="MSSQL" />
          <img src="https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white" alt="MySQL" />
          <img src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
          <img src="https://img.shields.io/badge/ArangoDB-6BA642?style=for-the-badge" alt="ArangoDB" />
          <img src="https://img.shields.io/badge/Neo4j-008CC1?style=for-the-badge&logo=neo4j&logoColor=white" alt="Neo4j" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">Architecture & Design</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/System_Design-4ECDC4?style=for-the-badge" alt="System Design" />
          <img src="https://img.shields.io/badge/Solution_Design-4ECDC4?style=for-the-badge" alt="Solution Design" />
          <img src="https://img.shields.io/badge/Caching_Strategy-FFA500?style=for-the-badge" alt="Caching Strategy" />
          <img src="https://img.shields.io/badge/Queue_Architecture-FFA500?style=for-the-badge" alt="Queue Architecture" />
          <img src="https://img.shields.io/badge/Bulk_Data_Processing-FF6B6B?style=for-the-badge" alt="Bulk Data Processing" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">AI & Integrations</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/Azure_AI_Foundry-0078D4?style=for-the-badge&logo=microsoft-azure&logoColor=white" alt="Azure AI Foundry" />
          <img src="https://img.shields.io/badge/Prompt_Engineering-9C27B0?style=for-the-badge" alt="Prompt Engineering" />
          <img src="https://img.shields.io/badge/RAG-FF6B6B?style=for-the-badge" alt="RAG" />
          <img src="https://img.shields.io/badge/Custom_Copilots-9C27B0?style=for-the-badge" alt="Custom Copilots" />
          <img src="https://img.shields.io/badge/Power_Platform-0078D4?style=for-the-badge" alt="Power Platform" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">Cost Optimization</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/FinOps-Cert._Practices-00C853?style=for-the-badge&logo=chartdotjs&logoColor=white" alt="FinOps" />
          <img src="https://img.shields.io/badge/Cloud-Cost_Aware-FF9900?style=for-the-badge&logo=icloud&logoColor=white" alt="Cloud Cost" />
          <img src="https://img.shields.io/badge/K8s-Optimized-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white" alt="K8s Optimization" />
          <img src="https://img.shields.io/badge/Build_Cache-Optimized-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Caching" />
        </div>
      </div>
      <div class="skill-card reveal">
        <div class="skill-card-title">Leadership & Methodology</div>
        <div class="badge-grid">
          <img src="https://img.shields.io/badge/Teams_of_40%2B-4CAF50?style=for-the-badge" alt="Teams of 40+" />
          <img src="https://img.shields.io/badge/Agile%2FScrum-0078D4?style=for-the-badge" alt="Agile/Scrum" />
          <img src="https://img.shields.io/badge/Mentoring-4CAF50?style=for-the-badge" alt="Mentoring" />
          <img src="https://img.shields.io/badge/Stakeholder_Mgmt-FF9800?style=for-the-badge" alt="Stakeholder Mgmt" />
          <img src="https://img.shields.io/badge/Roadmapping-2196F3?style=for-the-badge" alt="Roadmapping" />
        </div>
      </div>
    </div>
  </div>
</section>

<!-- NARRATIVE -->
<section class="narrative-section" aria-label="Career narrative">
  <div class="container">
    <div class="section-header reveal">
      <p class="section-tag">The Story</p>
      <h2 class="section-title">A Decade of Growth</h2>
    </div>
    <div class="narrative-block">
      <p class="reveal">
        The Byteridge journey began in 2014 as a fresh MCA graduate joining a product consultancy.
        The first project — <strong>Valley Proteins' Blue CRM</strong> — was a trial by fire: sole
        developer, three years, daily client calls, and total ownership from database design to IIS
        deployment. It is the best possible foundation a career can ask for.
      </p>
      <div class="pull-quote reveal">
        "Four years of owning every layer of a production system — by yourself — teaches you more
        than any architecture course ever could."
      </div>
      <p class="reveal">
        The years that followed brought increasing breadth. <strong>Aeries (Project Mitra)</strong>
        deepened full-cycle frontend ownership. <strong>Rhythmos' Unity Dockworks</strong> was an
        early introduction to developer tooling — building .NET APIs to generate documentation
        directly from source code analysis. Then came <strong>Singlefile (Techstars)</strong>:
        a contracted engagement building compliance filing workflows in a fast-moving, investor-backed
        environment where engineering standards were high and iteration was relentless.
      </p>
      <p class="reveal">
        The Microsoft engagement from 2020 to 2021 — contributing to <strong>Bing Search</strong>
        and the <strong>MS Admin Portal</strong> — was a defining test of quality. Working within
        Microsoft's engineering culture meant operating at a scale where even a small UI decision
        could affect millions of users. Building the "files result in work vertical" and the
        "Did You Mean?" suggestion service for Bing, alongside modernising location services in the
        Admin Portal, instilled a discipline around code quality and cross-functional collaboration
        that elevated every project that followed.
      </p>
      <p class="reveal">
        Back at the helm of full teams, <strong>DeviceThread</strong> in 2022 required leading 10+
        engineers to build an IoT management platform from zero — and the architectural decisions
        made there, introducing message queues for asynchronous device event handling and caching
        for real-time state queries, became a repeating pattern. <strong>TASC</strong> followed
        immediately: a crisis management platform delivered greenfield in five months with a lean team.
      </p>
      <p class="reveal">
        <strong>CCMR3</strong> represents the culmination. Coordinating 40+ developers, QA engineers,
        and leads through a full fintech platform modernisation in Phase 1 — then stepping up as
        Solution Architect to define the roadmap and deliver Phase 2 capabilities including bulk
        import of 100,000+ records and SFTP-driven automated data pipelines — is the full expression
        of a decade spent building, shipping, and growing.
      </p>
      <div class="pull-quote reveal">
        "From manually deploying via RDP on a physical IIS server to architecting Kubernetes-based
        microservices for 500+ daily users — the throughline has always been total ownership."
      </div>
      <p style="text-align: center; margin-top: 3rem;">
        <a href="{{ '/' | relative_url }}" class="hero-back" style="text-align: center; display: inline-block;">← Back to Portfolio</a>
      </p>
    </div>
  </div>
</section>
