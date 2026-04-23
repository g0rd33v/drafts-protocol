# Labs Drafts

**Version 0.2 · Overview**

---

## What it is

Labs Drafts is a personal staging pipe between AI chats and the public web. You talk to a Claude chat — it writes code, commits it, publishes it, verifies the result, and gives you a public URL. No dashboards, no terminal, no deploy scripts. Two weeks ago this didn't exist. Today it runs five parallel projects and has collaborators in it.

The system exists because the natural way of building with an LLM kept hitting the same friction. Files end up in chat history, then in scratch folders, then maybe in GitHub, then maybe on a server. Each handoff costs time and context. Drafts collapses all of that into a single pipe with versioning baked in.

It is not a CMS. It is not a static site host. It is not a competitor to GitHub or Vercel. It is the scratchpad nobody builds for themselves, designed for the way people actually work with AI chats in 2026.

---

## Who it is for

The owner of the server, first and foremost. Drafts is a personal tool. Its quality bar is "does it disappear out of the way while I think" rather than "does it scale to a million tenants."

Beyond the owner, it serves anyone the owner deliberately gives access to: a designer working on a landing page, a friend prototyping an idea, a teammate iterating on copy. Each of those people gets a scoped link that only works for one project. They can do everything inside their project and nothing outside it.

It is not for general public signups. There is no registration. There is no user database. Access is granted by the owner handing out a URL.

---

## How it works, one paragraph

The owner runs a small server with two pieces: a tiny HTTP service that accepts file uploads and a static web server that serves published files publicly. Every project is a folder with two subfolders — `drafts/` for work in progress and `live/` for the published version. The drafts folder is a git repository under the hood, so every save is versioned. When the owner says "ship it," the contents of `drafts/` are atomically copied into `live/`, and the file is immediately visible at `https://<your-domain>/live/<project>/`. Roll back any time with one phrase. That's the whole flow.

---

## Access model

There are two kinds of access keys, both delivered as URLs.

**MAP — Master Access Pass.** One per server. Belongs to the owner. Can create projects, mint project keys, delete anything. The owner pastes the MAP URL into any Claude chat, and that chat becomes a master operator for the entire drafts system.

**PAP — Project Access Pass.** Minted by the owner from the MAP. Scoped to exactly one project. The owner sends the PAP URL to a collaborator. The collaborator pastes it into their own Claude chat and gets read, write, version, and publish rights — but only inside that one project.

Both kinds of URL embed the auth token directly in the path. There is no login screen. There are no passwords to share. The URL is the credential. If a URL leaks, the owner revokes it from the master and mints a new one. This is deliberate: the system is designed to flow through chat conversations, where copy-pasting a URL is natural and copy-pasting a JSON config object is not.

When a chat opens a MAP or PAP URL, it sees a page designed for two readers at once. A human sees a clean overview with two big options at the top — install Claude for Chrome (work directly in the browser), or copy the URL and paste it into Claude.ai or Claude Desktop. Below that, a summary of the project's current state. On the MAP page, there is also a management UI: list of all projects, their active access keys, and buttons to create projects, mint new PAPs, revoke old ones, or wipe a project entirely. The same page contains a machine-readable instruction block that any LLM can parse — telling it the API endpoints, the auth header, the typical workflow, and the conversation tone the owner prefers.

---

## The folders

Every project has the same shape:

```
<project>/
├── drafts/   ← work in progress, every save commits to git
└── live/     ← published version, atomic copy from drafts
```

Both folders are publicly browsable on the web — `/drafts-view/<project>/` for previewing the working copy and `/live/<project>/` for the published version. Anything the owner uploads named exactly `index.html` renders as a website at the folder's URL. Anything else shows up as a file listing.

---

## How a session feels

The owner pastes a project URL into a fresh Claude chat. The chat opens the page, reads the instruction block, and immediately checks what is already in the project. If files exist, the chat opens with something like *"picking up where we left off — you've got an index.html and a style.css in drafts, last commit was an hour ago, what's next."* If the project is empty, the chat opens with *"clean slate, what are we building?"*

The owner then talks normally. *"Make me a landing page for a coffee subscription service, dark theme, single CTA."* The chat writes the file, commits it, promotes it to live, verifies the public URL returns 200 OK with the expected content, and replies with the link. Total time under a minute. No handoff between tools. No copy-paste of code into a hosting dashboard.

The conversational tone is set by the instruction block — friendly, builder-energy, low corporate-speak. The owner controls that tone by editing one section of the server code. Every chat that opens any URL inherits it.

---

## What works today

**Content it publishes.** Single-file HTML/CSS/JavaScript — landings, mockups, prototypes, internal tools, dashboards, demo sites. Media assets — images (PNG, JPG, SVG), audio (MP3), documents. Multi-file projects with relative linking. Anything that renders as static files in a web server handles directly. Most people's real-world projects — personal sites, marketing pages, client mockups, internal dashboards, small tools — fit cleanly into this today.

**Versioning.** Every save is a git commit. Every publish is tracked. Rolling back is one phrase: *"roll back to yesterday's version."*

**GitHub sync.** Optional. Link a project to a GitHub repo and the chat can push on demand. Projects without GitHub work identically, just with local version control.

**Collaborators.** Mint a PAP, send the URL, they work in parallel. Revoke any time, the URL stops working immediately.

