// drafts-manage.js — MAP-only management UI: list projects, add project, mint PAP, revoke PAP, delete project.
(function () {
  var MOUNT_ID = 'manage-ui';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function getToken() {
    var parts = location.pathname.split('/');
    return parts[parts.length - 1] || '';
  }

  function apiBase() {
    return location.origin + '/drafts';
  }

  function req(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Authorization': 'Bearer ' + getToken() }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(apiBase() + path, opts).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) el[k] = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (children) (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return iso; }
  }

  function toast(msg, kind) {
    var t = h('div', { class: 'toast toast-' + (kind || 'ok') }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 3000);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () {
      toast('Copied to clipboard', 'ok');
    });
    else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (e) {}
      ta.remove();
    }
  }

  function confirmAction(msg) { return window.confirm(msg); }

  function renderKey(projectName, key, onChange) {
    var revoked = key.revoked;
    var row = h('div', { class: 'key-row' + (revoked ? ' revoked' : '') });
    var label = h('div', { class: 'key-label' }, [
      h('div', { class: 'key-name' }, key.name || '(unnamed)'),
      h('div', { class: 'key-meta' }, fmtDate(key.created_at) + ' · ' + key.preview)
    ]);
    var actions = h('div', { class: 'key-actions' });
    if (!revoked) {
      var copyBtn = h('button', {
        class: 'btn-mini',
        title: 'Copy activation URL',
        onclick: function () { copyToClipboard(key.activation_url); }
      }, 'Copy URL');
      var openBtn = h('a', { class: 'btn-mini', href: key.activation_url, target: '_blank' }, 'Open');
      var revokeBtn = h('button', {
        class: 'btn-mini btn-danger',
        onclick: function () {
          if (!confirmAction('Revoke PAP "' + (key.name || key.id) + '" for ' + projectName + '? The activation URL will stop working immediately.')) return;
          req('DELETE', '/projects/' + encodeURIComponent(projectName) + '/keys/' + key.id).then(function (res) {
            if (res.status === 200 && res.body.ok) { toast('Revoked'); onChange(); }
            else toast('Revoke failed: ' + (res.body.error || res.status), 'err');
          });
        }
      }, 'Revoke');
      actions.appendChild(copyBtn);
      actions.appendChild(openBtn);
      actions.appendChild(revokeBtn);
    } else {
      actions.appendChild(h('span', { class: 'muted' }, 'revoked'));
    }
    row.appendChild(label);
    row.appendChild(actions);
    return row;
  }

  function renderProject(project, keys, onChange) {
    var card = h('div', { class: 'proj-card' });
    var header = h('div', { class: 'proj-header' }, [
      h('div', { class: 'proj-meta' }, [
        h('div', { class: 'proj-name' }, project.name),
        h('div', { class: 'proj-desc' }, project.description || '')
      ]),
      h('div', { class: 'proj-header-actions' }, [
        h('a', { class: 'btn-mini', href: '/live/' + project.name + '/', target: '_blank' }, 'Live ↗'),
        h('a', { class: 'btn-mini', href: '/drafts-view/' + project.name + '/', target: '_blank' }, 'Drafts ↗'),
        h('button', {
          class: 'btn-mini btn-danger',
          onclick: function () {
            var conf = prompt('DELETE project "' + project.name + '" and ALL its drafts, live files, git history, and PAPs? This cannot be undone.\n\nType the project name to confirm:');
            if (conf !== project.name) { toast('Cancelled (name did not match)', 'err'); return; }
            req('DELETE', '/projects/' + encodeURIComponent(project.name)).then(function (res) {
              if (res.status === 200 && res.body.ok) { toast('Project deleted'); onChange(); }
              else toast('Delete failed: ' + (res.body.error || res.status), 'err');
            });
          }
        }, 'Delete project')
      ])
    ]);
    card.appendChild(header);

    var keysWrap = h('div', { class: 'keys-wrap' });
    if (keys.length === 0) {
      keysWrap.appendChild(h('div', { class: 'empty' }, 'No PAPs yet'));
    } else {
      keys.forEach(function (k) { keysWrap.appendChild(renderKey(project.name, k, onChange)); });
    }
    card.appendChild(keysWrap);

    var addPap = h('button', {
      class: 'btn-add-pap',
      onclick: function () {
        var name = prompt('Name for the new PAP (optional, e.g. "Alice", "designer-laptop"):', '');
        if (name === null) return;
        req('POST', '/projects/' + encodeURIComponent(project.name) + '/keys', { name: name || undefined }).then(function (res) {
          if (res.status === 200 && res.body.ok) {
            var url = res.body.activation_url || (res.body.key && res.body.key.activation_url);
            if (url) copyToClipboard(url);
            toast('PAP minted + copied to clipboard');
            onChange();
          } else toast('Mint failed: ' + (res.body.error || res.status), 'err');
        });
      }
    }, '+ Add PAP');
    card.appendChild(addPap);

    return card;
  }

  function renderAll(mount, data) {
    mount.innerHTML = '';

    var toolbar = h('div', { class: 'manage-toolbar' }, [
      h('div', { class: 'manage-title' }, 'Projects · ' + data.projects.length),
      h('button', {
        class: 'btn-primary',
        onclick: function () {
          var name = prompt('New project name (lowercase letters, numbers, dashes):');
          if (!name) return;
          var desc = prompt('Description (optional):') || '';
          req('POST', '/projects', { name: name, description: desc || undefined }).then(function (res) {
            if (res.status === 200 && res.body.ok) { toast('Project created'); reload(mount); }
            else toast('Create failed: ' + (res.body.error || res.status), 'err');
          });
        }
      }, '+ New project')
    ]);
    mount.appendChild(toolbar);

    if (data.projects.length === 0) {
      mount.appendChild(h('div', { class: 'empty-big' }, 'No projects yet. Create the first one.'));
      return;
    }

    data.projects.forEach(function (p) {
      var keys = data.keys[p.name] || [];
      mount.appendChild(renderProject(p, keys, function () { reload(mount); }));
    });
  }

  function reload(mount) {
    mount.innerHTML = '<div class="loading">Loading…</div>';
    req('GET', '/projects').then(function (res) {
      if (res.status !== 200 || !res.body.ok) {
        mount.innerHTML = '<div class="err">Failed to load projects: ' + (res.body.error || res.status) + '</div>';
        return;
      }
      var projects = res.body.projects || [];
      // Parallel fetch of keys per project
      Promise.all(projects.map(function (p) {
        return req('GET', '/projects/' + encodeURIComponent(p.name) + '/keys').then(function (kr) {
          return [p.name, (kr.body && kr.body.keys) || []];
        });
      })).then(function (pairs) {
        var keysMap = {};
        pairs.forEach(function (pr) { keysMap[pr[0]] = pr[1]; });
        renderAll(mount, { projects: projects, keys: keysMap });
      });
    });
  }

  ready(function () {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    reload(mount);
  });
})();