**Management UI on MAP.** The master page includes a full control panel — create projects, see their access keys, mint new ones, revoke old ones, delete projects wholesale. One click each.

**Two entry points.** Claude for Chrome extension, which reads the page directly and lets you chat side-by-side. Or paste the URL into Claude.ai or Claude Desktop, where the chat opens the page through browser tools when needed. Works in any chat client that has browser access.

**Right now on the live server.** Five active projects: zvon (Mike), simacoin (Sima), efimoff (Roman), lashin (Daniil), wow (Nikita). Each with their own PAP. Each isolated from the others.

---

## What is coming next

These are the gaps between what Drafts does today and what the ambition is. All planned, none currently shipping.

**Runtime for user backend code.** Today Drafts serves whatever the chat uploads as static files. The receiver does not execute uploaded Node.js, Python, or other backend code — it only stores and serves. The next big capability is sandboxed per-project runtimes: the chat uploads a server.js, Drafts starts it in an isolated container, and user API endpoints become part of the live URL. This closes the gap between "my prototype is a single HTML file" and "my prototype is a full PWA with its own API."

**User databases and storage.** Per-project SQLite or Postgres, provisioned on project creation. Chat can migrate, seed, query. Attached persistent storage for user uploads and runtime state.

**One-command VPS setup.** Today installing Drafts on a new server involves running several commands by hand — nginx config, receiver install, certificate, systemd, cockpit, firewall. The next release will ship a single setup script that turns any fresh Ubuntu VPS into a full Drafts server in a few minutes.

**LLM routing inside projects.** Via OpenRouter — both for the chat writing the project's code, and for LLMs the project itself uses to serve its users. The goal is that user products running on Drafts can call the best available models without the user having to set up API keys, rate limits, or cost tracking. Owner pays the provider directly, Drafts charges nothing on top.

**Hosted drafts spaces.** For people without a server, a managed version of Drafts at some fraction of a dollar per month for simple usage, up to hundreds for heavy workloads. Owner picks a model, gets a URL, hands it to any Claude chat. Payments go to infrastructure providers, not to Drafts.

---

## Deployment

Designed to run on any single Linux server. A small VPS at a hosting provider, a containerised LXC instance, a Hetzner box, a DigitalOcean droplet — all fine. No external service dependencies, no managed databases, no third-party APIs required for the core.

The stack is intentionally boring: nginx for static files and HTTPS termination, a minimal Node.js receiver that handles the API and git operations, Let's Encrypt for certificate, and the standard Linux filesystem for storage. No container orchestration, no message queues, no Redis cluster. The whole thing fits on a 1-vCPU, 2GB-RAM machine and uses negligible disk because projects are usually small.

To stand up a fresh instance today, the owner provisions a server, points a domain at it, runs setup commands to install nginx, Node.js, and the receiver, drops in a generated master token, and configures TLS. From there the receiver runs under a process manager and the system is operational. Adding a new project takes one click in the management UI. Minting a new collaborator key takes one click. Both return ready-to-share URLs.

The data lives entirely on the owner's server. No cloud sync, no telemetry, no analytics. Backups are the owner's responsibility — a nightly snapshot of the projects directory and the state file is sufficient to restore the whole system.

---

## Versioning and rollback

Every project's `drafts/` folder is a git repository, but the owner never sees git. They see a chat that says *"saved version 14"* or *"rolled back to yesterday's version."* The git layer exists so that the system is provably reversible — any past state can be restored — without making the owner learn git or open a terminal.

When the owner promotes drafts to live, the previous live version is briefly preserved as `.live.old` during the swap, then discarded once the new live is in place. The swap is atomic at the filesystem level — visitors to the public URL never see a half-published state.

Promote is a one-way operation toward "this is live now." Rollback works on the drafts side — the owner can restore drafts to any past commit, then promote again. This separation keeps live stable while drafts can be freely experimented with.

---

## What it is not

**Not production hosting.** Drafts is for prototypes, landing pages, internal tools, demo sites, small projects the owner wants to share with a few people. If a project graduates into a real product with real users and uptime requirements, it should move to proper hosting with CDN, monitoring, and audited backups. Drafts is where ideas are born and tested, not where they grow up.

**Not multi-tenant.** One owner, one MAP, many collaborators within the owner's projects. If two people want their own Drafts systems, they each run their own server.

**Not a public publishing platform.** Published URLs work, but there is no built-in discovery, no search, no SEO optimization, no aggregated index of what's been published. Want to share a live page? Share the URL by hand.

**Not a website builder.** No drag-and-drop, no component palette, no template marketplace. The entire interface is a chat conversation. If the owner wants visual editing, they tell the chat what to change.

---

## The shape of the idea

Labs Drafts is a single pipe between a chat and the web, owned end-to-end by one person, with version history as a safety net and an access model designed for the way ideas actually move between collaborators today — over chat, with shared URLs, in short bursts. It treats the LLM as a first-class operator of the system rather than as a tool the owner has to translate for.

The bet underneath it is that the most useful tools of the next few years will be the ones that assume an LLM is in the loop and design every interface accordingly. Not LLM features bolted onto existing tools, but tools where the LLM is the primary user and the human supervises through conversation. Drafts is one experiment in that direction.

---

*Labs Drafts · v0.2 · Overview*
